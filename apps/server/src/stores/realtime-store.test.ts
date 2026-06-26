import { describe, it, expect } from "vitest";
import { createDb } from "../db/client.js";
import { FactStore } from "./fact-store.js";
import { TaskStore } from "./task-store.js";

describe("FactStore getById/update", () => {
  it("creates with updateCount=0, updates bumps count + updatedAt + fields", () => {
    const s = new FactStore(createDb(":memory:"));
    const f = s.create("c", { type: "endpoint", title: "a", value: {}, source: { type: "ai", ref: "" }, confidence: 1, tags: [] });
    expect(f.updateCount).toBe(0);
    expect(s.getById(f.id)?.title).toBe("a");
    const u = s.update(f.id, { title: "b", confidence: 0.5, validity: "superseded" });
    expect(u?.title).toBe("b");
    expect(u?.confidence).toBe(0.5);
    expect(u?.validity).toBe("superseded");
    expect(u?.updateCount).toBe(1);
    expect(u?.updatedAt).not.toBe("");
    expect(s.getById(f.id)?.updateCount).toBe(1);
  });
  it("update returns undefined for a missing id", () => {
    const s = new FactStore(createDb(":memory:"));
    expect(s.update("nope", { title: "x" })).toBeUndefined();
    expect(s.getById("nope")).toBeUndefined();
  });
});

describe("TaskStore update", () => {
  it("update bumps updateCount + updatedAt + fields", () => {
    const s = new TaskStore(createDb(":memory:"));
    const t = s.create("c", { title: "a", status: "open", reason: "", blockedBy: [], triggerWhen: [], relatedFacts: [], priority: "medium" });
    const u = s.update(t.id, { title: "b", status: "blocked" });
    expect(u?.title).toBe("b");
    expect(u?.status).toBe("blocked");
    expect(u?.updateCount).toBe(1);
    expect(s.update("nope", { title: "x" })).toBeUndefined();
  });
});
