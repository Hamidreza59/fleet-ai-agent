/** LLM-as-judge: scores an answer 1-5 against a case rubric. */

import type { LlmProvider } from "../types.js";
import type { EvalRun } from "./scorers.js";
import type { EvalCase } from "./types.js";

export interface JudgeResult {
  score: number;
  reason: string;
  pass: boolean;
}

const JUDGE_SYSTEM =
  "You are a strict evaluator of an AI fleet-management assistant. Grade the answer against the rubric, " +
  "using the tool outputs as ground truth. Respond with ONLY JSON: {\"score\": <1-5>, \"reason\": \"<short>\"}.";

export function extractJson(text: string): { score: number; reason: string } | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const o = JSON.parse(text.slice(start, end + 1)) as { score?: unknown; reason?: unknown };
    const score = Number(o.score);
    if (!Number.isFinite(score)) return undefined;
    return { score, reason: String(o.reason ?? "") };
  } catch {
    return undefined;
  }
}

export async function judgeAnswer(llm: LlmProvider, c: EvalCase, run: EvalRun): Promise<JudgeResult> {
  const outputs = run.trajectory.steps
    .flatMap((s) => (s.type === "tool" ? [`[${s.name}] ${s.output}`] : []))
    .join("\n")
    .slice(0, 4000);
  const prompt = [
    `Question: ${c.question}`,
    `Rubric: ${c.rubric ?? ""}`,
    `Tool outputs:\n${outputs || "(none)"}`,
    `Answer:\n${run.answer}`,
  ].join("\n\n");
  const res = await llm.converse(JUDGE_SYSTEM, [{ role: "user", text: prompt }], []);
  const parsed = extractJson(res.text ?? "");
  if (!parsed) return { score: 1, reason: `unparseable judge output: ${(res.text ?? "").slice(0, 120)}`, pass: false };
  const score = Math.min(5, Math.max(1, parsed.score));
  return { score, reason: parsed.reason, pass: score >= 4 };
}
