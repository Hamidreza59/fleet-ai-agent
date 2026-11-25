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

import { createHash, randomUUID } from "node:crypto";
import { ApprovalQueue } from "./guardrails/approvals.js";
import { budgetExceeded, estimateCostUsd, type RunBudget } from "./guardrails/budget.js";
import {
  defaultGuards,
  isUsableObservation,
  type GuardContext,
  type GuardDecision,
  type ToolGuard,
  type WritePolicy,
} from "./guardrails/guards.js";
import type { ChatMemory } from "./memory/chatMemory.js";
import {
  NullTrajectorySink,
  type LlmStep,
  type StopReason,
  type ToolStep,
  type Trajectory,
  type TrajectorySink,
} from "./trace/trajectory.js";
import type { ChatMessage, LlmProvider, ToolBox, ToolCall, Usage } from "./types.js";

export const SYSTEM_PROMPT = `You are an AI Fleet Manager responsible for monitoring, diagnosing, and managing the health and efficiency of a vehicle fleet.

Your responsibilities:
- Inspect vehicle telematics (location, diagnostics, fuel/charge, battery) using the available tools.
- Interpret DTC (OBD-II) codes, explain what they mean, and recommend next service actions.
- Flag vehicles below safe fuel/charge thresholds and degraded battery health.
- When you need to explain a DTC or cite a maintenance threshold, call search_maintenance_knowledge first — do not guess.
- Only call schedule_maintenance_appointment when the user explicitly asks you to book or schedule service. Otherwise recommend the service in your answer and let the user decide.

Your behavior:
- Always call tools to get real data; never invent VINs, codes, or readings.
- Be concise and structured: use lists and clear priorities.
- Give actionable recommendations, not just raw data.
- If a tool returns an error, say so plainly and suggest what the user should check.`;

export const SYSTEM_PROMPT_SHA256 = createHash("sha256").update(SYSTEM_PROMPT).digest("hex");

export const BUDGET_EXCEEDED_ANSWER = "Stopped: this request exceeded its token/cost budget.";
const MAX_ITERATIONS_ANSWER =
  "I reached the tool-call limit before finishing. Please narrow the question and try again.";

export interface AgentOptions {
  maxIterations?: number;
  guards?: ToolGuard[];
  writePolicy?: WritePolicy;
  budget?: RunBudget;
  approvals?: ApprovalQueue;
  sink?: TrajectorySink;
  metadata?: Record<string, string>;
}

export interface AgentResult {
  runId: string;
  answer: string;
  toolCalls: { name: string; input: Record<string, unknown> }[];
  iterations: number;
  stopReason: StopReason;
  usage: Usage;
  costUsd: number;
  pendingApprovals: string[];
  trajectory: Trajectory;
}

export class FleetAgent {
  readonly approvals: ApprovalQueue;
  private maxIterations: number;
  private guards: ToolGuard[];
  private budget: RunBudget;
  private sink: TrajectorySink;
  private metadata: Record<string, string>;
  private writePolicy?: WritePolicy;

  constructor(
    private llm: LlmProvider,
    private tools: ToolBox,
    private memory: ChatMemory,
    opts: AgentOptions = {},
  ) {
    this.maxIterations = opts.maxIterations ?? 6;
    this.writePolicy = opts.writePolicy ?? (opts.guards ? undefined : "approval");
    this.guards = opts.guards ?? defaultGuards(this.writePolicy);
    this.budget = opts.budget ?? {};
    this.approvals = opts.approvals ?? new ApprovalQueue();
    this.sink = opts.sink ?? new NullTrajectorySink();
    this.metadata = opts.metadata ?? {};
  }

