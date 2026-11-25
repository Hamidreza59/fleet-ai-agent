import { describe, expect, it } from "vitest";
import {
  defaultGuards,
  vinFormatGuard,
  vinGroundingGuard,
  writePolicyGuard,
  type GuardContext,
} from "../src/guardrails/guards.js";
import { READ_SPEC, VIN, WRITE_SPEC } from "./helpers.js";

const ctx = (over: Partial<GuardContext> = {}): GuardContext => ({
  runId: "r",
  managerId: "m",
  question: "hello",
  spec: WRITE_SPEC,
  observations: [],
  ...over,
});
const call = (name: string, input: Record<string, unknown>) => ({ id: "c", name, input });

describe("guards", () => {
  it("vinFormatGuard denies malformed VINs and accepts valid ones", () => {
    expect(vinFormatGuard.check(call("t", { vin: "ABC" }), ctx()).action).toBe("deny");
    expect(vinFormatGuard.check(call("t", { vin: "1FTBW2CMXKKB1000O" }), ctx()).action).toBe("deny");
    expect(vinFormatGuard.check(call("t", { vin: VIN.toLowerCase() }), ctx()).action).toBe("allow");
    expect(vinFormatGuard.check(call("t", { fleet_id: "x" }), ctx()).action).toBe("allow");
  });

  it("vinGroundingGuard denies unseen VINs on side-effect tools", () => {
    const d = vinGroundingGuard.check(call(WRITE_SPEC.name, { vin: VIN }), ctx());
    expect(d).toEqual({ action: "deny", reason: `VIN ${VIN} was not observed in user input or tool results` });
  });

  it("vinGroundingGuard allows VINs seen in the question or an observation", () => {
    const c = call(WRITE_SPEC.name, { vin: VIN });
    expect(vinGroundingGuard.check(c, ctx({ question: `service ${VIN.toLowerCase()}` })).action).toBe("allow");
    expect(vinGroundingGuard.check(c, ctx({ observations: [`{"vin":"${VIN}"}`] })).action).toBe("allow");
  });

  it("vinGroundingGuard ignores read tools", () => {
    expect(vinGroundingGuard.check(call(READ_SPEC.name, { vin: VIN }), ctx({ spec: READ_SPEC })).action).toBe("allow");
  });

  it("writePolicyGuard maps policy to decision for side-effect tools only", () => {
    const c = call(WRITE_SPEC.name, { vin: VIN });
    expect(writePolicyGuard("allow").check(c, ctx()).action).toBe("allow");
    expect(writePolicyGuard("approval").check(c, ctx()).action).toBe("require_approval");
    expect(writePolicyGuard("deny").check(c, ctx()).action).toBe("deny");
    expect(writePolicyGuard("deny").check(call(READ_SPEC.name, {}), ctx({ spec: READ_SPEC })).action).toBe("allow");
  });

  it("defaultGuards orders format, grounding, policy", () => {
    expect(defaultGuards("allow").map((g) => g.name)).toEqual(["vin_format", "vin_grounding", "write_policy"]);
  });
});
