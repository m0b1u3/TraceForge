import type { Hypothesis } from "@traceforge/shared";
import type { HypothesisStore } from "./stores/hypothesis-store.js";

export const MAX_ACTIVE_HYPOTHESES = 5;

export interface HypothesisScoreFactors {
  impact: number;
  evidenceStrength: number;
  verificationCost: number;
  operationRisk: number;
  pathRelevance: number;
  freshness: number;
}

export interface RebalanceResult {
  active: Hypothesis[];
  promoted: string[];
  demoted: string[];
  changed: boolean;
}

const DEFAULT_FACTORS: HypothesisScoreFactors = {
  impact: 50,
  evidenceStrength: 50,
  verificationCost: 50,
  operationRisk: 50,
  pathRelevance: 50,
  freshness: 50,
};

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function scoreHypothesis(factors: Partial<HypothesisScoreFactors>): number {
  const value = { ...DEFAULT_FACTORS, ...factors };
  return clamp(
    value.impact * 0.3
    + value.evidenceStrength * 0.25
    + value.pathRelevance * 0.2
    + value.freshness * 0.1
    + (100 - value.verificationCost) * 0.1
    + (100 - value.operationRisk) * 0.05,
  );
}

export class HypothesisScheduler {
  constructor(private hypotheses: HypothesisStore) {}

  rebalance(caseId: string, runId: string): RebalanceResult {
    const eligible = this.hypotheses.listByCase(caseId)
      .filter((item) => item.runId === runId && (item.status === "candidate" || item.status === "active"))
      .map((item) => {
        const priorityScore = item.scoreFactors
          ? scoreHypothesis(item.scoreFactors)
          : item.priorityScore ?? 50;
        const updated = priorityScore === item.priorityScore
          ? item
          : this.hypotheses.update(item.id, { priorityScore }, {
            kind: "scored",
            reason: `Priority recalculated from six scoring factors (${item.priorityScore ?? 50} → ${priorityScore}).`,
          }) ?? item;
        return updated;
      })
      .sort((left, right) =>
        (right.priorityScore ?? 0) - (left.priorityScore ?? 0)
        || left.createdAt.localeCompare(right.createdAt),
      );

    const nextActiveIds = new Set(eligible.slice(0, MAX_ACTIVE_HYPOTHESES).map((item) => item.id));
    const promoted: string[] = [];
    const demoted: string[] = [];
    for (const item of eligible) {
      const nextStatus = nextActiveIds.has(item.id) ? "active" : "candidate";
      if (item.status === nextStatus) continue;
      const boundaryScore = eligible[Math.min(MAX_ACTIVE_HYPOTHESES - 1, eligible.length - 1)]?.priorityScore ?? 0;
      this.hypotheses.update(item.id, { status: nextStatus }, {
        kind: nextStatus === "active" ? "promoted" : "demoted",
        reason: nextStatus === "active"
          ? `Promoted into the top ${MAX_ACTIVE_HYPOTHESES} active verification slots at score ${item.priorityScore ?? 0}; activation boundary ${boundaryScore}.`
          : `Demoted because score ${item.priorityScore ?? 0} fell outside the top ${MAX_ACTIVE_HYPOTHESES}; activation boundary ${boundaryScore}.`,
      });
      if (nextStatus === "active") promoted.push(item.id);
      else demoted.push(item.id);
    }

    const active = this.hypotheses.listByCase(caseId)
      .filter((item) => item.runId === runId && item.status === "active")
      .sort((left, right) => (right.priorityScore ?? 0) - (left.priorityScore ?? 0));
    return { active, promoted, demoted, changed: promoted.length > 0 || demoted.length > 0 };
  }
}
