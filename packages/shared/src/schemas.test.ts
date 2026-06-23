import { describe, it, expect } from "vitest";
import { ScopeRuleSchema, CaseSchema, TrafficEntrySchema } from "./schemas.js";

describe("ScopeRuleSchema", () => {
  it("accepts a valid scope rule", () => {
    const rule = { caseId: "case_1", allowHosts: ["example.com"], denyHosts: [] };
    expect(ScopeRuleSchema.parse(rule)).toEqual(rule);
  });

  it("rejects a rule missing allowHosts", () => {
    expect(() => ScopeRuleSchema.parse({ caseId: "case_1", denyHosts: [] })).toThrow();
  });
});

describe("CaseSchema", () => {
  it("defaults status to active", () => {
    const c = CaseSchema.parse({
      id: "case_1",
      name: "demo",
      scopeRules: [],
      createdAt: "2026-06-23T00:00:00Z",
    });
    expect(c.status).toBe("active");
  });
});

describe("TrafficEntrySchema", () => {
  it("requires caseId", () => {
    expect(() =>
      TrafficEntrySchema.parse({ id: "t1", url: "http://x", method: "GET", createdAt: "now" }),
    ).toThrow();
  });
});
