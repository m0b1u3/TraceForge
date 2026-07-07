import { describe, it, expect, beforeEach } from "vitest";
import { createDb, type Db } from "../db/client.js";
import { AgentEventStore } from "./agent-event-store.js";

let db: Db;
beforeEach(() => { db = createDb(":memory:"); });

describe("AgentEventStore", () => {
  it("appends an event with a generated id and lists by case in order", () => {
    const store = new AgentEventStore(db);
    const a = store.append("case_1", "started", "Started: 找接口");
    const b = store.append("case_1", "tool_call", "record_fact(...)", "record_fact");
    expect(a.id).toMatch(/^ae_/);
    expect(a.tool).toBeNull();
    expect(b.tool).toBe("record_fact");

    const list = store.listByCase("case_1");
    expect(list.map((e) => e.kind)).toEqual(["started", "tool_call"]);
  });

  it("isolates events by case_id", () => {
    const store = new AgentEventStore(db);
    store.append("case_1", "text", "a");
    store.append("case_2", "text", "b");
    expect(store.listByCase("case_1")).toHaveLength(1);
    expect(store.listByCase("case_2")).toHaveLength(1);
    expect(store.listByCase("other")).toHaveLength(0);
  });
});
