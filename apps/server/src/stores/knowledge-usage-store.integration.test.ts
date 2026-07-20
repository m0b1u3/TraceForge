import { describe, expect, it } from "vitest";
import { createDb } from "../db/client.js";
import { KnowledgeUsageStore, type KnowledgeRef } from "./knowledge-usage-store.js";

describe("KnowledgeUsageStore with real SQLite", () => {
  it("separates injected knowledge from explicit tool-input usage", () => {
    const store = new KnowledgeUsageStore(createDb(":memory:"));
    const refs: KnowledgeRef[] = [
      { id: "fact_order_idor", kind: "fact" },
      { id: "identity_alice", kind: "identity" },
    ];

    store.recordInjected("case_1", "run_1", refs);
    store.recordInjected("case_1", "run_1", refs);

    expect(store.markReferenced("case_1", "run_1", {
      evidenceRefs: ["fact_order_idor"],
      identity: "new_identity",
    }, refs)).toEqual([{ id: "fact_order_idor", kind: "fact" }]);

    store.recordOutcome("case_1", "run_1", [refs[0]], 3, 0);
    store.recordOutcome("case_1", "run_1", [refs[1]], 0, 1);

    expect(store.scores("case_1").get("fact_order_idor")).toEqual({
      injected: 2, used: 1, positiveOutcome: 3, negativeOutcome: 0,
    });
    expect(store.scores("case_1").get("identity_alice")).toEqual({
      injected: 2, used: 0, positiveOutcome: 0, negativeOutcome: 1,
    });
    expect(store.scores("case_1", "run_1").size).toBe(0);
  });

  it("does not attribute an ID that was not exposed to the current run", () => {
    const store = new KnowledgeUsageStore(createDb(":memory:"));
    const exposed: KnowledgeRef[] = [{ id: "fact_exposed", kind: "fact" }];
    store.recordInjected("case_1", "run_1", exposed);

    const matched = store.markReferenced("case_1", "run_1", {
      evidenceRefs: ["fact_not_exposed"],
    }, exposed);

    expect(matched).toEqual([]);
    expect(store.list("case_1", "run_1")[0].usedCount).toBe(0);
  });
});
