import { describe, expect, it } from "vitest";
import { CONTEXT_WITHHELD_TEXT, projectRunContextLineage, type RunContextInput } from "./lineage.js";

describe("cognitive context lineage projection", () => {
  it("retains long-run provenance beyond 256 entries and rejects oversized metadata", () => {
    const input = { run: { id: "run", caseId: "case", workItems: [{ id: "first", title: "Original", objective: "Continue" }], outputs: [], directives: [] },
      graph: { caseId: "case", nodes: [], edges: [] }, recentEvents: [] } as unknown as RunContextInput;
    const sources = Array.from({ length: 300 }, (_, i) => ({ key: `source-${i}`, workId: "first", fingerprint: "digest", refs: [], valid: i !== 0 }));
    const facts = { role: "worker" as const, fingerprint: "current", sources,
      derived: [{ target_kind: "work" as const, target_id: "first", snapshot_id: "snapshot", sources_json: JSON.stringify(sources.map(source => source.key)) }] };
    expect(projectRunContextLineage(input, facts).manifest.contextLineage.withheldWorkIds).toEqual(["first"]);
    expect(() => projectRunContextLineage(input, { ...facts, sources: [{ ...sources[0], fingerprint: "x".repeat(262144) }] })).toThrow("bounds");
  });
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
