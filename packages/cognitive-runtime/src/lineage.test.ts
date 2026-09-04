import { describe, expect, it } from "vitest";
import { CONTEXT_WITHHELD_TEXT, projectRunContextLineage, type RunContextInput } from "./lineage.js";

describe("cognitive context lineage projection", () => {
  it("withholds invalid source descendants without mutating durable input", () => {
    const input = { run: { id: "run", caseId: "case", workItems: [{ id: "first", title: "secret", objective: "secret", retryOf: null }],
      outputs: [], directives: [] }, graph: { caseId: "case", nodes: [], edges: [] }, recentEvents: [{ type: "event" }] } as unknown as RunContextInput;
    const before = structuredClone(input);
    const result = projectRunContextLineage(input, { role: "planner", fingerprint: "fingerprint",
      sources: [{ key: "receipt", workId: "first", fingerprint: "source", refs: [], valid: false }], derived: [] });
    expect(result.run.workItems[0]).toMatchObject({ id: "first", title: CONTEXT_WITHHELD_TEXT, resultSummary: null });
    expect(result.recentEvents).toEqual([]);
    expect(result.manifest.contextLineage.withheldWorkIds).toEqual(["first"]);
    expect(input).toEqual(before);
  });
});
