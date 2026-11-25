import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FleetAgent } from "../src/agent.js";
import { ChatMemory } from "../src/memory/chatMemory.js";
import { JsonlTrajectorySink, readTrajectories } from "../src/trace/trajectory.js";
import { FakeToolBox, ScriptedLlmProvider } from "./helpers.js";

describe("trajectory JSONL", () => {
  it("round-trips through the sink and reader, creating directories", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "traj-")), "nested", "t.jsonl");
    const sink = new JsonlTrajectorySink(file);
    const agent = new FleetAgent(
      new ScriptedLlmProvider([
        { text: "a", toolCalls: [] },
        { text: "b", toolCalls: [] },
      ]),
      new FakeToolBox(),
      new ChatMemory(),
      { sink },
    );
    const r1 = await agent.inquire("m", "q1");
    await agent.inquire("m", "q2");

    const read = readTrajectories(file);
    expect(read).toHaveLength(2);
    expect(read[0]).toEqual(JSON.parse(JSON.stringify(r1.trajectory)));
    expect(read[1].question).toBe("q2");
  });

  it("reports the line number of bad JSON and skips blank lines", () => {
    const file = join(mkdtempSync(join(tmpdir(), "traj-")), "bad.jsonl");
    writeFileSync(file, '{"a":1}\n\n{oops\n');
    expect(() => readTrajectories(file)).toThrow(/line 3/);
  });
});
