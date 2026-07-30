import { describe, expect, it } from "vitest";
import {
  parseObserverCorrectionAudit,
  serializeObserverCorrectionAudit,
  type ObserverCorrectionAudit,
} from "./observer-correction-audit.js";

const audit: ObserverCorrectionAudit = {
  version: 1,
  attributed: true,
  reason: "correction_linked_result",
  trigger: "interval",
  instruction: "Collect a traceable result.",
  actions: [{ tool: "analysis_tool", outcome: "succeeded", evidenceRefs: ["fact_1"] }],
  evidenceRefs: ["fact_1"],
  summary: "A changed action produced correction-linked evidence.",
};

describe("Observer correction audit", () => {
  it("round trips a versioned audit record", () => {
    expect(parseObserverCorrectionAudit(serializeObserverCorrectionAudit(audit))).toEqual(audit);
  });

  it("ignores legacy text and malformed records", () => {
    expect(parseObserverCorrectionAudit("legacy summary")).toBeNull();
    expect(parseObserverCorrectionAudit("{bad json")).toBeNull();
    expect(parseObserverCorrectionAudit(JSON.stringify({ version: 2 }))).toBeNull();
  });
});
