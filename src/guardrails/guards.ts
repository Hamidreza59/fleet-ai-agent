/** Tool-call guards: evaluated in order before any tool executes; first non-allow wins. */

import type { ToolCall, ToolSpec } from "../types.js";

export type GuardDecision =
  | { action: "allow" }
  | { action: "deny"; reason: string }
  | { action: "require_approval"; reason: string };

export interface GuardContext {
  runId: string;
  managerId: string;
  question: string;
  spec?: ToolSpec;
  observations: string[];
  userTexts?: string[];
}

export interface ToolGuard {
  readonly name: string;
  check(call: ToolCall, ctx: GuardContext): GuardDecision;
}

export type WritePolicy = "allow" | "approval" | "deny";

const SYNTHETIC_RE = /^(BLOCKED by guardrail|PENDING_APPROVAL|REPLAY_MISS|ERROR calling)/;

function isErrorObject(v: unknown): boolean {
  return !!v && typeof v === "object" && !Array.isArray(v) && "error" in v && (v as { error: unknown }).error != null;
}

export function isErrorPayload(text: string): boolean {
  try {
    const v: unknown = JSON.parse(text);
    if (Array.isArray(v)) return v.length > 0 && v.every(isErrorObject);
    return isErrorObject(v);
  } catch {
    return false;
  }
}

/** True if a tool output may count as evidence for grounding checks. */
export function isUsableObservation(text: string): boolean {
  return !SYNTHETIC_RE.test(text) && !isErrorPayload(text);
}

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/i;
const ALLOW: GuardDecision = { action: "allow" };

export const vinFormatGuard: ToolGuard = {
  name: "vin_format",
  check(call) {
    if (!("vin" in call.input)) return ALLOW;
    const vin = call.input.vin;
    if (typeof vin === "string" && VIN_RE.test(vin)) return ALLOW;
    return { action: "deny", reason: `"${String(vin)}" is not a valid 17-character VIN` };
  },
};

export const vinGroundingGuard: ToolGuard = {
  name: "vin_grounding",
  check(call, ctx) {
    if (!ctx.spec?.sideEffect) return ALLOW;
    const vin = call.input.vin;
    if (typeof vin !== "string") {
      return { action: "deny", reason: "no VIN was provided for a side-effecting tool" };
    }
    const seen = [ctx.question, ...(ctx.userTexts ?? []), ...ctx.observations].some((s) => s.toLowerCase().includes(vin.toLowerCase()));
    return seen ? ALLOW : { action: "deny", reason: `VIN ${vin} was not observed in user input or tool results` };
  },
};

export function writePolicyGuard(policy: WritePolicy): ToolGuard {
  return {
    name: "write_policy",
    check(call, ctx) {
      if (!ctx.spec?.sideEffect || policy === "allow") return ALLOW;
      if (policy === "deny") {
        return { action: "deny", reason: `${call.name} is disabled by write policy` };
      }
      return { action: "require_approval", reason: `${call.name} mutates external state` };
    },
  };
}

export function defaultGuards(policy: WritePolicy = "approval"): ToolGuard[] {
  return [vinFormatGuard, vinGroundingGuard, writePolicyGuard(policy)];
}
