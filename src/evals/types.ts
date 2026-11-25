/** Eval case and report shapes. */

import type { WritePolicy } from "../guardrails/guards.js";
import type { StopReason } from "../trace/trajectory.js";

export interface EvalCase {
  id: string;
  tags: string[];
  question: string;
  history?: string[];
  writePolicy?: WritePolicy;
  expect: {
    toolsCalled?: string[];
    anyToolCalled?: string[];
    toolsNotCalled?: string[];
    toolArgs?: { tool: string; args: Record<string, unknown> }[];
    answerIncludes?: string[];
    answerExcludes?: string[];
    answerOrder?: string[];
    maxIterations?: number;
    stopReason?: StopReason;
    sideEffects?: "none" | "executed" | "pending_approval";
  };
  rubric?: string;
}

export interface ScoreResult {
  scorer: string;
  pass: boolean;
  detail: string;
}

export interface TrialReport {
  trial: number;
  pass: boolean;
  scores: ScoreResult[];
  iterations: number;
  tokens: number;
  costUsd: number;
  latencyMs: number;
  stopReason: string;
  toolCalls: string[];
  answer: string;
  runId: string;
}

export interface CaseReport {
  id: string;
  tags: string[];
  pass: boolean;
  passRate: number;
  failedScorers: string[];
  trials: TrialReport[];
}

export interface EvalReport {
  startedAt: string;
  provider: string;
  model: string;
  trials: number;
  summary: {
    cases: number;
    passed: number;
    passRate: number;
    scorerPassRates: Record<string, number>;
    tokens: number;
    costUsd: number;
    latencyMsP50: number;
    latencyMsP95: number;
  };
  cases: CaseReport[];
}
