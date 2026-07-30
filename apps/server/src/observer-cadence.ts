import type { ObserverWarning } from "@traceforge/shared";

export interface ObserverCadenceSnapshot {
  activeWarningCount: number;
  pendingCorrectionCount: number;
  resolvedCorrectionCount: number;
  failedCorrectionCount: number;
  stalledCorrectionCount: number;
}

export interface ObserverReviewOutcome {
  warningCount: number;
  correctionCount: number;
}

const PENDING_CORRECTION_INTERVAL = 4;
const INEFFECTIVE_CORRECTION_INTERVAL = 6;
const FAILED_REVIEW_RETRY_INTERVAL = 6;
const UNRESOLVED_WARNING_INTERVAL = 8;
const DEFAULT_INTERVAL = 12;
const FIRST_QUIET_INTERVAL = 18;
const SUSTAINED_QUIET_INTERVAL = 24;

export function observerCadenceSnapshot(warnings: ObserverWarning[]): ObserverCadenceSnapshot {
  const active = warnings.filter((warning) =>
    ["open", "detected", "correcting", "escalated"].includes(warning.status));
  return {
    activeWarningCount: active.length,
    pendingCorrectionCount: active.filter((warning) => warning.correctionOutcome === "pending").length,
    resolvedCorrectionCount: active.reduce((sum, warning) => sum + warning.correctionResolvedCount, 0),
    failedCorrectionCount: active.reduce((sum, warning) => sum + warning.correctionFailedCount, 0),
    stalledCorrectionCount: active.filter((warning) => warning.correctionOutcome === "stalled").length,
  };
}

export class ObserverCadence {
  private lastSuccessfulReviewTurn = 0;
  private lastReviewAttemptTurn = 0;
  private quietReviewStreak = 0;
  private failedReviewStreak = 0;

  shouldReview(turnCount: number, snapshot: ObserverCadenceSnapshot): boolean {
    if (turnCount <= 0) return false;
    const baselineTurn = Math.max(this.lastSuccessfulReviewTurn, this.lastReviewAttemptTurn);
    return turnCount - baselineTurn >= this.interval(snapshot);
  }

  recordSuccessfulReview(turnCount: number, outcome: ObserverReviewOutcome): void {
    this.lastSuccessfulReviewTurn = Math.max(this.lastSuccessfulReviewTurn, turnCount);
    this.lastReviewAttemptTurn = Math.max(this.lastReviewAttemptTurn, turnCount);
    this.failedReviewStreak = 0;
    this.quietReviewStreak = outcome.warningCount === 0 && outcome.correctionCount === 0
      ? this.quietReviewStreak + 1
      : 0;
  }

  recordFailedReview(turnCount: number): void {
    this.lastReviewAttemptTurn = Math.max(this.lastReviewAttemptTurn, turnCount);
    this.failedReviewStreak += 1;
  }

  interval(snapshot: ObserverCadenceSnapshot): number {
    if (snapshot.pendingCorrectionCount > 0) return PENDING_CORRECTION_INTERVAL;
    if (this.failedReviewStreak > 0) return FAILED_REVIEW_RETRY_INTERVAL;
    if (snapshot.stalledCorrectionCount > 0) return SUSTAINED_QUIET_INTERVAL;
    if (
      snapshot.activeWarningCount > 0
      && snapshot.failedCorrectionCount > snapshot.resolvedCorrectionCount
    ) return INEFFECTIVE_CORRECTION_INTERVAL;
    if (snapshot.activeWarningCount > 0) return UNRESOLVED_WARNING_INTERVAL;
    if (this.quietReviewStreak >= 2) return SUSTAINED_QUIET_INTERVAL;
    if (this.quietReviewStreak === 1) return FIRST_QUIET_INTERVAL;
    return DEFAULT_INTERVAL;
  }
}
