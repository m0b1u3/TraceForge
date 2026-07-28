import { describe, expect, it } from "vitest";
import { createDb } from "./db/client.js";
import { reconcileUnsupportedEndpointFacts } from "./endpoint-fact-reconciliation.js";
import { FactStore } from "./stores/fact-store.js";
import { TimelineStore } from "./stores/timeline-store.js";

describe("endpoint Fact reconciliation with real SQLite", () => {
  it("supersedes unsupported observations, preserves endpoints, and retains server-error signals", () => {
    const db = createDb(":memory:");
    const facts = new FactStore(db);
    const timeline = new TimelineStore(db);
    const rejected = facts.create("case_1", {
      sourceRunId: "run_1",
      type: "api_endpoint",
      title: "https://example.test/api/first-candidate",
      value: { method: "GET", sampleStatus: 404 },
      source: { type: "traffic", ref: "traffic_1" },
      confidence: 0.8,
      tags: ["auto-discovery"],
    });
    const supported = facts.create("case_1", {
      sourceRunId: "run_1",
      type: "api_endpoint",
      title: "https://example.test/api/observed",
      value: { method: "GET", sampleStatus: 200 },
      source: { type: "traffic", ref: "traffic_2" },
      confidence: 0.8,
      tags: ["auto-discovery"],
    });
    const serverError = facts.create("case_1", {
      sourceRunId: "run_1",
      type: "api_endpoint",
      title: "https://example.test/api/error-signal",
      value: { method: "GET", sampleStatus: 500 },
      source: { type: "traffic", ref: "traffic_3" },
      confidence: 0.8,
      tags: ["auto-discovery"],
    });

    const result = reconcileUnsupportedEndpointFacts("case_1", facts, timeline);

    expect(result.facts.map((fact) => fact.id)).toEqual([rejected.id, serverError.id]);
    expect(facts.getById(rejected.id)?.validity).toBe("superseded");
    expect(facts.getById(supported.id)?.validity).toBe("valid");
    expect(facts.getById(serverError.id)).toMatchObject({
      type: "http_error_signal",
      validity: "valid",
      confidence: 0.5,
    });
    expect(facts.getById(serverError.id)?.tags).toEqual(expect.arrayContaining(["error-signal", "requires-validation"]));
    expect(result.timelineEntries).toHaveLength(2);
  });
});