  async inquire(
    managerId: string,
    question: string,
    runMetadata: Record<string, string> = {},
  ): Promise<AgentResult> {
    const runId = randomUUID();
    const startedAt = new Date();
    const t0 = performance.now();
    const toolSpecs = this.tools.specs();
    const history = [...this.memory.history(managerId)];
    const turn: ChatMessage[] = [{ role: "user", text: question }];
    const executed: AgentResult["toolCalls"] = [];
    const steps: Trajectory["steps"] = [];
    const pendingApprovals: string[] = [];
    const observations = history.flatMap((m) =>
      m.role === "tool" && isUsableObservation(m.result) ? [m.result] : [],
    );
    const userTexts = history.flatMap((m) => (m.role === "user" ? [m.text] : []));
    const usage: Usage = { inputTokens: 0, outputTokens: 0 };
    let costUsd = 0;
    let answer = MAX_ITERATIONS_ANSWER;
    let stopReason: StopReason = "max_iterations";

    let iterations = 0;
    while (iterations < this.maxIterations) {
      iterations++;
      const llmStart = performance.now();
      const response = await this.llm.converse(SYSTEM_PROMPT, [...history, ...turn], toolSpecs);
      const llmStep: LlmStep = {
        type: "llm",
        iteration: iterations,
        latencyMs: performance.now() - llmStart,
        usage: response.usage,
        text: response.text,
        toolCalls: response.toolCalls,
      };
      steps.push(llmStep);
      if (response.usage) {
        usage.inputTokens += response.usage.inputTokens;
        usage.outputTokens += response.usage.outputTokens;
        costUsd = estimateCostUsd(this.llm.model, usage);
      }

      if (response.toolCalls.length === 0) {
        turn.push({ role: "assistant", text: response.text });
        answer = response.text ?? "";
        stopReason = "final_answer";
        break;
      }

      if (budgetExceeded(this.budget, usage, costUsd)) {
        for (const call of response.toolCalls) executed.push({ name: call.name, input: call.input });
        turn.push({ role: "assistant", text: BUDGET_EXCEEDED_ANSWER });
        answer = BUDGET_EXCEEDED_ANSWER;
        stopReason = "budget_exceeded";
        break;
      }

      turn.push({ role: "assistant", text: response.text, toolCalls: response.toolCalls });

      for (const call of response.toolCalls) {
        executed.push({ name: call.name, input: call.input });
        const step = await this.runTool(call, iterations, {
          runId,
          managerId,
          question,
          observations,
          userTexts,
        });
        steps.push(step);
        if (step.approvalId) pendingApprovals.push(step.approvalId);
        if (step.status === "ok" && isUsableObservation(step.output)) observations.push(step.output);
        turn.push({ role: "tool", toolCallId: call.id, toolName: call.name, result: step.output });
      }
    }

    this.memory.append(managerId, turn);
    const finishedAt = new Date();
    const trajectory: Trajectory = {
      schemaVersion: 1,
      runId,
      managerId,
      question,
      history,
      provider: this.llm.name,
      model: this.llm.model,
      systemPromptSha256: SYSTEM_PROMPT_SHA256,
      tools: toolSpecs,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      latencyMs: performance.now() - t0,
      steps,
      answer,
      stopReason,
      usage,
      costUsd,
      pendingApprovals,
      metadata: {
        ...this.metadata,
        ...runMetadata,
        ...(this.writePolicy ? { writePolicy: this.writePolicy } : {}),
        maxIterations: String(this.maxIterations),
      },
    };
    try {
      await this.sink.write(trajectory);
    } catch (err) {
      console.error("[trajectory] write failed:", (err as Error).message);
    }

    return { runId, answer, toolCalls: executed, iterations, stopReason, usage, costUsd, pendingApprovals, trajectory };
  }

  private async runTool(
    call: ToolCall,
    iteration: number,
    base: Omit<GuardContext, "spec">,
  ): Promise<ToolStep> {
    const start = performance.now();
    const step = (s: Pick<ToolStep, "output" | "status" | "guardrail" | "approvalId">): ToolStep => ({
      type: "tool",
      iteration,
      callId: call.id,
      name: call.name,
      input: call.input,
      latencyMs: performance.now() - start,
      ...s,
    });

    const spec = this.tools.specs().find((t) => t.name === call.name);
    for (const guard of this.guards) {
      const decision: GuardDecision = guard.check(call, { ...base, spec });
      if (decision.action === "deny") {
        return step({
          output: `BLOCKED by guardrail ${guard.name}: ${decision.reason}. The tool was not executed.`,
          status: "blocked",
          guardrail: guard.name,
        });
      }
      if (decision.action === "require_approval") {
        const pending = this.approvals.create({ runId: base.runId, managerId: base.managerId, call });
        return step({
          output: `PENDING_APPROVAL: ${call.name} requires human approval (approval id ${pending.id}). It has NOT been executed. Tell the user it is awaiting approval. Still answer the rest of the user's question.`,
          status: "pending_approval",
          guardrail: guard.name,
          approvalId: pending.id,
        });
      }
    }

    try {
      return step({ output: await this.tools.execute(call.name, call.input), status: "ok" });
    } catch (err) {
      return step({ output: `ERROR calling ${call.name}: ${(err as Error).message}`, status: "error" });
    }
  }
}
