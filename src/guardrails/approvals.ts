/** In-memory human-approval queue for side-effecting tool calls. */

import { randomUUID } from "node:crypto";
import type { ToolBox, ToolCall } from "../types.js";

export interface PendingApproval {
  id: string;
  runId: string;
  managerId: string;
  call: ToolCall;
  createdAt: string;
  status: "pending" | "executing" | "approved" | "rejected" | "failed";
  result?: string;
  error?: string;
}

export class ApprovalQueue {
  private items = new Map<string, PendingApproval>();

  create(args: { runId: string; managerId: string; call: ToolCall }): PendingApproval {
    const item: PendingApproval = {
      id: randomUUID(),
      ...args,
      createdAt: new Date().toISOString(),
      status: "pending",
    };
    this.items.set(item.id, item);
    return item;
  }

  get(id: string): PendingApproval | undefined {
    return this.items.get(id);
  }

  list(status?: PendingApproval["status"]): PendingApproval[] {
    return [...this.items.values()].filter((a) => !status || a.status === status);
  }

  async approve(id: string, tools: ToolBox): Promise<PendingApproval> {
    const item = this.pending(id);
    item.status = "executing";
    try {
      item.result = await tools.execute(item.call.name, item.call.input);
      item.status = "approved";
    } catch (err) {
      item.error = (err as Error).message;
      item.status = "failed";
    }
    return item;
  }

  reject(id: string): PendingApproval {
    const item = this.pending(id);
    item.status = "rejected";
    return item;
  }

  private pending(id: string): PendingApproval {
    const item = this.items.get(id);
    if (!item) throw new Error(`Unknown approval ${id}`);
    if (item.status !== "pending") throw new Error(`Approval ${id} is already ${item.status}`);
    return item;
  }
}
