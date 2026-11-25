/** Structured, replayable record of one agent run, plus JSONL persistence. */

import { appendFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ChatMessage, ToolCall, ToolSpec, Usage } from "../types.js";

export interface LlmStep {
  type: "llm";
  iteration: number;
  latencyMs: number;
  usage?: Usage;
  text?: string;
  toolCalls: ToolCall[];
}

export interface ToolStep {
  type: "tool";
  iteration: number;
  callId: string;
  name: string;
  input: Record<string, unknown>;
  output: string;
  latencyMs: number;
  status: "ok" | "error" | "blocked" | "pending_approval";
  guardrail?: string;
  approvalId?: string;
}

export type StopReason = "final_answer" | "max_iterations" | "budget_exceeded";

export interface Trajectory {
  schemaVersion: 1;
  runId: string;
  managerId: string;
  question: string;
  history: ChatMessage[];
  provider: string;
  model: string;
  systemPromptSha256: string;
  tools: ToolSpec[];
  startedAt: string;
  finishedAt: string;
  latencyMs: number;
  steps: (LlmStep | ToolStep)[];
  answer: string;
  stopReason: StopReason;
  usage: Usage;
  costUsd: number;
  pendingApprovals: string[];
  metadata: Record<string, string>;
}

export interface TrajectorySink {
  write(t: Trajectory): Promise<void>;
}

export class NullTrajectorySink implements TrajectorySink {
  async write(): Promise<void> {}
}

export class JsonlTrajectorySink implements TrajectorySink {
  constructor(private filePath: string) {}

  async write(t: Trajectory): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, JSON.stringify(t) + "\n", "utf8");
  }
}

export function readTrajectories(filePath: string): Trajectory[] {
  const out: Trajectory[] = [];
  readFileSync(filePath, "utf8")
    .split("\n")
    .forEach((line, i) => {
      if (!line.trim()) return;
      try {
        out.push(JSON.parse(line) as Trajectory);
      } catch {
        throw new Error(`${filePath}: invalid JSON on line ${i + 1}`);
      }
    });
  return out;
}
