import { describe, expect, it } from "vitest";
import type { Hypothesis } from "@traceforge/shared";
import { HYPOTHESIS_MIN_RESIDENCY_MS } from "@traceforge/shared";
import { getHypothesisScheduleState, hypothesisGroup, rankHypotheses } from "./HypothesesTab.js";

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
    auditTrail: [],
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

describe("HypothesesTab scheduling explanation", () => {
  it("explains the score gap without inventing scheduler state", () => {
    const active = Array.from({ length: 5 }, (_, index) => hypothesis(`active-${index}`, "active", 70 + index));
    const candidate = hypothesis("candidate", "candidate", 75);
    expect(getHypothesisScheduleState(candidate, [...active, candidate], Date.now())).toMatchObject({
      kind: "waiting",
      boundaryScore: 70,
      pointsNeeded: 3,
      label: "Needs +3",
    });
  });

  it("derives active residency protection from the persisted promotion audit", () => {
    const now = Date.parse("2026-07-22T00:01:00.000Z");
    const active = hypothesis("active", "active", 80);
    active.auditTrail = [{
      id: "transition-1",
      kind: "promoted",
      fromStatus: "candidate",
      toStatus: "active",
      previousScore: 70,
      nextScore: 80,
      reason: "Promoted after clearing the activation margin.",
      evidenceFactIds: [],
      createdAt: "2026-07-22T00:00:00.000Z",
    }];
    const state = getHypothesisScheduleState(active, [active], now);
    expect(state.kind).toBe("protected");
    expect(state.residencyRemainingMs).toBe(HYPOTHESIS_MIN_RESIDENCY_MS - 60_000);
  });
});
