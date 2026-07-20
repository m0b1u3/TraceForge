import { describe, expect, it } from "vitest";
import { TrafficEntrySchema } from "@traceforge/shared";
import { assessValidationExperiment } from "./validation-tools.js";

const now = "2026-07-20T00:00:00.000Z";
const traffic = (id: string, method: string, status: number, body: string) => TrafficEntrySchema.parse({
  id, caseId: "case_1", url: "https://target.test/api/orders/42", method,
  requestHeaders: {}, responseStatus: status, responseBody: body, responseSize: body.length, createdAt: now,
});

describe("validation experiment assessment", () => {
  it("supports exposure from matching protected fields, not HTTP 200 alone", () => {
    const baseline = traffic("base", "GET", 200, JSON.stringify({ order: { id: 42, owner: "alice", secret: "x" } }));
    const exposed = traffic("variant", "GET", 200, JSON.stringify({ order: { id: 42, owner: "alice", secret: "x" } }));
    const ambiguous = traffic("ambiguous", "GET", 200, JSON.stringify({ ok: true }));

    expect(assessValidationExperiment({
      baseline, variant: exposed, protectedFields: ["order.id", "order.secret"],
    }).verdict).toBe("supports");
    expect(assessValidationExperiment({ baseline, variant: ambiguous }).verdict).toBe("inconclusive");
  });

  it("refutes exposure when the identity variant is denied", () => {
    const result = assessValidationExperiment({
      baseline: traffic("base", "GET", 200, "{\"secret\":\"x\"}"),
      variant: traffic("variant", "GET", 403, "{\"error\":\"forbidden\"}"),
      protectedFields: ["secret"],
    });
    expect(result.verdict).toBe("refutes");
    expect(result.confidence).toBeGreaterThan(0.8);
  });

  it("requires business-state confirmation for mutations", () => {
    const baseline = traffic("base", "PATCH", 200, "{\"accepted\":true}");
    const variant = traffic("variant", "PATCH", 200, "{\"accepted\":true}");
    expect(assessValidationExperiment({ baseline, variant }).verdict).toBe("inconclusive");

    const confirmed = assessValidationExperiment({
      baseline,
      variant,
      confirmation: traffic("confirm", "GET", 200, "{\"order\":{\"status\":\"cancelled\"}}"),
      expectedBusinessState: { "order.status": "cancelled" },
    });
    expect(confirmed.verdict).toBe("supports");
  });
});
