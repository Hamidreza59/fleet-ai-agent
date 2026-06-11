/** Deterministic, offline LLM used by tests and `LLM_PROVIDER=mock`.
 *
 * It is not intelligent: it follows a tiny scripted policy so the full agent
 * loop (tool calls → tool results → final answer) can be exercised end-to-end
 * with no network, no credentials, and no cost.
 */

import type { ChatMessage, LlmProvider, LlmResponse, ToolSpec } from "../types.js";

export class MockLlmProvider implements LlmProvider {
  readonly name = "mock";

  async converse(_system: string, messages: ChatMessage[], tools: ToolSpec[]): Promise<LlmResponse> {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const userText = lastUser && "text" in lastUser ? lastUser.text.toLowerCase() : "";
    const alreadyCalled = messages.some((m) => m.role === "tool");

    // First turn: if the question is about a fleet and we have the tool, call it.
    if (!alreadyCalled && userText.includes("fleet") && hasTool(tools, "get_fleet_summary")) {
      return {
        toolCalls: [
          {
            id: "call-1",
            name: "get_fleet_summary",
            input: { fleet_id: "FLEET-ATLAS", timeframe: "24h" },
          },
        ],
      };
    }

    // After a tool result (or when no tool applies), produce a final answer.
    const toolResult = [...messages].reverse().find((m) => m.role === "tool");
    if (toolResult && "result" in toolResult) {
      return { text: `Here is what I found: ${toolResult.result}`, toolCalls: [] };
    }
    return { text: "I don't have enough information to answer that.", toolCalls: [] };
  }
}

function hasTool(tools: ToolSpec[], name: string): boolean {
  return tools.some((t) => t.name === name);
}
