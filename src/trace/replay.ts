/** Deterministic replay of recorded trajectories against the current agent code. */

import { FleetAgent, type AgentResult } from "../agent.js";
import { ApprovalQueue } from "../guardrails/approvals.js";
import type { ToolGuard, WritePolicy } from "../guardrails/guards.js";
import { ChatMemory } from "../memory/chatMemory.js";
import type { ChatMessage, LlmProvider, LlmResponse, ToolBox, ToolSpec } from "../types.js";
import type { LlmStep, ToolStep, Trajectory } from "./trajectory.js";

export function stableStringify(v: unknown): string {
  return JSON.stringify(sortKeys(v));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, val]) => [k, sortKeys(val)]),
    );
  }
  return v;
}

export class RecordedToolBox implements ToolBox {
  readonly misses: string[] = [];
  readonly reused: string[] = [];
  private used = new Set<ToolStep>();
  private recorded: ToolStep[];

  constructor(
    private traj: Trajectory,
    private reuse = false,
  ) {
    this.recorded = traj.steps.filter(
      (s): s is ToolStep => s.type === "tool" && (s.status === "ok" || s.status === "error"),
    );
  }

  specs(): ToolSpec[] {
    return this.traj.tools;
  }

  unused(): string[] {
    return this.recorded.filter((s) => !this.used.has(s)).map((s) => `${s.name}(${stableStringify(s.input)})`);
  }

  async execute(name: string, input: Record<string, unknown>): Promise<string> {
    const key = stableStringify(input);
    const matches = (s: ToolStep) => s.name === name && stableStringify(s.input) === key;
    let hit = this.recorded.find((s) => !this.used.has(s) && matches(s));
    if (!hit && this.reuse) {
      hit = this.recorded.find(matches);
      if (hit) this.reused.push(`${name}(${key})`);
    }
    if (!hit) {
      const desc = `${name}(${key})`;
      this.misses.push(desc);
      return `REPLAY_MISS: no recorded output for ${desc}`;
    }
    this.used.add(hit);
    if (hit.status === "error") {
      throw new Error(hit.output.replace(`ERROR calling ${name}: `, ""));
    }
    return hit.output;
  }
}

export class RecordedLlmProvider implements LlmProvider {
  readonly name: string;
  readonly model: string;
  private queue: LlmStep[];

  constructor(traj: Trajectory) {
    this.name = traj.provider;
    this.model = traj.model;
    this.queue = traj.steps.filter((s): s is LlmStep => s.type === "llm");
  }

  async converse(_system: string, _messages: ChatMessage[], _tools: ToolSpec[]): Promise<LlmResponse> {
    const step = this.queue.shift();
    if (!step) throw new Error("replay: recorded LLM responses exhausted");
    return { text: step.text, toolCalls: step.toolCalls, usage: step.usage };
  }
}

export interface ReplayDiff {
  toolSequenceChanged: boolean;
  originalTools: string[];
  replayedTools: string[];
  answerChanged: boolean;
  stopReasonChanged: boolean;
  changedSteps: string[];
  unusedRecorded: string[];
  reused: string[];
  misses: string[];
}

export interface ReplayOptions {
  llm?: LlmProvider;
  guards?: ToolGuard[];
  maxIterations?: number;
}

export interface ReplayOutcome {
  original: Trajectory;
  replayed: Trajectory;
  result: AgentResult;
  diff: ReplayDiff;
}

const stepKeys = (t: Trajectory) =>
  t.steps.flatMap((s) => (s.type === "tool" ? [`${s.name}(${stableStringify(s.input)}) [${s.status}]`] : []));

function changedSteps(a: string[], b: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) out.push(`#${i + 1}: ${a[i] ?? "(none)"} -> ${b[i] ?? "(none)"}`);
  }
  return out;
}

const toolNames = (t: Trajectory) =>
  t.steps.flatMap((s) => (s.type === "llm" ? s.toolCalls.map((c) => c.name) : []));

function recordedMaxIterations(traj: Trajectory): number {
  const n = Number(traj.metadata.maxIterations);
  return Number.isInteger(n) && n > 0 ? n : Math.max(1, traj.steps.filter((s) => s.type === "llm").length);
}

export async function replayTrajectory(
  traj: Trajectory,
  opts: ReplayOptions = {},
): Promise<ReplayOutcome> {
  const tools = new RecordedToolBox(traj, opts.llm !== undefined);
  const memory = new ChatMemory(Number.MAX_SAFE_INTEGER);
  memory.append(traj.managerId, traj.history);
  const agent = new FleetAgent(opts.llm ?? new RecordedLlmProvider(traj), tools, memory, {
    maxIterations: opts.maxIterations ?? recordedMaxIterations(traj),
    guards: opts.guards,
    writePolicy: (traj.metadata.writePolicy as WritePolicy | undefined) ?? "approval",
    approvals: new ApprovalQueue(),
    metadata: { ...traj.metadata, replayOf: traj.runId },
  });
  const result = await agent.inquire(traj.managerId, traj.question);
  const replayed = result.trajectory;
  const originalTools = toolNames(traj);
  const replayedTools = toolNames(replayed);
  return {
    original: traj,
    replayed,
    result,
    diff: {
      toolSequenceChanged: originalTools.join("|") !== replayedTools.join("|"),
      originalTools,
      replayedTools,
      answerChanged: traj.answer !== replayed.answer,
      stopReasonChanged: traj.stopReason !== replayed.stopReason,
      changedSteps: changedSteps(stepKeys(traj), stepKeys(replayed)),
      unusedRecorded: tools.unused(),
      reused: tools.reused,
      misses: tools.misses,
    },
  };
}
