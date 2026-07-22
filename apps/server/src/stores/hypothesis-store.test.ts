import { describe, it, expect, beforeEach } from "vitest";
import { createDb } from "../db/client.js";
import { HypothesisStore } from "./hypothesis-store.js";

let store: HypothesisStore;
beforeEach(() => { store = new HypothesisStore(createDb(":memory:")); });

describe("HypothesisStore", () => {
  it("create assigns id, defaults status candidate + updateCount 0", () => {
    const h = store.create("c1", { statement: "越权", basedOnFactIds: ["f1"] });
    expect(h.id).toMatch(/^hyp_/);
    expect(h.status).toBe("candidate");
    expect(h.updateCount).toBe(0);
    expect(store.getById(h.id)?.statement).toBe("越权");
  });
  it("update changes status and bumps updateCount", () => {
    const h = store.create("c1", { statement: "x", basedOnFactIds: ["f1"] });
    const u = store.update(h.id, { status: "confirmed" });
    expect(u?.status).toBe("confirmed");
    expect(u?.updateCount).toBe(1);
    expect(u?.auditTrail.map((entry) => entry.kind)).toEqual(["created", "confirmed"]);
  });
  it("persists transition reasons and emits lifecycle events", () => {
    const events: import("@traceforge/shared").RuntimeEvent[] = [];
    const eventStore = new HypothesisStore(createDb(":memory:"), (event) => events.push(event));
    const h = eventStore.create("c1", { statement: "Evidence-backed path", basedOnFactIds: ["f1"], reason: "Observed an object identifier." });
    const updated = eventStore.update(h.id, { status: "active", priorityScore: 82 }, { kind: "promoted", reason: "Entered top five.", evidenceFactIds: ["f1"] });
    expect(updated?.auditTrail.at(-1)).toMatchObject({ kind: "promoted", reason: "Entered top five.", previousScore: 50, nextScore: 82, evidenceFactIds: ["f1"] });
    expect(eventStore.getById(h.id)?.auditTrail).toHaveLength(2);
    expect(events.map((event) => event.type)).toEqual(["hypothesis_created", "hypothesis_updated"]);
  });
  it("listByCase isolates", () => {
    store.create("c1", { statement: "a", basedOnFactIds: ["f1"] });
    store.create("c2", { statement: "b", basedOnFactIds: ["f2"] });
    expect(store.listByCase("c1")).toHaveLength(1);
  });
});
