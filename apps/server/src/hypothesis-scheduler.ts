import {
  HYPOTHESIS_ACTIVATION_MARGIN,
  HYPOTHESIS_MIN_RESIDENCY_MS,
  getAdaptiveHypothesisCapacity,
  getHypothesisRelationshipDecision,
  hypothesisActivationStartedAt,
  isFastTrackHypothesis,
  type Hypothesis,
} from "@traceforge/shared";
import type { HypothesisStore } from "./stores/hypothesis-store.js";
import type { TaskStore } from "./stores/task-store.js";

export {
  HYPOTHESIS_ACTIVATION_MARGIN,
  HYPOTHESIS_FAST_TRACK_SCORE,
  HYPOTHESIS_MIN_RESIDENCY_MS,
  MAX_ACTIVE_HYPOTHESES,
  isFastTrackHypothesis,
} from "@traceforge/shared";

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
  capacity: number;
  capacityReason: string;
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
  constructor(
    private hypotheses: HypothesisStore,
    private options: { tasks?: Pick<TaskStore, "listByCase">; now?: () => Date } = {},
  ) {}

  rebalance(caseId: string, runId: string): RebalanceResult {
    const runPool = this.hypotheses.listByCase(caseId).filter((item) => item.runId === runId);
    const eligible = runPool
      .filter((item) => item.status === "candidate" || item.status === "active")
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

    const capacityDecision = getAdaptiveHypothesisCapacity(
      eligible,
      this.options.tasks?.listByCase(caseId) ?? [],
      runId,
    );
    const activeCapacity = capacityDecision.capacity;
    const effectiveScore = new Map(eligible.map((item) => [
      item.id,
      Math.min(100, (item.priorityScore ?? 0) + getHypothesisRelationshipDecision(item, runPool).supportBonus),
    ]));
    eligible.sort((left, right) =>
      (effectiveScore.get(right.id) ?? 0) - (effectiveScore.get(left.id) ?? 0)
      || left.createdAt.localeCompare(right.createdAt));
    const currentActive: Hypothesis[] = [];
    const relationshipBlockedIds = new Set<string>();
    for (const item of eligible.filter((candidate) => candidate.status === "active")) {
      if (currentActive.length >= activeCapacity) break;
      const decision = getHypothesisRelationshipDecision(item, runPool, currentActive.map((active) => active.id));
      if (!decision.activationAllowed) {
        relationshipBlockedIds.add(item.id);
        continue;
      }
      currentActive.push(item);
    }
    const challengers = eligible.filter((item) => item.status === "candidate");
    const selected = [...currentActive];
    const promotionReasons = new Map<string, string>();
    const fastTrackPromotions = new Set<string>();
    for (const challenger of challengers) {
      if (selected.length >= activeCapacity) break;
      const relationship = getHypothesisRelationshipDecision(challenger, runPool, selected.map((item) => item.id));
      if (!relationship.activationAllowed) {
        relationshipBlockedIds.add(challenger.id);
        continue;
      }
      selected.push(challenger);
      promotionReasons.set(challenger.id, `Promoted into a vacant active verification slot at effective score ${effectiveScore.get(challenger.id) ?? 0}.`);
    }
    const now = (this.options.now?.() ?? new Date()).getTime();
    for (const challenger of challengers.filter((item) => !selected.some((selectedItem) => selectedItem.id === item.id))) {
      const fastTrack = isFastTrackHypothesis(challenger);
      const replaceable = selected
        .filter((item) => {
          const remainingIds = selected.filter((selectedItem) => selectedItem.id !== item.id).map((selectedItem) => selectedItem.id);
          if (!getHypothesisRelationshipDecision(challenger, runPool, remainingIds).activationAllowed) return false;
          if (fastTrack) return true;
          const startedAt = hypothesisActivationStartedAt(item);
          return startedAt === null || now - startedAt >= HYPOTHESIS_MIN_RESIDENCY_MS;
        })
        .sort((left, right) => (effectiveScore.get(left.id) ?? 0) - (effectiveScore.get(right.id) ?? 0));
      const incumbent = replaceable[0];
      if (!incumbent) {
        const relationship = getHypothesisRelationshipDecision(challenger, runPool, selected.map((item) => item.id));
        if (!relationship.activationAllowed) relationshipBlockedIds.add(challenger.id);
        continue;
      }
      const scoreGap = (effectiveScore.get(challenger.id) ?? 0) - (effectiveScore.get(incumbent.id) ?? 0);
      if (!fastTrack && scoreGap < HYPOTHESIS_ACTIVATION_MARGIN) continue;
      selected.splice(selected.findIndex((item) => item.id === incumbent.id), 1, challenger);
      promotionReasons.set(challenger.id, fastTrack
        ? `Fast-track promotion into the ${activeCapacity}-slot active set: effective score ${effectiveScore.get(challenger.id) ?? 0} with strong evidence and high impact/path relevance displaced ${incumbent.id}.`
        : `Promoted after exceeding ${incumbent.id} by ${scoreGap} points, above the ${HYPOTHESIS_ACTIVATION_MARGIN}-point hysteresis margin.`);
      if (fastTrack) fastTrackPromotions.add(challenger.id);
    }
    const nextActiveIds = new Set(selected.map((item) => item.id));
    for (const item of eligible) {
      const relationship = getHypothesisRelationshipDecision(
        item,
        runPool,
        selected.filter((selectedItem) => selectedItem.id !== item.id).map((selectedItem) => selectedItem.id),
      );
      const lastRelationshipTransition = [...item.auditTrail]
        .reverse()
        .find((transition) =>
          transition.kind === "relationship_blocked" || transition.kind === "relationship_unblocked");
      if (!relationship.activationAllowed && lastRelationshipTransition?.kind !== "relationship_blocked") {
        const blockers = [
          relationship.prerequisiteBlockers.length > 0
            ? `unconfirmed prerequisites ${relationship.prerequisiteBlockers.join(", ")}`
            : null,
          relationship.activeConflicts.length > 0
            ? `active conflicts ${relationship.activeConflicts.join(", ")}`
            : null,
        ].filter((reason): reason is string => reason !== null);
        this.hypotheses.update(item.id, {}, {
          kind: "relationship_blocked",
          reason: `Relationship gate blocked activation: ${blockers.join("; ")}.`,
        });
      } else if (relationship.activationAllowed && lastRelationshipTransition?.kind === "relationship_blocked") {
        this.hypotheses.update(item.id, {}, {
          kind: "relationship_unblocked",
          reason: "Relationship gate reopened after prerequisite or conflict state changed.",
        });
      }
    }
    const promoted: string[] = [];
    const demoted: string[] = [];
    for (const item of eligible) {
      const nextStatus = nextActiveIds.has(item.id) ? "active" : "candidate";
      if (item.status === nextStatus) continue;
      const boundaryScore = Math.min(...selected.map((selectedItem) => selectedItem.priorityScore ?? 0));
      this.hypotheses.update(item.id, { status: nextStatus }, {
        kind: nextStatus === "active" ? "promoted" : "demoted",
        reason: nextStatus === "active"
          ? `${promotionReasons.get(item.id) ?? `Promoted into the ${activeCapacity}-slot active verification set.`} Activation boundary ${boundaryScore}. ${capacityDecision.reason}`
          : `${relationshipBlockedIds.has(item.id)
            ? "Demoted because prerequisite or conflict relationships block activation"
            : item.status === "active" && currentActive.every((activeItem) => activeItem.id !== item.id)
            ? `Demoted after adaptive capacity contracted to ${activeCapacity}`
            : fastTrackPromotions.size > 0
              ? "Demoted by a strong-evidence fast-track challenger"
              : `Demoted after falling outside the ${HYPOTHESIS_ACTIVATION_MARGIN}-point hysteresis boundary`}; score ${item.priorityScore ?? 0}, activation boundary ${boundaryScore}. ${capacityDecision.reason}`,
      });
      if (nextStatus === "active") promoted.push(item.id);
      else demoted.push(item.id);
    }

    const active = this.hypotheses.listByCase(caseId)
      .filter((item) => item.runId === runId && item.status === "active")
      .sort((left, right) => (right.priorityScore ?? 0) - (left.priorityScore ?? 0));
    return {
      active,
      promoted,
      demoted,
      changed: promoted.length > 0 || demoted.length > 0,
      capacity: activeCapacity,
      capacityReason: capacityDecision.reason,
    };
  }
}
