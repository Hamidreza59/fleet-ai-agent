import { describe, expect, it } from "vitest";
import { extractJson } from "../src/evals/judge.js";
import { findRegressions } from "../src/evals/report.js";
import { buildReport } from "../src/evals/runner.js";
import { groundedIdentifiers, scoreCase, type EvalRun } from "../src/evals/scorers.js";
import type { EvalCase } from "../src/evals/types.js";
import type { Trajectory } from "../src/trace/trajectory.js";
import { VIN, WRITE_SPEC } from "./helpers.js";

function run(over: Partial<EvalRun> = {}, steps: Trajectory["steps"] = []): EvalRun {
  return {
    answer: "",
    toolCalls: [],
    iterations: 1,
    stopReason: "final_answer",
    trajectory: { question: "q", history: [], tools: [WRITE_SPEC], steps } as unknown as Trajectory,
    ...over,
  };
}
const toolStep = (name: string, output: string, status: "ok" | "pending_approval" | "blocked" = "ok") =>
  ({ type: "tool", iteration: 1, callId: "c", name, input: {}, output, latencyMs: 0, status }) as Trajectory["steps"][number];
const kase = (expect: EvalCase["expect"]): EvalCase => ({ id: "c", tags: [], question: "q", expect });
const get = (rs: ReturnType<typeof scoreCase>, name: string) => rs.find((r) => r.scorer === name)!;

