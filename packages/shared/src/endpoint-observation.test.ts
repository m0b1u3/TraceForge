import { describe, expect, it } from "vitest";
import {
  classifyEndpointObservation,
  isUnsupportedObservedEndpointFact,
  statusSupportsObservedEndpoint,
} from "./endpoint-observation.js";
import type { Fact } from "./schemas.js";

function endpointFact(sampleStatus: number): Fact {
  return {
    id: "fact_1",
    caseId: "case_1",
    sourceRunId: "run_1",
    type: "api_endpoint",
    title: "https://example.test/api/candidate",
    value: { sampleStatus },
    source: { type: "traffic", ref: "traffic_1" },
    confidence: 0.8,
    tags: ["auto-discovery"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    updateCount: 0,
    validity: "valid",
    evidenceRefs: [],
    hypothesisIds: [],
    taskIds: [],
    actionIds: [],
    observations: [],
  };
}

describe("observed endpoint evidence", () => {
  it("accepts statuses that establish a routed endpoint", () => {
    expect(statusSupportsObservedEndpoint(200)).toBe(true);
    expect(statusSupportsObservedEndpoint(302)).toBe(true);
    expect(statusSupportsObservedEndpoint(401)).toBe(true);
    expect(statusSupportsObservedEndpoint(403)).toBe(true);
    expect(statusSupportsObservedEndpoint(405)).toBe(true);
  });

  it("does not treat generic error responses as endpoint existence", () => {
    expect(statusSupportsObservedEndpoint(400)).toBe(false);
    expect(statusSupportsObservedEndpoint(404)).toBe(false);
    expect(statusSupportsObservedEndpoint(500)).toBe(false);
    expect(isUnsupportedObservedEndpointFact(endpointFact(404))).toBe(true);
  });

  it("preserves server errors as signals that still require causal validation", () => {
    expect(classifyEndpointObservation(500)).toBe("error_signal");
    expect(classifyEndpointObservation(503)).toBe("error_signal");
    expect(classifyEndpointObservation(404)).toBe("unsupported");
    expect(classifyEndpointObservation(200)).toBe("endpoint");
  });
});
