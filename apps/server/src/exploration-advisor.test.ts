import { describe, expect, it } from "vitest";
import { buildExplorationAdvisory, inputSimilarity } from "./exploration-advisor.js";
import type { Fact } from "@traceforge/shared";

const failedAttempt = {
  id: "fact_failed",
  value: { tool: "http_replay", input: { method: "GET", url: "/api/orders/42", identity: "alice" } },
} as Fact;

describe("exploration advisor", () => {
  it("detects similar but not necessarily identical exploration inputs", () => {
    expect(inputSimilarity(
      { method: "GET", url: "/api/orders/42", identity: "alice" },
      { method: "GET", url: "/api/orders/42", identity: "alice", headers: {} },
    )).toBeGreaterThanOrEqual(0.72);
  });

  it("warns without blocking and includes a concrete pivot", () => {
    const advice = buildExplorationAdvisory({
      tool: "http_replay",
      input: { method: "GET", url: "/api/orders/42", identity: "alice", headers: {} },
      referencedKnowledge: [],
      usageScores: new Map(),
      failedAttempts: [failedAttempt],
      alternatives: ["Test the write-impact breakpoint on the validated order path"],
    });
    expect(advice).toContain("call is allowed");
    expect(advice).toContain("write-impact breakpoint");
  });

  it("uses outcome quality and leaves neutral exploration alone", () => {
    const lowYield = buildExplorationAdvisory({
      tool: "use_browser_identity",
      input: { identityId: "identity_old" },
      referencedKnowledge: [{ id: "identity_old", kind: "identity" }],
      usageScores: new Map([["identity_old", {
        injected: 4, used: 3, positiveOutcome: 1, negativeOutcome: 2,
      }]]),
      failedAttempts: [],
      alternatives: [],
    });
    expect(lowYield).toContain("identity_old");

    expect(buildExplorationAdvisory({
      tool: "http_replay",
      input: { url: "/new" },
      referencedKnowledge: [],
      usageScores: new Map(),
      failedAttempts: [],
      alternatives: [],
    })).toBeUndefined();
  });
});
