import { describe, it, expect } from "vitest";
import { SessionStateSchema, HypothesisSchema, ContextSummarySchema } from "./schemas.js";

describe("SessionStateSchema", () => {
  it("parses with defaults and closed phase enum", () => {
    const s = SessionStateSchema.parse({ caseId: "c1", updatedAt: "t" });
    expect(s.phase).toBe("recon");
    expect(s.currentGoal).toBe("");
    expect(s.focus).toEqual({});
    expect(s.activeHypothesisIds).toEqual([]);
  });
  it("rejects invalid phase", () => {
    expect(() => SessionStateSchema.parse({ caseId: "c1", phase: "hacking", updatedAt: "t" })).toThrow();
  });
});

describe("HypothesisSchema", () => {
  it("parses with defaults", () => {
    const h = HypothesisSchema.parse({ id: "h1", caseId: "c1", statement: "可能越权", basedOnFactIds: ["f1"], createdAt: "t", updatedAt: "t" });
    expect(h.status).toBe("open");
    expect(h.relatedTaskIds).toEqual([]);
    expect(h.updateCount).toBe(0);
  });
  it("rejects invalid status", () => {
    expect(() => HypothesisSchema.parse({ id: "h1", caseId: "c1", statement: "x", basedOnFactIds: ["f1"], status: "maybe", createdAt: "t", updatedAt: "t" })).toThrow();
  });
});

describe("ContextSummarySchema", () => {
  it("parses", () => {
    const s = ContextSummarySchema.parse({ id: "s1", caseId: "c1", coversUpToEventSeq: 5, content: "x", createdAt: "t" });
    expect(s.coversUpToEventSeq).toBe(5);
  });
});
