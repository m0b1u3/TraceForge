import type { Hypothesis } from "./schemas.js";

export const MAX_ACTIVE_HYPOTHESES = 5;
export const HYPOTHESIS_ACTIVATION_MARGIN = 8;
export const HYPOTHESIS_MIN_RESIDENCY_MS = 2 * 60 * 1000;
export const HYPOTHESIS_FAST_TRACK_SCORE = 88;

export function isFastTrackHypothesis(hypothesis: Hypothesis): boolean {
  const factors = hypothesis.scoreFactors;
  if (!factors || (hypothesis.priorityScore ?? 0) < HYPOTHESIS_FAST_TRACK_SCORE) return false;
  return factors.evidenceStrength >= 85
    && (factors.impact >= 85 || factors.pathRelevance >= 85);
}

export function hypothesisActivationStartedAt(hypothesis: Hypothesis): number | null {
  const transition = [...hypothesis.auditTrail].reverse().find((entry) =>
    entry.kind === "promoted" || (entry.kind === "created" && entry.toStatus === "active"));
  if (!transition) return null;
  const timestamp = Date.parse(transition.createdAt);
  return Number.isFinite(timestamp) ? timestamp : null;
}
