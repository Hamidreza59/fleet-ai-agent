import { describe, expect, it } from "vitest";
import { FleetAgent } from "../src/agent.js";
import { ChatMemory } from "../src/memory/chatMemory.js";
import { MockLlmProvider } from "../src/llm/mock.js";
import { CompositeToolBox, LocalToolBox } from "../src/tools/registry.js";
import type { ToolBox, ToolSpec } from "../src/types.js";

/** A fake MCP toolbox so the agent can be tested without a running server. */
class FakeMcpToolBox implements ToolBox {
  public calls: { name: string; input: Record<string, unknown> }[] = [];
  specs(): ToolSpec[] {
    return [
      {
        name: "get_fleet_summary",
        description: "Fleet rollup",
        inputSchema: {
          type: "object",
          properties: { fleet_id: { type: "string" }, timeframe: { type: "string" } },
          required: ["fleet_id"],
        },
      },
    ];
  }
  async execute(name: string, input: Record<string, unknown>): Promise<string> {
    this.calls.push({ name, input });
    return JSON.stringify({ fleet_id: input.fleet_id, total_vehicles: 4, maintenance_required: 2 });
  }
}

describe("FleetAgent", () => {
  it("runs the tool-use loop: calls a tool, then answers from the result", async () => {
    const mcp = new FakeMcpToolBox();
    const tools = new CompositeToolBox([mcp, new LocalToolBox()]);
    const agent = new FleetAgent(new MockLlmProvider(), tools, new ChatMemory());

    const result = await agent.inquire("alex", "How is my fleet doing?");

    expect(mcp.calls).toHaveLength(1);
    expect(mcp.calls[0].name).toBe("get_fleet_summary");
    expect(result.answer).toContain("total_vehicles");
    expect(result.iterations).toBe(2); // one tool turn + one answer turn
  });

  it("exposes both MCP and local tools to the model", async () => {
    const tools = new CompositeToolBox([new FakeMcpToolBox(), new LocalToolBox()]);
    const names = tools.specs().map((s) => s.name);
    expect(names).toContain("get_fleet_summary");
    expect(names).toContain("schedule_maintenance_appointment");
  });

  it("keeps per-manager memory isolated", async () => {
    const memory = new ChatMemory();
    const agent = new FleetAgent(
      new MockLlmProvider(),
      new CompositeToolBox([new FakeMcpToolBox(), new LocalToolBox()]),
      memory,
    );
    await agent.inquire("alex", "How is my fleet?");
    expect(memory.history("alex").length).toBeGreaterThan(0);
    expect(memory.history("sam").length).toBe(0);
  });

  it("routes local tool calls and returns a work order", async () => {
    const tools = new LocalToolBox();
    const out = await tools.execute("schedule_maintenance_appointment", {
      vin: "1FTBW2CMXKKB10001",
      issue: "P0301 misfire",
    });
    expect(out).toContain("Scheduled maintenance");
    expect(out).toContain("WO-");
  });
});
