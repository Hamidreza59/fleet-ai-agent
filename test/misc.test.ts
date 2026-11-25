import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { runReplayEvals } from "../src/evals/runner.js";
import type { EvalCase, EvalReport } from "../src/evals/types.js";
import { baselineSkipReason } from "../src/evals/report.js";
import { McpToolBox } from "../src/mcp/client.js";
import { FleetAgent } from "../src/agent.js";
import { estimateCostUsd } from "../src/guardrails/budget.js";
import { isErrorPayload } from "../src/guardrails/guards.js";
import { OpenAICompatibleLlmProvider } from "../src/llm/openaiCompatible.js";
import { ChatMemory } from "../src/memory/chatMemory.js";
import { FakeToolBox, ScriptedLlmProvider, VIN } from "./helpers.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("cost estimation", () => {
  it("uses the price table and lets env override it", () => {
    const u = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
    expect(estimateCostUsd("amazon.nova-lite-v1:0", u)).toBeCloseTo(0.3);
    expect(estimateCostUsd("unknown-model", u)).toBe(0);
    vi.stubEnv("PRICE_INPUT_PER_MTOK", "1");
    vi.stubEnv("PRICE_OUTPUT_PER_MTOK", "2");
    expect(estimateCostUsd("amazon.nova-lite-v1:0", u)).toBeCloseTo(3);
  });
});

describe("config", () => {
  it("falls back to defaults for empty numeric env vars", () => {
    vi.stubEnv("MAX_TOKENS_PER_RUN", "");
    vi.stubEnv("MAX_COST_USD_PER_RUN", "");
    const c = loadConfig();
    expect(c.maxTokensPerRun).toBe(50000);
    expect(c.maxCostUsdPerRun).toBe(0.05);
    vi.stubEnv("MAX_TOKENS_PER_RUN", "abc");
    expect(loadConfig().maxTokensPerRun).toBe(50000);
  });
});

describe("isErrorPayload", () => {
  it("detects error objects and all-error arrays only", () => {
    expect(isErrorPayload('{"error":"x"}')).toBe(true);
    expect(isErrorPayload('[{"error":"x"}]')).toBe(true);
    expect(isErrorPayload('[{"error":"x"},{"a":1}]')).toBe(false);
    expect(isErrorPayload("[]")).toBe(false);
    expect(isErrorPayload("not json")).toBe(false);
  });
});

describe("OpenAI-compatible retries", () => {
  const ok = () =>
    new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] }), { status: 200 });

  it("retries 429 honoring retry-after, then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("slow down", { status: 429, headers: { "retry-after": "3" } }))
      .mockResolvedValueOnce(new Response("oops", { status: 503 }))
      .mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", fetchMock);
    const sleeps: number[] = [];
    const p = new OpenAICompatibleLlmProvider("http://x", "", "m", async (ms) => void sleeps.push(ms));
    const res = await p.converse("s", [{ role: "user", text: "q" }], []);
    expect(res.text).toBe("hi");
    expect(sleeps).toEqual([3000, 4000]);
  });

  it("gives up after 3 retries and does not retry 400", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response("bad", { status: 500 })));
    const p = new OpenAICompatibleLlmProvider("http://x", "", "m", async () => {});
    await expect(p.converse("s", [{ role: "user", text: "q" }], [])).rejects.toThrow(/500/);
    expect(fetch).toHaveBeenCalledTimes(4);
    const f400 = vi.fn().mockResolvedValue(new Response("bad", { status: 400 }));
    vi.stubGlobal("fetch", f400);
    await expect(p.converse("s", [{ role: "user", text: "q" }], [])).rejects.toThrow(/400/);
    expect(f400).toHaveBeenCalledTimes(1);
  });
});

describe("runReplayEvals", () => {
  it("replays recorded trajectories and scores them against their case", async () => {
    const llm = new ScriptedLlmProvider([
      { toolCalls: [{ id: "1", name: "get_vehicle_data", input: { vin: VIN } }] },
      { text: `${VIN} has P0301`, toolCalls: [] },
    ]);
    const agent = new FleetAgent(llm, new FakeToolBox(), new ChatMemory());
    const traj = (await agent.inquire("m", "status?", { caseId: "c1", trial: "1" })).trajectory;
    const cases: EvalCase[] = [
      { id: "c1", tags: [], question: "status?", expect: { toolsCalled: ["get_vehicle_data"], answerIncludes: ["P0301"] } },
      { id: "c2", tags: [], question: "x", expect: { toolsCalled: ["nope"] } },
    ];
    const report = await runReplayEvals(cases, [traj, { ...traj, metadata: { caseId: "unknown" } }]);
    expect(report.provider).toBe("replay:scripted");
    expect(report.summary).toMatchObject({ cases: 1, passed: 1, passRate: 1 });
  });
});

describe("replay_clean", () => {
  it("fails when a guard now blocks a recorded read", async () => {
    const bad = { id: "1", name: "get_vehicle_data", input: { vin: "SHORT" } };
    const llm = new ScriptedLlmProvider([{ toolCalls: [bad] }, { text: "done", toolCalls: [] }]);
    const agent = new FleetAgent(llm, new FakeToolBox(), new ChatMemory(), { guards: [] });
    const traj = (await agent.inquire("m", "q", { caseId: "c1", trial: "1" })).trajectory;
    const cases: EvalCase[] = [{ id: "c1", tags: [], question: "q", expect: { answerIncludes: ["done"] } }];
    const report = await runReplayEvals(cases, [traj]);
    expect(report.cases[0].pass).toBe(false);
    expect(report.cases[0].failedScorers).toContain("replay_clean");
  });
});

describe("retry delay cap", () => {
  it("caps a huge retry-after at 30s", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response("x", { status: 429, headers: { "retry-after": "999" } }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }))),
    );
    const sleeps: number[] = [];
    const p = new OpenAICompatibleLlmProvider("http://x", "", "m", async (ms) => void sleeps.push(ms));
    await p.converse("s", [{ role: "user", text: "q" }], []);
    expect(sleeps).toEqual([30000]);
  });
});

describe("error payload edge cases", () => {
  it("treats a null error field as not an error", () => {
    expect(isErrorPayload('{"error":null,"vin":"x"}')).toBe(false);
  });
});

describe("McpToolBox.execute", () => {
  const box = (result: unknown) =>
    new (McpToolBox as unknown as new (c: unknown, s: unknown[]) => McpToolBox)(
      { callTool: async () => result },
      [],
    );
  const text = (t: string) => ({ type: "text", text: t });

  it("throws on isError and on error payloads", async () => {
    await expect(box({ isError: true, content: [text("boom")] }).execute("t", {})).rejects.toThrow("boom");
    await expect(box({ content: [text('{"error":"No vehicle X"}')] }).execute("t", {})).rejects.toThrow("No vehicle X");
    await expect(box({ content: [text('[{"error":"No vehicle Y"}]')] }).execute("t", {})).rejects.toThrow("No vehicle Y");
  });

  it("returns [] for empty content and joins text blocks otherwise", async () => {
    expect(await box({ content: [] }).execute("t", {})).toBe("[]");
    expect(await box({ content: [text("a"), { type: "image" }, text("b")] }).execute("t", {})).toBe("a\nb");
  });
});

describe("baselineSkipReason", () => {
  it("skips on model mismatch only", () => {
    const mk = (model: string) => ({ model }) as unknown as EvalReport;
    expect(baselineSkipReason(mk("a"), mk("a"))).toBeUndefined();
    expect(baselineSkipReason(mk("a"), mk("b"))).toContain("skipping");
  });
});
