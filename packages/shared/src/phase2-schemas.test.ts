import { describe, it, expect } from "vitest";
import { FactSchema, TaskSchema, TimelineEntrySchema } from "./schemas.js";

describe("FactSchema", () => {
  it("defaults confidence to 1 and tags to []", () => {
    const f = FactSchema.parse({
      id: "fact_1", caseId: "case_1", type: "login_endpoint", title: "admin login",
      value: { url: "https://t/admin" }, source: { type: "manual", ref: "page_1" },
      createdAt: "now",
    });
    expect(f.confidence).toBe(1);
    expect(f.tags).toEqual([]);
  });

  it("rejects an unknown fact type", () => {
    expect(() =>
      FactSchema.parse({
        id: "f", caseId: "c", type: "not_a_type", title: "t",
        value: {}, source: { type: "manual", ref: "r" }, createdAt: "now",
      }),
    ).toThrow();
  });
});

describe("TaskSchema", () => {
  it("defaults status to open and priority to medium", () => {
    const t = TaskSchema.parse({
      id: "task_1", caseId: "case_1", title: "verify login",
      createdAt: "now", updatedAt: "now",
    });
    expect(t.status).toBe("open");
    expect(t.priority).toBe("medium");
    expect(t.blockedBy).toEqual([]);
  });

  it("accepts a blocked task with triggerWhen", () => {
    const t = TaskSchema.parse({
      id: "task_2", caseId: "c", title: "login", status: "blocked",
      blockedBy: ["credential"], triggerWhen: ["credential_found"],
      createdAt: "now", updatedAt: "now",
    });
    expect(t.status).toBe("blocked");
    expect(t.triggerWhen).toEqual(["credential_found"]);
  });
});

describe("TimelineEntrySchema", () => {
  it("defaults refId to null", () => {
    const e = TimelineEntrySchema.parse({
      id: "tl_1", caseId: "c", eventType: "fact_created", detail: "x", createdAt: "now",
    });
    expect(e.refId).toBeNull();
  });
});
