import { describe, expect, it } from "vitest";
import { AttackPathSchema, FactSchema, IdentityContextSchema, TrafficEntrySchema } from "@traceforge/shared";
import { formatEvidenceGapPlan, mapEvidenceGaps } from "./evidence-gap-planner.js";

const now = "2026-07-20T00:00:00.000Z";
const identityA = IdentityContextSchema.parse({
  id: "identity_a", caseId: "case_1", name: "Alice", kind: "user", status: "active",
  credentials: {}, headers: {}, cookies: [], createdAt: now, updatedAt: now,
});
const identityB = IdentityContextSchema.parse({
  id: "identity_b", caseId: "case_1", name: "Bob", kind: "user", status: "active",
  credentials: {}, headers: {}, cookies: [], createdAt: now, updatedAt: now,
});
const traffic = TrafficEntrySchema.parse({
  id: "traffic_order", caseId: "case_1", identityId: "identity_a",
  url: "https://target.test/api/orders/42", method: "GET", requestHeaders: {},
  responseStatus: 200, responseBody: "{\"owner\":\"bob\"}", createdAt: now,
});
const finding = FactSchema.parse({
  id: "fact_idor", caseId: "case_1", type: "finding", title: "Order IDOR",
  value: { severity: "high", endpoint: "/api/orders/42" }, source: { type: "agent", ref: "run_1" },
  confidence: 0.8, tags: ["idor"], validity: "valid", findingStatus: "candidate",
  evidenceRefs: [], hypothesisIds: [], taskIds: [], actionIds: [], observations: [],
  createdAt: now, updatedAt: now,
});
const path = AttackPathSchema.parse({
  id: "path_order", caseId: "case_1", title: "Order access chain", objective: "Read another order",
  status: "exploring", confidence: 0.8, entryIdentityId: "identity_a", evidenceRefs: [],
  breakpoint: "Controlled cross-identity differential",
  steps: [{
    id: "step_read", order: 0, kind: "request", title: "Read foreign order", status: "observed",
    trafficId: "traffic_order", factIds: [], validation: "Bob session reads Alice order",
  }],
  createdAt: now, updatedAt: now,
});

describe("evidence gap mapping", () => {
  it("maps finding and path gaps onto real traffic and an alternate identity", () => {
    const gaps = mapEvidenceGaps({
      facts: [finding], paths: [path], traffic: [traffic], identities: [identityA, identityB],
    });
    const observation = gaps.find((gap) => gap.id === "gap:fact_idor:observation");
    expect(observation?.trafficId).toBe("traffic_order");
    expect(observation?.identityId).toBe("identity_b");
    expect(observation?.collectionMethod).toContain("replay_traffic");
    expect(gaps.some((gap) => gap.id === "gap:path_order:step_read")).toBe(true);
  });

  it("produces an execution-ready plan with explicit verification conditions", () => {
    const plan = formatEvidenceGapPlan(mapEvidenceGaps({
      facts: [finding], paths: [path], traffic: [traffic], identities: [identityA, identityB],
    }));
    expect(plan).toContain("identity=identity_b");
    expect(plan).toContain("traffic=traffic_order");
    expect(plan).toContain("Do not mark a Finding or path step verified from reasoning alone");
  });
});
