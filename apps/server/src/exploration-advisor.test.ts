import { describe, expect, it } from "vitest";
import { buildExplorationAdvisory } from "./exploration-advisor.js";

describe("exploration advisor", () => {
  it("uses outcome quality and leaves neutral exploration alone", () => {
    const lowYield = buildExplorationAdvisory({
      tool: "use_browser_identity",
      input: { identityId: "identity_old" },
      referencedKnowledge: [{ id: "identity_old", kind: "identity" }],
      usageScores: new Map([["identity_old", {
        injected: 4, used: 3, positiveOutcome: 1, negativeOutcome: 2,
      }]]),
      alternatives: [],
    });
    expect(lowYield).toContain("identity_old");

    expect(buildExplorationAdvisory({
      tool: "http_replay",
      input: { url: "/new" },
      referencedKnowledge: [],
      usageScores: new Map(),
      alternatives: [],
    })).toBeUndefined();
  });
});
