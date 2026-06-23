import { describe, it, expect, beforeEach } from "vitest";
import { createDb, type Db } from "../db/client.js";
import { ActionCardStore } from "./action-store.js";
import { DecisionStore } from "./decision-store.js";
import { ActionCardSchema, type ActionCard } from "@traceforge/shared";

let db: Db;
beforeEach(() => { db = createDb(":memory:"); });

function sampleAction(caseId: string): ActionCard {
  return ActionCardSchema.parse({
    id: "action_x", caseId, title: "probe", goal: "g", evidenceRefs: ["fact_1"],
    reasoning: "r", steps: ["s"], tool: "http_replay", status: "approved",
    createdAt: "now", updatedAt: "now",
  });
}

describe("ActionCardStore", () => {
  it("stores and lists action cards by case", () => {
    const store = new ActionCardStore(db);
    store.create(sampleAction("case_1"));
    expect(store.listByCase("case_1")).toHaveLength(1);
    expect(store.listByCase("other")).toHaveLength(0);
    expect(store.listByCase("case_1")[0].status).toBe("approved");
  });
});

describe("DecisionStore", () => {
  it("creates a decision with generated id and lists by case", () => {
    const store = new DecisionStore(db);
    const d = store.create("case_1", { decision: "probe", basedOn: ["fact_1"], reasoning: "r", actionRef: "action_x", newFacts: [] });
    expect(d.id).toMatch(/^decision_/);
    expect(d.actionRef).toBe("action_x");
    expect(store.listByCase("case_1")).toHaveLength(1);
  });
});
