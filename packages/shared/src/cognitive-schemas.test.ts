import { describe, it, expect } from "vitest";
import { SessionStateSchema } from "./schemas.js";

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
