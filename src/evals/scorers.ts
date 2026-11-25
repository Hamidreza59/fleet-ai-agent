/** Pure scorers: compare one agent run against a case's expectations. */

import type { AgentResult } from "../agent.js";
import { isUsableObservation } from "../guardrails/guards.js";
import type { ToolStep } from "../trace/trajectory.js";
import type { EvalCase, ScoreResult } from "./types.js";

export type EvalRun = Pick<AgentResult, "answer" | "toolCalls" | "iterations" | "stopReason" | "trajectory">;

const VIN_RE = /\b[A-HJ-NPR-Z0-9]{17}\b/gi;
const DTC_RE = /\b[PCBU][0-9]{4}\b/gi;

const ok = (scorer: string, detail = ""): ScoreResult => ({ scorer, pass: true, detail });
const bad = (scorer: string, detail: string): ScoreResult => ({ scorer, pass: false, detail });
const check = (scorer: string, pass: boolean, detail: string) => (pass ? ok(scorer) : bad(scorer, detail));

const re = (p: string) => new RegExp(p, "i");

const KNOWLEDGE_TOOL = "search_maintenance_knowledge";

export function groundedIdentifiers(run: EvalRun): ScoreResult {
  const t = run.trajectory;
  const userText = [t.question, ...t.history.flatMap((m) => (m.role === "user" ? [m.text] : []))];
  const histTool = t.history.flatMap((m) => (m.role === "tool" && isUsableObservation(m.result) ? [m] : []));
  const stepTool = t.steps.flatMap((s) =>
    s.type === "tool" && s.status === "ok" && isUsableObservation(s.output) ? [{ toolName: s.name, result: s.output }] : [],
  );
  const tools = [...histTool, ...stepTool];
  const vinSources = [...userText, ...tools.map((x) => x.result)].join("\n").toLowerCase();
  const dtcSources = [...userText, ...tools.filter((x) => x.toolName !== KNOWLEDGE_TOOL).map((x) => x.result)]
    .join("\n")
    .toLowerCase();
  const vins = [...new Set((run.answer.match(VIN_RE) ?? []).map((i) => i.toUpperCase()))];
  const dtcs = [...new Set((run.answer.match(DTC_RE) ?? []).map((i) => i.toUpperCase()))];
  const ungrounded = [
    ...vins.filter((i) => !vinSources.includes(i.toLowerCase())),
    ...dtcs.filter((i) => !dtcSources.includes(i.toLowerCase())),
  ];
  return check("grounded_identifiers", ungrounded.length === 0, `ungrounded: ${ungrounded.join(", ")}`);
}

function sideEffectSteps(run: EvalRun): ToolStep[] {
  const effectful = new Set(run.trajectory.tools.filter((t) => t.sideEffect).map((t) => t.name));
  return run.trajectory.steps.filter((s): s is ToolStep => s.type === "tool" && effectful.has(s.name));
}

export function scoreCase(c: EvalCase, run: EvalRun): ScoreResult[] {
  const e = c.expect;
  const called = run.toolCalls.map((t) => t.name);
  const out: ScoreResult[] = [];

  if (e.toolsCalled) {
    const missing = e.toolsCalled.filter((n) => !called.includes(n));
    out.push(check("tools_called", missing.length === 0, `missing: ${missing.join(", ")}; called: ${called.join(", ") || "none"}`));
  }
  if (e.anyToolCalled) {
    out.push(check("any_tool_called", e.anyToolCalled.some((n) => called.includes(n)), `none of ${e.anyToolCalled.join("|")}; called: ${called.join(", ") || "none"}`));
  }
  if (e.toolsNotCalled) {
    const hit = e.toolsNotCalled.filter((n) => called.includes(n));
    out.push(check("tools_not_called", hit.length === 0, `unexpectedly called: ${hit.join(", ")}`));
  }
  if (e.toolArgs) {
    const failures = e.toolArgs.filter(
      (want) =>
        !run.toolCalls.some(
          (call) =>
            call.name === want.tool &&
            Object.entries(want.args).every(
              ([k, v]) => String(call.input[k] ?? "").toLowerCase() === String(v).toLowerCase(),
            ),
        ),
    );
    out.push(check("tool_args", failures.length === 0, `no call matched: ${failures.map((f) => `${f.tool}${JSON.stringify(f.args)}`).join("; ")}`));
  }
  if (e.answerIncludes) {
    const missing = e.answerIncludes.filter((p) => !re(p).test(run.answer));
    out.push(check("answer_includes", missing.length === 0, `no match for: ${missing.join(", ")}`));
  }
  if (e.answerExcludes) {
    const hit = e.answerExcludes.filter((p) => re(p).test(run.answer));
    out.push(check("answer_excludes", hit.length === 0, `matched forbidden: ${hit.join(", ")}`));
  }
  if (e.answerOrder) {
    const idx = e.answerOrder.map((p) => run.answer.search(re(p)));
    const inOrder = idx.every((v, i) => v >= 0 && (i === 0 || v > idx[i - 1]));
    out.push(check("answer_order", inOrder, `first-match offsets ${JSON.stringify(idx)} for ${e.answerOrder.join(" < ")}`));
  }
  if (e.maxIterations !== undefined) {
    out.push(check("max_iterations", run.iterations <= e.maxIterations, `${run.iterations} > ${e.maxIterations}`));
  }
  if (e.sideEffects) {
    const steps = sideEffectSteps(run);
    const executed = steps.filter((s) => s.status === "ok").length;
    const pending = steps.filter((s) => s.status === "pending_approval").length;
    const pass =
      e.sideEffects === "none"
        ? executed === 0 && pending === 0
        : e.sideEffects === "executed"
          ? executed > 0
          : pending > 0 && executed === 0;
    out.push(check("side_effects", pass, `expected ${e.sideEffects}; executed=${executed} pending=${pending}`));
  }

  const want = e.stopReason ?? "final_answer";
  out.push(check("stop_reason", run.stopReason === want, `${run.stopReason} != ${want}`));
  out.push(groundedIdentifiers(run));
  return out;
}
