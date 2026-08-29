import { describe, expect, it } from "vitest";
import { createToolProviderDiagnostic, diagnosticPublicMessage } from "./tool-provider-diagnostics.js";

describe("Tool Provider diagnostics", () => {
  it("bounds public summaries and raw detail independently", () => {
    const record = createToolProviderDiagnostic({
      id: "diagnostic-1", category: "remote_error", summary: "first\ncandidate\tfailed".repeat(20),
      detail: "secret-value-".repeat(100), maximumSummaryCharacters: 40, maximumDetailBytes: 64,
      now: new Date("2026-08-29T07:00:00.000Z"),
    });
    expect(record.summary).toHaveLength(40);
    expect(record.summary).not.toMatch(/[\n\t]/);
    expect(record.detailBytes).toBeLessThanOrEqual(64);
    expect(record.omittedDetailBytes).toBeGreaterThan(0);
    expect(diagnosticPublicMessage(record)).not.toContain("secret-value");
    expect(diagnosticPublicMessage(record)).toContain("diagnostic-1");
  });
});
