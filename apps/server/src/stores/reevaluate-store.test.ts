import { describe, it, expect } from "vitest";
import { createDb } from "../db/client.js";
import { TaskStore } from "./task-store.js";

describe("TaskStore.getById", () => {
  it("returns a created task by id and undefined for a missing one", () => {
    const store = new TaskStore(createDb(":memory:"));
    const t = store.create("c", { title: "t", status: "blocked", reason: "", blockedBy: [], triggerWhen: [], relatedFacts: [], priority: "medium" });
    expect(store.getById(t.id)?.title).toBe("t");
    expect(store.getById("nope")).toBeUndefined();
  });
});
