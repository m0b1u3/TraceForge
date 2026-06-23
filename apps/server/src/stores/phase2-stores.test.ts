import { describe, it, expect, beforeEach } from "vitest";
import { createDb, type Db } from "../db/client.js";
import { FactStore } from "./fact-store.js";
import { TaskStore } from "./task-store.js";
import { TimelineStore } from "./timeline-store.js";

let db: Db;
beforeEach(() => { db = createDb(":memory:"); });

describe("FactStore", () => {
  it("creates a fact with generated id and lists it by case", () => {
    const store = new FactStore(db);
    const f = store.create("case_1", {
      type: "login_endpoint", title: "admin login",
      value: { url: "https://t/admin" }, source: { type: "manual", ref: "page_1" },
      confidence: 1, tags: ["auth"],
    });
    expect(f.id).toMatch(/^fact_/);
    expect(f.caseId).toBe("case_1");
    const list = store.listByCase("case_1");
    expect(list).toHaveLength(1);
    expect(list[0].tags).toEqual(["auth"]);
    expect(store.listByCase("other")).toHaveLength(0);
  });
});

describe("TaskStore", () => {
  it("creates a blocked task and updates its status", () => {
    const store = new TaskStore(db);
    const t = store.create("case_1", {
      title: "verify login", status: "blocked", reason: "no creds",
      blockedBy: ["credential"], triggerWhen: ["credential_found"],
      relatedFacts: [], priority: "medium",
    });
    expect(t.id).toMatch(/^task_/);
    expect(t.status).toBe("blocked");
    const updated = store.updateStatus(t.id, "recheck_candidate", "creds found");
    expect(updated?.status).toBe("recheck_candidate");
    expect(updated?.reason).toBe("creds found");
    expect(store.listByCase("case_1")[0].status).toBe("recheck_candidate");
  });

  it("returns undefined when updating a missing task", () => {
    const store = new TaskStore(db);
    expect(store.updateStatus("nope", "done")).toBeUndefined();
  });
});

describe("TimelineStore", () => {
  it("appends and lists entries in chronological order, scoped by case", () => {
    const store = new TimelineStore(db);
    store.append("case_1", "fact_created", "added fact A", "fact_a");
    store.append("case_1", "task_created", "added task B");
    store.append("other", "fact_created", "noise");
    const list = store.listByCase("case_1");
    expect(list).toHaveLength(2);
    expect(list[0].eventType).toBe("fact_created");
    expect(list[0].refId).toBe("fact_a");
    expect(list[1].refId).toBeNull();
  });
});
