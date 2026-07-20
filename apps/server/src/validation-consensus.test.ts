import { describe, expect, it } from "vitest";
import { TrafficEntrySchema } from "@traceforge/shared";
import type { ValidationConclusion } from "./stores/validation-conclusion-store.js";
import { evaluateValidationConsensus } from "./validation-consensus.js";

const now = "2026-07-20T00:00:00.000Z";
const traffic = (id: string, parentTrafficId: string, identityId: string) => TrafficEntrySchema.parse({
  id, caseId: "case_1", runId: "run_1", identityId, parentTrafficId,
  url: "https://target.test/api/orders/42", method: "GET", requestHeaders: {},
  responseStatus: 200, responseBody: "{\"secret\":\"x\"}", createdAt: now,
});
const conclusion = (
  id: string,
  runId: string,
  variantTrafficId: string,
  identityId: string,
  verdict: "supports" | "refutes" | "inconclusive" = "supports",
): ValidationConclusion => ({
  id, caseId: "case_1", runId, findingId: "fact_idor", gapId: "gap:idor",
  verdict, confidence: verdict === "supports" ? 0.95 : verdict === "refutes" ? 0.9 : 0.4,
  baselineTrafficId: "baseline", variantTrafficId, confirmationTrafficId: null,
  identityId,
  assessment: {
    verdict,
    confidence: verdict === "supports" ? 0.95 : verdict === "refutes" ? 0.9 : 0.4,
    signals: [], missingEvidence: [],
    metrics: { statusChanged: false, lengthDelta: 0, structureSimilarity: 1, scalarOverlap: 1 },
  },
  createdAt: now,
});

describe("validation consensus", () => {
  it("excludes repeated conclusions from the same run, identity, and source request", () => {
    const entries = [
      traffic("variant_1", "source_order", "bob"),
      traffic("variant_repeat", "source_order", "bob"),
    ];
    const result = evaluateValidationConsensus({
      findingId: "fact_idor",
      conclusions: [
        conclusion("c1", "run_1", "variant_1", "bob"),
        conclusion("c2", "run_1", "variant_repeat", "bob"),
      ],
      traffic: entries,
    });
    expect(result.status).toBe("insufficient");
    expect(result.independentSupports).toBe(1);
    expect(result.duplicatesExcluded).toBe(1);
  });

  it("recommends verified only after two independent supporting groups", () => {
    const result = evaluateValidationConsensus({
      findingId: "fact_idor",
      conclusions: [
        conclusion("c1", "run_1", "variant_1", "bob"),
        conclusion("c2", "run_2", "variant_2", "bob"),
      ],
      traffic: [
        traffic("variant_1", "source_order", "bob"),
        traffic("variant_2", "source_order", "bob"),
      ],
    });
    expect(result.status).toBe("supported");
    expect(result.recommendation).toBe("mark_verified");
  });

  it("marks mixed independent support and refutation as conflicted", () => {
    const result = evaluateValidationConsensus({
      findingId: "fact_idor",
      conclusions: [
        conclusion("c1", "run_1", "variant_1", "bob", "supports"),
        conclusion("c2", "run_2", "variant_2", "bob", "refutes"),
      ],
      traffic: [
        traffic("variant_1", "source_order", "bob"),
        traffic("variant_2", "source_order", "bob"),
      ],
    });
    expect(result.status).toBe("conflicted");
    expect(result.recommendation).toBe("keep_needs_review");
  });

  it("treats disagreement inside the same evidence group as conflict rather than a duplicate", () => {
    const result = evaluateValidationConsensus({
      findingId: "fact_idor",
      conclusions: [
        conclusion("c1", "run_1", "variant_1", "bob", "supports"),
        conclusion("c2", "run_1", "variant_repeat", "bob", "refutes"),
      ],
      traffic: [
        traffic("variant_1", "source_order", "bob"),
        traffic("variant_repeat", "source_order", "bob"),
      ],
    });
    expect(result.status).toBe("conflicted");
    expect(result.duplicatesExcluded).toBe(0);
  });
});
