import { describe, it, expect } from "vitest";
import { ActionCardSchema, DecisionSchema } from "./schemas.js";

describe("ActionCardSchema", () => {
  it("defaults status/priority/requiresHumanApproval and array fields", () => {
    const a = ActionCardSchema.parse({
      id: "action_1", caseId: "case_1", title: "SQLi minimal probe", goal: "check injection",
      evidenceRefs: ["fact_1"], reasoning: "id looks like a db param",
      steps: ["baseline", "append quote"], tool: "http_replay",
      createdAt: "now", updatedAt: "now",
    });
    expect(a.status).toBe("proposed");
    expect(a.priority).toBe("medium");
    expect(a.requiresHumanApproval).toBe(true);
    expect(a.hypothesisRefs).toEqual([]);
    expect(a.riskNotes).toEqual([]);
  });

  it("rejects an unknown tool", () => {
    expect(() =>
      ActionCardSchema.parse({
        id: "a", caseId: "c", title: "t", goal: "g", evidenceRefs: ["f"], reasoning: "r",
        steps: [], tool: "nuke", createdAt: "now", updatedAt: "now",
      }),
    ).toThrow();
  });
});

describe("DecisionSchema", () => {
  it("defaults actionRef/result to null and newFacts to []", () => {
    const d = DecisionSchema.parse({
      id: "decision_1", caseId: "case_1", decision: "probe SQLi",
      basedOn: ["fact_1"], reasoning: "evidence supports it", createdAt: "now",
    });
    expect(d.actionRef).toBeNull();
    expect(d.result).toBeNull();
    expect(d.newFacts).toEqual([]);
  });
});
