import { describe, it, expect } from "vitest";
import { FactSchema, TaskSchema } from "./schemas.js";
import type { RuntimeEvent } from "./events.js";

describe("realtime entity fields", () => {
  it("Fact defaults updateCount=0, validity=valid, updatedAt=''", () => {
    const f = FactSchema.parse({
      id: "f1", caseId: "c", type: "endpoint", title: "t", value: {},
      source: { type: "ai", ref: "x" }, createdAt: "t0",
    });
    expect(f.updateCount).toBe(0);
    expect(f.validity).toBe("valid");
    expect(f.updatedAt).toBe("");
  });

  it("Fact rejects an invalid validity", () => {
    expect(FactSchema.safeParse({
      id: "f1", caseId: "c", type: "x", title: "t", value: {},
      source: { type: "ai", ref: "x" }, createdAt: "t0", validity: "bogus",
    }).success).toBe(false);
  });

  it("Task defaults updateCount=0", () => {
    const t = TaskSchema.parse({ id: "t1", caseId: "c", title: "t", createdAt: "t0", updatedAt: "t0" });
    expect(t.updateCount).toBe(0);
  });

  it("accepts fact_updated event", () => {
    const f = FactSchema.parse({ id: "f1", caseId: "c", type: "x", title: "t", value: {}, source: { type: "ai", ref: "" }, createdAt: "t0" });
    const e: RuntimeEvent = { type: "fact_updated", fact: f };
    expect(e.type).toBe("fact_updated");
  });
});
