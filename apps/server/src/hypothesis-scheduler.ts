import type { Hypothesis } from "@traceforge/shared";
import type { HypothesisStore } from "./stores/hypothesis-store.js";

export const MAX_ACTIVE_HYPOTHESES = 5;
export const HYPOTHESIS_ACTIVATION_MARGIN = 8;
export const HYPOTHESIS_MIN_RESIDENCY_MS = 2 * 60 * 1000;
export const HYPOTHESIS_FAST_TRACK_SCORE = 88;

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

export function isFastTrackHypothesis(hypothesis: Hypothesis): boolean {
  const factors = hypothesis.scoreFactors;
  if (!factors || (hypothesis.priorityScore ?? 0) < HYPOTHESIS_FAST_TRACK_SCORE) return false;
  return factors.evidenceStrength >= 85
    && (factors.impact >= 85 || factors.pathRelevance >= 85);
}

function activationStartedAt(hypothesis: Hypothesis): number | null {
  const transition = [...hypothesis.auditTrail].reverse().find((entry) =>
    entry.kind === "promoted" || (entry.kind === "created" && entry.toStatus === "active"));
  if (!transition) return null;
  const timestamp = Date.parse(transition.createdAt);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export class HypothesisScheduler {
  constructor(private hypotheses: HypothesisStore, private now: () => Date = () => new Date()) {}

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

    const currentActive = eligible.filter((item) => item.status === "active").slice(0, MAX_ACTIVE_HYPOTHESES);
    const challengers = eligible.filter((item) => item.status === "candidate");
    const selected = [...currentActive];
    const promotionReasons = new Map<string, string>();
    const fastTrackPromotions = new Set<string>();
    for (const challenger of challengers) {
      if (selected.length >= MAX_ACTIVE_HYPOTHESES) break;
      selected.push(challenger);
      promotionReasons.set(challenger.id, `Promoted into a vacant active verification slot at score ${challenger.priorityScore ?? 0}.`);
    }
    const now = this.now().getTime();
    for (const challenger of challengers.filter((item) => !selected.some((selectedItem) => selectedItem.id === item.id))) {
      const fastTrack = isFastTrackHypothesis(challenger);
      const replaceable = selected
        .filter((item) => {
          if (fastTrack) return true;
          const startedAt = activationStartedAt(item);
          return startedAt === null || now - startedAt >= HYPOTHESIS_MIN_RESIDENCY_MS;
        })
        .sort((left, right) => (left.priorityScore ?? 0) - (right.priorityScore ?? 0));
      const incumbent = replaceable[0];
      if (!incumbent) continue;
      const scoreGap = (challenger.priorityScore ?? 0) - (incumbent.priorityScore ?? 0);
      if (!fastTrack && scoreGap < HYPOTHESIS_ACTIVATION_MARGIN) continue;
      selected.splice(selected.findIndex((item) => item.id === incumbent.id), 1, challenger);
      promotionReasons.set(challenger.id, fastTrack
        ? `Fast-track promotion into the top ${MAX_ACTIVE_HYPOTHESES}: score ${challenger.priorityScore ?? 0} with strong evidence and high impact/path relevance displaced ${incumbent.id}.`
        : `Promoted after exceeding ${incumbent.id} by ${scoreGap} points, above the ${HYPOTHESIS_ACTIVATION_MARGIN}-point hysteresis margin.`);
      if (fastTrack) fastTrackPromotions.add(challenger.id);
    }
    const nextActiveIds = new Set(selected.map((item) => item.id));
    const promoted: string[] = [];
    const demoted: string[] = [];
    for (const item of eligible) {
      const nextStatus = nextActiveIds.has(item.id) ? "active" : "candidate";
      if (item.status === nextStatus) continue;
      const boundaryScore = Math.min(...selected.map((selectedItem) => selectedItem.priorityScore ?? 0));
      this.hypotheses.update(item.id, { status: nextStatus }, {
        kind: nextStatus === "active" ? "promoted" : "demoted",
        reason: nextStatus === "active"
          ? `${promotionReasons.get(item.id) ?? `Promoted into the top ${MAX_ACTIVE_HYPOTHESES} active verification slots.`} Activation boundary ${boundaryScore}.`
          : `${fastTrackPromotions.size > 0 ? "Demoted by a strong-evidence fast-track challenger" : `Demoted after falling outside the ${HYPOTHESIS_ACTIVATION_MARGIN}-point hysteresis boundary`}; score ${item.priorityScore ?? 0}, activation boundary ${boundaryScore}.`,
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
