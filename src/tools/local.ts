/** Local (in-process) tools the agent can call, alongside the remote MCP tools.
 *
 * Mirrors the original demo's `scheduleMaintenanceAppointment` tool. In a real
 * system this would write to a work-order / scheduling system; here it returns a
 * deterministic confirmation.
 */

import type { ToolSpec } from "../types.js";

export interface LocalTool {
  spec: ToolSpec;
  run(input: Record<string, unknown>): Promise<string>;
}

export const scheduleMaintenanceTool: LocalTool = {
  spec: {
    name: "schedule_maintenance_appointment",
    description:
      "Schedule a maintenance appointment for a vehicle. Use after identifying an " +
      "issue (DTC, low fuel/charge, degraded battery) that requires service.",
    inputSchema: {
      type: "object",
      properties: {
        vin: { type: "string", description: "VIN of the vehicle that needs service" },
        issue: {
          type: "string",
          description: "The problem to service, including any DTC codes",
        },
      },
      required: ["vin", "issue"],
    },
  },
  async run(input) {
    const vin = String(input.vin ?? "UNKNOWN");
    const issue = String(input.issue ?? "unspecified issue");
    const slot = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    return `Scheduled maintenance for ${vin} (${issue}) on ${slot}. Work order WO-${vin.slice(-5)} created.`;
  },
};

export const localTools: LocalTool[] = [scheduleMaintenanceTool];
