/** Combines several ToolBoxes (remote MCP tools + local tools) into one. */

import type { ToolBox, ToolSpec } from "../types.js";
import { localTools, type LocalTool } from "./local.js";

/** Wraps the in-process local tools as a ToolBox. */
export class LocalToolBox implements ToolBox {
  constructor(private tools: LocalTool[] = localTools) {}

  specs(): ToolSpec[] {
    return this.tools.map((t) => t.spec);
  }

  async execute(name: string, input: Record<string, unknown>): Promise<string> {
    const tool = this.tools.find((t) => t.spec.name === name);
    if (!tool) throw new Error(`Unknown local tool: ${name}`);
    return tool.run(input);
  }
}

/** Merges multiple toolboxes; routes each call to the box that owns the tool. */
export class CompositeToolBox implements ToolBox {
  constructor(private boxes: ToolBox[]) {}

  specs(): ToolSpec[] {
    return this.boxes.flatMap((b) => b.specs());
  }

  async execute(name: string, input: Record<string, unknown>): Promise<string> {
    const owner = this.boxes.find((b) => b.specs().some((s) => s.name === name));
    if (!owner) throw new Error(`No tool named "${name}" is registered`);
    return owner.execute(name, input);
  }
}
