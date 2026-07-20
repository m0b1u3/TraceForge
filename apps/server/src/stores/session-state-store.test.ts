import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../db/client.js";
import { SessionStateStore } from "./session-state-store.js";

let store: SessionStateStore;
beforeEach(() => { store = new SessionStateStore(createDb(":memory:")); });

describe("SessionStateStore", () => {
  it("returns undefined before any upsert", () => {
    expect(store.get("c1", "run_1")).toBeUndefined();
  });

  it("upsert creates then updates a run row", () => {
    const first = store.upsert("c1", { currentGoal: "测越权", phase: "map" }, "run_1");
    expect(first.currentGoal).toBe("测越权");
    expect(first.phase).toBe("map");
    const updated = store.upsert("c1", { focus: { host: "x.com" } }, "run_1");
    expect(updated.currentGoal).toBe("测越权");
    expect(updated.focus).toEqual({ host: "x.com" });
    expect(store.get("c1", "run_1")?.phase).toBe("map");
  });

  it("isolates state by run", () => {
    store.upsert("c1", { currentGoal: "a" }, "run_1");
    store.upsert("c1", { currentGoal: "b" }, "run_2");
    expect(store.get("c1", "run_1")?.currentGoal).toBe("a");
    expect(store.get("c1", "run_2")?.currentGoal).toBe("b");
  });
});
