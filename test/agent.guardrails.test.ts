import { describe, expect, it } from "vitest";
import { FleetAgent, SYSTEM_PROMPT_SHA256 } from "../src/agent.js";
import { ChatMemory } from "../src/memory/chatMemory.js";
import { FakeToolBox, ScriptedLlmProvider, VIN, usage } from "./helpers.js";

const schedule = (vin = VIN) => ({ id: "w1", name: "schedule_maintenance_appointment", input: { vin } });
const read = { id: "r1", name: "get_vehicle_data", input: { vin: VIN } };

describe("FleetAgent guardrails", () => {
  it("queues a side-effect call for approval without executing it, then executes on approve", async () => {
    const tools = new FakeToolBox();
    const llm = new ScriptedLlmProvider([
      { toolCalls: [schedule()], usage: usage(10, 5) },
      { text: "Awaiting approval.", toolCalls: [], usage: usage(20, 5) },
    ]);
    const agent = new FleetAgent(llm, tools, new ChatMemory());
    const r = await agent.inquire("m", `Schedule service for ${VIN}`);

    expect(tools.calls).toHaveLength(0);
    expect(r.pendingApprovals).toHaveLength(1);
    const toolStep = r.trajectory.steps.find((s) => s.type === "tool");
    expect(toolStep).toMatchObject({ status: "pending_approval", guardrail: "write_policy" });
    expect(toolStep && "output" in toolStep ? toolStep.output : "").toContain("PENDING_APPROVAL");
    expect(r.toolCalls).toHaveLength(1);

    const approved = await agent.approvals.approve(r.pendingApprovals[0], tools);
    expect(tools.calls).toHaveLength(1);
    expect(approved.status).toBe("approved");
    expect(approved.result).toContain("WO-");
    await expect(agent.approvals.approve(approved.id, tools)).rejects.toThrow(/already/);
    expect(() => agent.approvals.reject(approved.id)).toThrow();
  });

  it("blocks a side-effect call with an ungrounded VIN and tells the model", async () => {
    const tools = new FakeToolBox();
    const llm = new ScriptedLlmProvider([
      { toolCalls: [schedule("5YJ3E1EA7KF300003")] },
      { text: "Could not.", toolCalls: [] },
    ]);
    const r = await new FleetAgent(llm, tools, new ChatMemory()).inquire("m", "book everything");
    expect(tools.calls).toHaveLength(0);
    expect(r.trajectory.steps.find((s) => s.type === "tool")).toMatchObject({
      status: "blocked",
      guardrail: "vin_grounding",
    });
    const toolMsg = llm.seen[1].find((m) => m.role === "tool");
    expect(toolMsg && "result" in toolMsg ? toolMsg.result : "").toContain("BLOCKED by guardrail vin_grounding");
  });

  it("an observed VIN makes the write reach the policy guard", async () => {
    const tools = new FakeToolBox();
    const llm = new ScriptedLlmProvider([
      { toolCalls: [read] },
      { toolCalls: [schedule()] },
      { text: "done", toolCalls: [] },
    ]);
    const r = await new FleetAgent(llm, tools, new ChatMemory()).inquire("m", "service the Transit");
    expect(r.pendingApprovals).toHaveLength(1);
  });

  it("stops with budget_exceeded and executes no tools", async () => {
    const tools = new FakeToolBox();
    const llm = new ScriptedLlmProvider([{ toolCalls: [read], usage: usage(900, 200) }]);
    const agent = new FleetAgent(llm, tools, new ChatMemory(), { budget: { maxTokens: 1000 } });
    const r = await agent.inquire("m", "q");
    expect(r.stopReason).toBe("budget_exceeded");
    expect(r.answer).toBe("Stopped: this request exceeded its token/cost budget.");
    expect(tools.calls).toHaveLength(0);
  });

  it("records a trajectory with steps, summed usage and a history snapshot", async () => {
    const tools = new FakeToolBox();
    const memory = new ChatMemory();
    const llm = new ScriptedLlmProvider([
      { toolCalls: [read], usage: usage(10, 5) },
      { text: "ok", toolCalls: [], usage: usage(30, 7) },
      { text: "again", toolCalls: [], usage: usage(1, 1) },
    ]);
    const agent = new FleetAgent(llm, tools, memory, { metadata: { a: "1" } });
    const r = await agent.inquire("m", "first", { b: "2" });

    const t = r.trajectory;
    expect(t.steps.map((s) => s.type)).toEqual(["llm", "tool", "llm"]);
    expect(t.usage).toEqual({ inputTokens: 40, outputTokens: 12 });
    expect(t.history).toEqual([]);
    expect(t.metadata).toMatchObject({ a: "1", b: "2", writePolicy: "approval", maxIterations: "6" });
    expect(t.systemPromptSha256).toBe(SYSTEM_PROMPT_SHA256);
    expect(t.stopReason).toBe("final_answer");
    expect(t.tools.map((s) => s.name)).toContain("get_vehicle_data");

    const r2 = await agent.inquire("m", "second");
    expect(r2.trajectory.history.length).toBeGreaterThan(0);
  });

  it("does not fail the request when the sink throws", async () => {
    const llm = new ScriptedLlmProvider([{ text: "hi", toolCalls: [] }]);
    const sink = { write: async () => { throw new Error("disk full"); } };
    const agent = new FleetAgent(llm, new FakeToolBox(), new ChatMemory(), { sink });
    await expect(agent.inquire("m", "q")).resolves.toMatchObject({ answer: "hi" });
  });

  it("turns an unknown tool into an error step", async () => {
    const llm = new ScriptedLlmProvider([
      { toolCalls: [{ id: "x", name: "nope", input: {} }] },
      { text: "failed", toolCalls: [] },
    ]);
    const r = await new FleetAgent(llm, new FakeToolBox(), new ChatMemory()).inquire("m", "q");
    expect(r.trajectory.steps.find((s) => s.type === "tool")).toMatchObject({ status: "error" });
  });

  it("does not let an error payload that echoes a fake VIN ground a booking", async () => {
    const fake = "1HGCM82633A004352";
    const tools = new FakeToolBox();
    tools.execute = async (name, input) => {
      tools.calls.push({ name, input });
      throw new Error(`No vehicle ${fake} in fleet F`);
    };
    const llm = new ScriptedLlmProvider([
      { toolCalls: [{ id: "a", name: "get_vehicle_data", input: { vin: fake } }] },
      { toolCalls: [schedule(fake)] },
      { text: "no", toolCalls: [] },
    ]);
    const r = await new FleetAgent(llm, tools, new ChatMemory()).inquire("m", "service the van");
    const w = r.trajectory.steps.filter((s) => s.type === "tool")[1];
    expect(w).toMatchObject({ status: "blocked", guardrail: "vin_grounding" });
  });

  it("keeps denying a blocked VIN on the next turn, but allows a VIN the user gave earlier", async () => {
    const fake = "1HGCM82633A004352";
    const memory = new ChatMemory();
    const llm = new ScriptedLlmProvider([
      { toolCalls: [schedule(fake)] },
      { text: "blocked", toolCalls: [] },
      { toolCalls: [schedule(fake)] },
      { text: "blocked again", toolCalls: [] },
    ]);
    const agent = new FleetAgent(llm, new FakeToolBox(), memory);
    await agent.inquire("m", "book something");
    const r2 = await agent.inquire("m", "try again");
    expect(r2.trajectory.steps.find((s) => s.type === "tool")).toMatchObject({ status: "blocked" });

    const llm2 = new ScriptedLlmProvider([
      { text: "ok noted", toolCalls: [] },
      { toolCalls: [schedule()] },
      { text: "pending", toolCalls: [] },
    ]);
    const agent2 = new FleetAgent(llm2, new FakeToolBox(), new ChatMemory());
    await agent2.inquire("u", `The van is ${VIN}`);
    const r3 = await agent2.inquire("u", "book it");
    expect(r3.pendingApprovals).toHaveLength(1);
  });

  it("executes a concurrent double approve exactly once", async () => {
    const tools = new FakeToolBox();
    const llm = new ScriptedLlmProvider([{ toolCalls: [schedule()] }, { text: "w", toolCalls: [] }]);
    const agent = new FleetAgent(llm, tools, new ChatMemory());
    const r = await agent.inquire("m", `book ${VIN}`);
    const id = r.pendingApprovals[0];
    const out = await Promise.allSettled([agent.approvals.approve(id, tools), agent.approvals.approve(id, tools)]);
    expect(out.map((o) => o.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(tools.calls).toHaveLength(1);
  });

  it("marks an approval failed when execution throws", async () => {
    const tools = new FakeToolBox();
    const llm = new ScriptedLlmProvider([{ toolCalls: [schedule()] }, { text: "w", toolCalls: [] }]);
    const agent = new FleetAgent(llm, tools, new ChatMemory());
    const r = await agent.inquire("m", `book ${VIN}`);
    const failing = { specs: () => [], execute: async () => { throw new Error("db down"); } };
    const item = await agent.approvals.approve(r.pendingApprovals[0], failing);
    expect(item).toMatchObject({ status: "failed", error: "db down" });
  });

  it("deny policy blocks the write and max_iterations stops a looping model", async () => {
    const tools = new FakeToolBox();
    const deny = new FleetAgent(
      new ScriptedLlmProvider([{ toolCalls: [schedule()] }, { text: "no", toolCalls: [] }]),
      tools,
      new ChatMemory(),
      { writePolicy: "deny" },
    );
    const r = await deny.inquire("m", `book ${VIN}`);
    expect(r.trajectory.steps.find((s) => s.type === "tool")).toMatchObject({ status: "blocked", guardrail: "write_policy" });
    expect(tools.calls).toHaveLength(0);

    const loop = new ScriptedLlmProvider([{ toolCalls: [read] }, { toolCalls: [{ ...read, id: "r2" }] }]);
    const r2 = await new FleetAgent(loop, new FakeToolBox(), new ChatMemory(), { maxIterations: 2 }).inquire("m", "q");
    expect(r2.stopReason).toBe("max_iterations");
    expect(r2.iterations).toBe(2);
  });

  it("records requested calls even when the budget stops the run", async () => {
    const llm = new ScriptedLlmProvider([{ toolCalls: [read], usage: usage(900, 200) }]);
    const r = await new FleetAgent(llm, new FakeToolBox(), new ChatMemory(), { budget: { maxTokens: 10 } }).inquire("m", "q");
    expect(r.toolCalls).toHaveLength(1);
  });
});
