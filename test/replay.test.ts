import { describe, expect, it } from "vitest";
import { FleetAgent } from "../src/agent.js";
import { ChatMemory } from "../src/memory/chatMemory.js";
import { RecordedLlmProvider, RecordedToolBox, replayTrajectory, stableStringify } from "../src/trace/replay.js";
import { FakeToolBox, ScriptedLlmProvider, VIN } from "./helpers.js";

async function record() {
  const llm = new ScriptedLlmProvider([
    { toolCalls: [{ id: "1", name: "get_vehicle_data", input: { vin: VIN, fleet_id: "F" } }] },
    { text: `${VIN} has P0301`, toolCalls: [] },
  ]);
  return (await new FleetAgent(llm, new FakeToolBox(), new ChatMemory()).inquire("m", "status?")).trajectory;
}

describe("replay", () => {
  it("stableStringify ignores key order", () => {
    expect(stableStringify({ b: 1, a: { d: 1, c: 2 } })).toBe(stableStringify({ a: { c: 2, d: 1 }, b: 1 }));
  });

  it("reproduces the recorded run exactly with no misses", async () => {
    const traj = await record();
    const { diff, replayed } = await replayTrajectory(traj);
    expect(diff).toEqual({
      toolSequenceChanged: false,
      originalTools: ["get_vehicle_data"],
      replayedTools: ["get_vehicle_data"],
      answerChanged: false,
      stopReasonChanged: false,
      changedSteps: [],
      unusedRecorded: [],
      reused: [],
      misses: [],
    });
    expect(replayed.metadata.replayOf).toBe(traj.runId);
  });

  it("reports a miss and a changed tool sequence for a different LLM", async () => {
    const traj = await record();
    const alt = new ScriptedLlmProvider([
      { toolCalls: [{ id: "x", name: "get_dtc_info", input: { vin: VIN, dtc: "P0301" } }] },
      { text: "different", toolCalls: [] },
    ]);
    const { diff } = await replayTrajectory(traj, { llm: alt });
    expect(diff.toolSequenceChanged).toBe(true);
    expect(diff.answerChanged).toBe(true);
    expect(diff.misses).toHaveLength(1);
    expect(diff.misses[0]).toContain("get_dtc_info");
    expect(diff.changedSteps.length).toBeGreaterThan(0);
    expect(diff.unusedRecorded).toHaveLength(1);
  });

  it("live replay reuses a recorded output for a repeated identical call instead of missing", async () => {
    const traj = await record();
    const call = { id: "x", name: "get_vehicle_data", input: { vin: VIN, fleet_id: "F" } };
    const alt = new ScriptedLlmProvider([
      { toolCalls: [call] },
      { toolCalls: [{ ...call, id: "y" }] },
      { text: "done", toolCalls: [] },
    ]);
    const { diff } = await replayTrajectory(traj, { llm: alt });
    expect(diff.misses).toEqual([]);
    expect(diff.reused).toHaveLength(1);
  });

  it("replays the recorded write policy and max iterations from metadata", async () => {
    const llm = new ScriptedLlmProvider([
      { toolCalls: [{ id: "w", name: "schedule_maintenance_appointment", input: { vin: VIN } }] },
      { text: "booked", toolCalls: [] },
    ]);
    const agent = new FleetAgent(llm, new FakeToolBox(), new ChatMemory(), { writePolicy: "allow", maxIterations: 4 });
    const traj = (await agent.inquire("m", `book ${VIN}`)).trajectory;
    expect(traj.metadata).toMatchObject({ writePolicy: "allow", maxIterations: "4" });
    const { diff, replayed } = await replayTrajectory(traj);
    expect(diff.changedSteps).toEqual([]);
    expect(replayed.steps.find((s) => s.type === "tool")).toMatchObject({ status: "ok" });
  });

  it("RecordedToolBox replays errors as throws and RecordedLlmProvider exhausts", async () => {
    const traj = await record();
    traj.steps.push({
      type: "tool", iteration: 9, callId: "e", name: "boom", input: {}, output: "ERROR calling boom: bad", latencyMs: 0, status: "error",
    });
    await expect(new RecordedToolBox(traj).execute("boom", {})).rejects.toThrow("bad");
    const llm = new RecordedLlmProvider(traj);
    await llm.converse("", [], []);
    await llm.converse("", [], []);
    await expect(llm.converse("", [], [])).rejects.toThrow(/exhausted/);
  });
});
