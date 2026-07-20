import { describe, expect, it } from "vitest";
import { IdentityContextSchema, TrafficEntrySchema } from "@traceforge/shared";
import { buildValidationMatrices, formatValidationMatrices } from "./validation-matrix.js";
import type { EvidenceGap } from "./evidence-gap-planner.js";

const now = "2026-07-20T00:00:00.000Z";
const identities = [
  IdentityContextSchema.parse({
    id: "identity_alice", caseId: "case_1", name: "Alice", kind: "user", status: "active",
    credentials: {}, headers: {}, cookies: [], createdAt: now, updatedAt: now,
  }),
  IdentityContextSchema.parse({
    id: "identity_bob", caseId: "case_1", name: "Bob", kind: "user", status: "active",
    credentials: {}, headers: {}, cookies: [], createdAt: now, updatedAt: now,
  }),
];
const readTraffic = TrafficEntrySchema.parse({
  id: "traffic_read", caseId: "case_1", identityId: "identity_alice",
  url: "https://target.test/api/orders/42", method: "GET", requestHeaders: {},
  responseStatus: 200, responseBody: "{}", createdAt: now,
});
const writeTraffic = TrafficEntrySchema.parse({
  id: "traffic_write", caseId: "case_1", identityId: "identity_alice",
  url: "https://target.test/api/orders/42", method: "PATCH", requestHeaders: {},
  requestBody: "{\"status\":\"cancelled\"}", responseStatus: 200, responseBody: "{}", createdAt: now,
});
const gap = (trafficId: string): EvidenceGap => ({
  id: `gap:${trafficId}`, source: "finding", sourceId: "fact_idor",
  requirement: "Controlled identity observation", collectionMethod: "replay_traffic with an alternate identity",
  identityId: "identity_bob", trafficId, validationCondition: "compare ownership enforcement", score: 90,
});

describe("minimal validation matrix", () => {
  it("changes only identity between baseline and variant", () => {
    const matrix = buildValidationMatrices({
      gaps: [gap("traffic_read")], traffic: [readTraffic], identities,
    })[0];
    expect(matrix.experiments).toHaveLength(2);
    expect(matrix.experiments[0].identityId).toBe("identity_alice");
    expect(matrix.experiments[1].identityId).toBe("identity_bob");
    expect(matrix.experiments[1].changedVariable).toContain("identity only");
    expect(matrix.experiments.every((experiment) => experiment.trafficId === "traffic_read")).toBe(true);
  });

  it("marks an existing mutation as approval-required without inventing extra variants", () => {
    const matrices = buildValidationMatrices({
      gaps: [gap("traffic_write")], traffic: [writeTraffic], identities,
    });
    expect(matrices[0].experiments).toHaveLength(2);
    expect(matrices[0].experiments.every((experiment) => experiment.requiresApproval)).toBe(true);
    const plan = formatValidationMatrices(matrices);
    expect(plan).toContain("Do not expand into brute-force permutations");
    expect(plan).toContain("Stop after one controlled baseline mutation");
  });

  it("does not create network experiments for documentation-only gaps", () => {
    expect(buildValidationMatrices({
      gaps: [{ ...gap("traffic_read"), collectionMethod: "record_fact update" }],
      traffic: [readTraffic],
      identities,
    })).toEqual([]);
  });
});
