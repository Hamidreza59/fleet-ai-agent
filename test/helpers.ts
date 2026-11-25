import type { ChatMessage, LlmProvider, LlmResponse, ToolBox, ToolSpec } from "../src/types.js";

export class ScriptedLlmProvider implements LlmProvider {
  readonly name = "scripted";
  readonly model = "scripted-model";
  readonly seen: ChatMessage[][] = [];
  private i = 0;

  constructor(private responses: LlmResponse[]) {}

  async converse(_s: string, messages: ChatMessage[]): Promise<LlmResponse> {
    this.seen.push(messages);
    const r = this.responses[this.i++];
    if (!r) throw new Error("scripted LLM exhausted");
    return r;
  }
}

export const VIN = "1FTBW2CMXKKB10001";

export const READ_SPEC: ToolSpec = {
  name: "get_vehicle_data",
  description: "read",
  inputSchema: { type: "object", properties: { vin: { type: "string" } } },
};

export const WRITE_SPEC: ToolSpec = {
  name: "schedule_maintenance_appointment",
  description: "write",
  sideEffect: true,
  inputSchema: { type: "object", properties: { vin: { type: "string" } } },
};

export class FakeToolBox implements ToolBox {
  calls: { name: string; input: Record<string, unknown> }[] = [];

  specs(): ToolSpec[] {
    return [READ_SPEC, WRITE_SPEC];
  }

  async execute(name: string, input: Record<string, unknown>): Promise<string> {
    this.calls.push({ name, input });
    if (name === "get_vehicle_data") return JSON.stringify({ vin: input.vin, dtc_list: ["P0301"], fuel_level: 18 });
    if (name === "schedule_maintenance_appointment") return `Scheduled ${String(input.vin)}. Work order WO-10001 created.`;
    throw new Error(`Unknown tool: ${name}`);
  }
}

export const usage = (i: number, o: number) => ({ inputTokens: i, outputTokens: o });
