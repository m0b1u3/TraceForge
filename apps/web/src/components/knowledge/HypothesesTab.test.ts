import { describe, expect, it } from "vitest";
import type { Hypothesis } from "@traceforge/shared";
import { hypothesisGroup, rankHypotheses } from "./HypothesesTab.js";

function hypothesis(id: string, status: Hypothesis["status"], priorityScore: number): Hypothesis {
  return {
    id,
    caseId: "case_1",
    runId: "run_1",
    statement: id,
    status,
    priorityScore,
    basedOnFactIds: ["fact_1"],
    relatedTaskIds: [],
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:00:00.000Z",
    updateCount: 0,
  };
}

describe("HypothesesTab ranking", () => {
  it("keeps active work ahead of candidates and resolved history", () => {
    const ranked = rankHypotheses([
      hypothesis("confirmed", "confirmed", 99),
      hypothesis("candidate-low", "candidate", 20),
      hypothesis("active", "active", 60),
      hypothesis("candidate-high", "candidate", 80),
    ]);
    expect(ranked.map((item) => item.id)).toEqual(["active", "candidate-high", "candidate-low", "confirmed"]);
  });

  it("groups terminal states as resolved", () => {
    expect(hypothesisGroup(hypothesis("refuted", "refuted", 0))).toBe("resolved");
    expect(hypothesisGroup(hypothesis("archived", "archived", 0))).toBe("resolved");
  });
});