describe("scorers", () => {
  it("tools_called / any_tool_called / tools_not_called", () => {
    const r = run({ toolCalls: [{ name: "a", input: {} }] });
    const rs = scoreCase(kase({ toolsCalled: ["a", "b"], anyToolCalled: ["b", "a"], toolsNotCalled: ["z"] }), r);
    expect(get(rs, "tools_called").pass).toBe(false);
    expect(get(rs, "any_tool_called").pass).toBe(true);
    expect(get(rs, "tools_not_called").pass).toBe(true);
    expect(get(scoreCase(kase({ toolsNotCalled: ["a"] }), r), "tools_not_called").pass).toBe(false);
  });

  it("tool_args compares case-insensitively", () => {
    const r = run({ toolCalls: [{ name: "t", input: { timeframe: "7D", n: 3 } }] });
    expect(get(scoreCase(kase({ toolArgs: [{ tool: "t", args: { timeframe: "7d" } }] }), r), "tool_args").pass).toBe(true);
    expect(get(scoreCase(kase({ toolArgs: [{ tool: "t", args: { timeframe: "24h" } }] }), r), "tool_args").pass).toBe(false);
  });

  it("answer_includes / answer_excludes / answer_order", () => {
    const r = run({ answer: "Silverado first, then the Transit. 6,580 miles" });
    expect(get(scoreCase(kase({ answerIncludes: ["6,?580", "transit"] }), r), "answer_includes").pass).toBe(true);
    expect(get(scoreCase(kase({ answerIncludes: ["nope"] }), r), "answer_includes").pass).toBe(false);
    expect(get(scoreCase(kase({ answerExcludes: ["ford"] }), r), "answer_excludes").pass).toBe(true);
    expect(get(scoreCase(kase({ answerExcludes: ["transit"] }), r), "answer_excludes").pass).toBe(false);
    expect(get(scoreCase(kase({ answerOrder: ["silverado", "transit"] }), r), "answer_order").pass).toBe(true);
    expect(get(scoreCase(kase({ answerOrder: ["transit", "silverado"] }), r), "answer_order").pass).toBe(false);
    expect(get(scoreCase(kase({ answerOrder: ["silverado", "missing"] }), r), "answer_order").pass).toBe(false);
  });

  it("max_iterations and stop_reason", () => {
    const r = run({ iterations: 5, stopReason: "max_iterations" });
    const rs = scoreCase(kase({ maxIterations: 4 }), r);
    expect(get(rs, "max_iterations").pass).toBe(false);
    expect(get(rs, "stop_reason").pass).toBe(false);
    expect(get(scoreCase(kase({ stopReason: "max_iterations" }), r), "stop_reason").pass).toBe(true);
  });

  it("side_effects reflects tool step statuses", () => {
    const name = WRITE_SPEC.name;
    const pending = run({}, [toolStep(name, "p", "pending_approval")]);
    const done = run({}, [toolStep(name, "ok")]);
    const blocked = run({}, [toolStep(name, "b", "blocked")]);
    expect(get(scoreCase(kase({ sideEffects: "pending_approval" }), pending), "side_effects").pass).toBe(true);
    expect(get(scoreCase(kase({ sideEffects: "executed" }), done), "side_effects").pass).toBe(true);
    expect(get(scoreCase(kase({ sideEffects: "executed" }), pending), "side_effects").pass).toBe(false);
    expect(get(scoreCase(kase({ sideEffects: "none" }), blocked), "side_effects").pass).toBe(true);
    expect(get(scoreCase(kase({ sideEffects: "none" }), pending), "side_effects").pass).toBe(false);
  });

  it("grounded_identifiers catches fabricated VINs and DTCs", () => {
    const grounded = run({ answer: `${VIN} has P0301` }, [toolStep("get_vehicle_data", `{"vin":"${VIN}","dtc":"P0301"}`)]);
    expect(groundedIdentifiers(grounded).pass).toBe(true);
    const fake = run({ answer: "VIN 1HGCM82633A004352 has P0999" }, [toolStep("get_vehicle_data", "{}")]);
    const res = groundedIdentifiers(fake);
    expect(res.pass).toBe(false);
    expect(res.detail).toContain("1HGCM82633A004352");
    expect(res.detail).toContain("P0999");
  });

  it("grounded_identifiers ignores DTCs that only appear in knowledge-base output and in error payloads", () => {
    const kb = run({ answer: "P0301 and P0420" }, [toolStep("search_maintenance_knowledge", "P0301 P0420 docs")]);
    expect(groundedIdentifiers(kb).pass).toBe(false);
    const err = run({ answer: `VIN 1HGCM82633A004352` }, [
      toolStep("get_vehicle_data", '{"error":"No vehicle 1HGCM82633A004352 in fleet X"}'),
    ]);
    expect(groundedIdentifiers(err).pass).toBe(false);
    const blocked = run({ answer: "VIN 1HGCM82633A004352" }, [
      toolStep(WRITE_SPEC.name, "BLOCKED by guardrail x: VIN 1HGCM82633A004352 was not observed"),
    ]);
    expect(groundedIdentifiers(blocked).pass).toBe(false);
  });

  it("grounded_identifiers accepts ids from the question", () => {
    const r = run({ answer: `Checking ${VIN.toLowerCase()}` });
    r.trajectory.question = `status of ${VIN}`;
    expect(groundedIdentifiers(r).pass).toBe(true);
  });
});

describe("judge + report helpers", () => {
  it("extractJson is tolerant of surrounding prose", () => {
    expect(extractJson('Sure! {"score": 4, "reason": "good"} done')).toEqual({ score: 4, reason: "good" });
    expect(extractJson("no json")).toBeUndefined();
    expect(extractJson('{"score": 5, "reason": "uses } brace"}')).toEqual({ score: 5, reason: "uses } brace" });
  });

  it("findRegressions flags cases that passed in the baseline and now fail", () => {
    const mk = (pass: boolean) => ({ id: "a", tags: [], pass, passRate: pass ? 1 : 0, failedScorers: [], trials: [] });
    const meta = { provider: "p", model: "m", trials: 1 };
    expect(findRegressions(buildReport(meta, [mk(true)]), buildReport(meta, [mk(false)]))).toEqual(["a"]);
    expect(findRegressions(buildReport(meta, [mk(false)]), buildReport(meta, [mk(false)]))).toEqual([]);
  });
});
