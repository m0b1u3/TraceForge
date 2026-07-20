import { describe, it, expect, beforeEach } from "vitest";
import { createDb } from "../db/client.js";
import { SessionStateStore } from "./session-state-store.js";

let store: SessionStateStore;
beforeEach(() => { store = new SessionStateStore(createDb(":memory:")); });

describe("SessionStateStore", () => {
  it("returns undefined before any upsert", () => {
    expect(store.get("c1")).toBeUndefined();
  });
  it("upsert creates then updates the single row", () => {
    const a = store.upsert("c1", { currentGoal: "测越权", phase: "analyze" });
    expect(a.currentGoal).toBe("测越权");
    expect(a.phase).toBe("analyze");
    const b = store.upsert("c1", { focus: { host: "x.com" } });
    expect(b.currentGoal).toBe("测越权"); // 保留旧值
    expect(b.focus).toEqual({ host: "x.com" });
    expect(store.get("c1")?.phase).toBe("map");
  });
  it("isolates by case", () => {
    store.upsert("c1", { currentGoal: "a" });
    expect(store.get("c2")).toBeUndefined();
  });
});
