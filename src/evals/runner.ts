/** Runs eval cases against an agent (live) or replays recorded trajectories (offline). */

import type { AgentResult, FleetAgent } from "../agent.js";
import type { WritePolicy } from "../guardrails/guards.js";
import { replayTrajectory } from "../trace/replay.js";
import type { Trajectory } from "../trace/trajectory.js";
import type { LlmProvider } from "../types.js";
import { judgeAnswer } from "./judge.js";
import { scoreCase, type EvalRun } from "./scorers.js";
import type { CaseReport, EvalCase, EvalReport, ScoreResult, TrialReport } from "./types.js";

export interface TrajectoryInfo {
  caseId: string;
  trial: number;
  pass: boolean;
}

export interface RunEvalsOptions {
  cases: EvalCase[];
  makeAgent: (writePolicy: WritePolicy) => FleetAgent;
  trials: number;
  judge?: LlmProvider;
  onTrajectory?: (t: Trajectory, info: TrajectoryInfo) => void;
  onCase?: (c: CaseReport) => void;
}

async function scoreRun(c: EvalCase, run: EvalRun, judge?: LlmProvider): Promise<ScoreResult[]> {
  const scores = scoreCase(c, run);
  if (judge && c.rubric) {
    try {
      const j = await judgeAnswer(judge, c, run);
      scores.push({ scorer: "llm_judge", pass: j.pass, detail: `${j.score}/5: ${j.reason}` });
    } catch (err) {
      scores.push({ scorer: "llm_judge", pass: false, detail: `judge error: ${(err as Error).message}` });
    }
  }
  return scores;
}

function trialReport(trial: number, scores: ScoreResult[], r: AgentResult): TrialReport {
  return {
    trial,
    pass: scores.every((s) => s.pass),
    scores,
    iterations: r.iterations,
    tokens: r.usage.inputTokens + r.usage.outputTokens,
    costUsd: r.costUsd,
    latencyMs: r.trajectory.latencyMs,
    stopReason: r.stopReason,
    toolCalls: r.toolCalls.map((t) => t.name),
    answer: r.answer,
    runId: r.runId,
  };
}

function caseReport(c: EvalCase, trials: TrialReport[]): CaseReport {
  const passed = trials.filter((t) => t.pass).length;
  const failed = new Set(trials.flatMap((t) => t.scores.filter((s) => !s.pass).map((s) => s.scorer)));
  return {
    id: c.id,
    tags: c.tags,
    pass: trials.length > 0 && passed === trials.length,
    passRate: trials.length ? passed / trials.length : 0,
    failedScorers: [...failed],
    trials,
  };
}

const percentile = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

export function buildReport(
  meta: { provider: string; model: string; trials: number },
  cases: CaseReport[],
): EvalReport {
  const all = cases.flatMap((c) => c.trials);
  const names = new Set(all.flatMap((t) => t.scores.map((s) => s.scorer)));
  const scorerPassRates: Record<string, number> = {};
  for (const n of names) {
    const rel = all.flatMap((t) => t.scores.filter((s) => s.scorer === n));
    scorerPassRates[n] = rel.filter((s) => s.pass).length / rel.length;
  }
  const passed = cases.filter((c) => c.pass).length;
  const lat = all.map((t) => t.latencyMs);
  return {
    startedAt: new Date().toISOString(),
    ...meta,
    summary: {
      cases: cases.length,
      passed,
      passRate: cases.length ? passed / cases.length : 0,
      scorerPassRates,
      tokens: all.reduce((a, t) => a + t.tokens, 0),
      costUsd: all.reduce((a, t) => a + t.costUsd, 0),
      latencyMsP50: percentile(lat, 50),
      latencyMsP95: percentile(lat, 95),
    },
    cases,
  };
}

export async function runEvals(opts: RunEvalsOptions): Promise<EvalReport> {
  const reports: CaseReport[] = [];
  let provider = "unknown";
  let model = "unknown";
  for (const c of opts.cases) {
    const trials: TrialReport[] = [];
    for (let trial = 1; trial <= opts.trials; trial++) {
      const policy = c.writePolicy ?? "approval";
      const agent = opts.makeAgent(policy);
      const manager = `eval-${c.id}-${trial}`;
      try {
        for (const turn of c.history ?? []) await agent.inquire(manager, turn);
        const r = await agent.inquire(manager, c.question, {
          caseId: c.id,
          trial: String(trial),
          writePolicy: policy,
        });
        provider = r.trajectory.provider;
        model = r.trajectory.model;
        const t = trialReport(trial, await scoreRun(c, r, opts.judge), r);
        trials.push(t);
        opts.onTrajectory?.(r.trajectory, { caseId: c.id, trial, pass: t.pass });
      } catch (err) {
        trials.push(errorTrial(trial, err));
      }
    }
    const cr = caseReport(c, trials);
    reports.push(cr);
    opts.onCase?.(cr);
  }
  return buildReport({ provider, model, trials: opts.trials }, reports);
}

function errorTrial(trial: number, err: unknown): TrialReport {
  return {
    trial,
    pass: false,
    scores: [{ scorer: "run_error", pass: false, detail: (err as Error).message }],
    iterations: 0,
    tokens: 0,
    costUsd: 0,
    latencyMs: 0,
    stopReason: "error",
    toolCalls: [],
    answer: "",
    runId: "",
  };
}

export async function runReplayEvals(cases: EvalCase[], trajectories: Trajectory[]): Promise<EvalReport> {
  const byId = new Map(cases.map((c) => [c.id, c]));
  const grouped = new Map<string, TrialReport[]>();
  let provider = "replay";
  let model = "recorded";
  for (const t of trajectories) {
    const id = t.metadata.caseId;
    const c = id ? byId.get(id) : undefined;
    if (!c) continue;
    const trialNo = Number(t.metadata.trial ?? 1);
    let trial: TrialReport;
    try {
      const { result, diff } = await replayTrajectory(t);
      const scores = await scoreRun(c, result);
      scores.push({
        scorer: "replay_clean",
        pass: diff.misses.length === 0 && diff.changedSteps.length === 0 && diff.unusedRecorded.length === 0,
        detail: `misses: ${diff.misses.join("; ")}; changed: ${diff.changedSteps.join("; ")}; unused: ${diff.unusedRecorded.join("; ")}`,
      });
      trial = trialReport(trialNo, scores, result);
    } catch (err) {
      trial = errorTrial(trialNo, err);
    }
    provider = `replay:${t.provider}`;
    model = t.model;
    grouped.set(c.id, [...(grouped.get(c.id) ?? []), trial]);
  }
  const reports = [...grouped.entries()].map(([id, trials]) => caseReport(byId.get(id)!, trials));
  return buildReport({ provider, model, trials: Math.max(1, ...reports.map((r) => r.trials.length)) }, reports);
}
