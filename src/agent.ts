/** The agent loop: system prompt + tool-use orchestration + memory.
 *
 * This is the classic "agentic" loop:
 *   1. Send the system prompt, conversation history, and the new question.
 *   2. If the model asks to call tools, execute them and feed the results back.
 *   3. Repeat until the model returns a final text answer (or we hit a cap).
 *
 * The agent depends only on the `LlmProvider` and `ToolBox` interfaces, so the
 * exact model (Bedrock/Groq/mock) and tool source (MCP/local) are swappable.
 */

import type { ChatMemory } from "./memory/chatMemory.js";
import type { ChatMessage, LlmProvider, ToolBox, ToolCall } from "./types.js";

export const SYSTEM_PROMPT = `You are an AI Fleet Manager responsible for monitoring, diagnosing, and managing the health and efficiency of a vehicle fleet.

Your responsibilities:
- Inspect vehicle telematics (location, diagnostics, fuel/charge, battery) using the available tools.
- Interpret DTC (OBD-II) codes, explain what they mean, and recommend next service actions.
- Flag vehicles below safe fuel/charge thresholds and degraded battery health.
- When you need to explain a DTC or cite a maintenance threshold, call search_maintenance_knowledge first — do not guess.
- When a vehicle needs service, call schedule_maintenance_appointment.

Your behavior:
- Always call tools to get real data; never invent VINs, codes, or readings.
- Be concise and structured: use lists and clear priorities.
- Give actionable recommendations, not just raw data.
- If a tool returns an error, say so plainly and suggest what the user should check.`;

export interface AgentResult {
  answer: string;
  toolCalls: { name: string; input: Record<string, unknown> }[];
  iterations: number;
}

export class FleetAgent {
  constructor(
    private llm: LlmProvider,
    private tools: ToolBox,
    private memory: ChatMemory,
    private maxIterations = 6,
  ) {}

  async inquire(managerId: string, question: string): Promise<AgentResult> {
    const toolSpecs = this.tools.specs();
    const history = this.memory.history(managerId);
    const turn: ChatMessage[] = [{ role: "user", text: question }];
    const executed: AgentResult["toolCalls"] = [];

    let iterations = 0;
    while (iterations < this.maxIterations) {
      iterations++;
      const response = await this.llm.converse(SYSTEM_PROMPT, [...history, ...turn], toolSpecs);

      // Record the assistant turn (text and/or tool calls).
      turn.push({
        role: "assistant",
        text: response.text,
        toolCalls: response.toolCalls.length ? response.toolCalls : undefined,
      });

      if (response.toolCalls.length === 0) {
        // Final answer — persist the exchange and return.
        this.memory.append(managerId, turn);
        return { answer: response.text ?? "", toolCalls: executed, iterations };
      }

      // Execute every requested tool call and append results.
      for (const call of response.toolCalls) {
        executed.push({ name: call.name, input: call.input });
        const result = await this.runTool(call);
        turn.push({
          role: "tool",
          toolCallId: call.id,
          toolName: call.name,
          result,
        });
      }
    }

    this.memory.append(managerId, turn);
    return {
      answer:
        "I reached the tool-call limit before finishing. Please narrow the question and try again.",
      toolCalls: executed,
      iterations,
    };
  }

  private async runTool(call: ToolCall): Promise<string> {
    try {
      return await this.tools.execute(call.name, call.input);
    } catch (err) {
      return `ERROR calling ${call.name}: ${(err as Error).message}`;
    }
  }
}
