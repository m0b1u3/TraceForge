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

  it("returns recent event pages in conversation order", () => {
    const store = new AgentEventStore(db);
    for (const text of ["one", "two", "three", "four"]) store.append("case_1", "text", text);

    expect(store.listByCase("case_1", { limit: 2 }).map((event) => event.text)).toEqual(["three", "four"]);
    expect(store.listByCase("case_1", { limit: 2, offset: 2 }).map((event) => event.text)).toEqual(["one", "two"]);
  });

  it("persists refs and returns them on list", () => {
    const store = new AgentEventStore(db);
    const refs = { factIds: ["fact_1", "fact_2"], taskIds: ["task_1"], timelineEntryIds: ["tl_1", "tl_2", "tl_3"] };
    store.append("case_1", "tool_result", "record_fact → ok", "record_fact", undefined, refs);
    store.append("case_1", "text", "no refs here");

    const list = store.listByCase("case_1");
    expect(list[0].refs).toEqual(refs);
    expect(list[1].refs).toBeNull();
  });

  it("persists execution lifecycle and recovery across a database read", () => {
    const store = new AgentEventStore(db);
    store.append(
      "case_1", "tool_result", "exec_command → exit=1", "exec_command", undefined, undefined,
      {
        runId: "run_1",
        executionId: "exec_1",
        outcome: "failed",
        failureDiagnostic: {
          category: "command_exit",
          retryable: false,
          summary: "The command completed with a non-zero exit status.",
          recommendation: "Correct the command before retrying.",
        },
      },
    );
    store.markRecovered("case_1", ["exec_1"], "exec_2");

    const [event] = store.listByCase("case_1");
    expect(event).toEqual(expect.objectContaining({
      runId: "run_1",
      executionId: "exec_1",
      outcome: "recovered",
      recoveredByExecutionId: "exec_2",
      failureDiagnostic: expect.objectContaining({ category: "command_exit", retryable: false }),
    }));
  });
});
