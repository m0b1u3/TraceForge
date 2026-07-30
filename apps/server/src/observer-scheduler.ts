import {
  computeFailureFingerprint,
  type ObserverReviewTrigger,
  type ToolExecutionReport,
} from "@traceforge/extension";

const PRIORITY: Record<Exclude<ObserverReviewTrigger, "interval" | "final">, number> = {
  finding_verification: 1,
  repeated_failure: 2,
  high_risk: 3,
  evidence_conflict: 4,
};

const IDENTICAL_FAILURE_THRESHOLD = 3;
const UNRESOLVED_FAILURE_THRESHOLD = 5;

type EventTrigger = keyof typeof PRIORITY;

interface FailureSequence {
  fingerprint: string;
  identicalCount: number;
  unresolvedCount: number;
  reviewed: boolean;
}

function inputRecord(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null ? input as Record<string, unknown> : {};
}

function responseShowsDifference(content: string): boolean {
  try {
    const value = JSON.parse(content) as Record<string, unknown>;
    return value.different === true
      || value.responseDifferent === true
      || value.statusDifferent === true
      || value.bodyDifferent === true;
  } catch {
    return /statusDifferent["']?\s*:\s*true|bodyDifferent["']?\s*:\s*true|responses? differ/i.test(content);
  }
}

function recordedAttackPathStatus(content: string): string | null {
  try {
    const value = JSON.parse(content) as Record<string, unknown>;
    return typeof value.status === "string" ? value.status : null;
  } catch {
    return null;
  }
}

function countsAsUnresolvedFailure(report: ToolExecutionReport): boolean {
  if (report.ok || report.rejected) return false;
  const category = report.failureDiagnostic?.category;
  return category !== "authorization"
    && category !== "rejected"
    && category !== "policy_block";
}

export class ObserverScheduler {
  private pending: EventTrigger | null = null;
  private readonly failuresByScope = new Map<string, FailureSequence>();
  private successfulCommandsSinceReview = 0;

  observe(report: ToolExecutionReport): void {
    const input = inputRecord(report.input);
    const scopeKey = report.executionScopeKey ?? "run:unscoped";

    if (countsAsUnresolvedFailure(report)) {
      this.observeFailure(scopeKey, report);
      return;
    }

    if (!report.ok) return;
    this.failuresByScope.delete(scopeKey);

    if (report.risk === "command") {
      this.successfulCommandsSinceReview += 1;
      if (this.successfulCommandsSinceReview >= 4) this.mark("high_risk");
    }

    if (
      report.name === "compare_identity_traffic"
      && responseShowsDifference(report.content)
    ) {
      this.mark("evidence_conflict");
    }

    if (report.name === "record_attack_path") {
      const status = recordedAttackPathStatus(report.content);
      if (status === "invalidated") this.mark("evidence_conflict");
      else if (status === "validated") this.mark("finding_verification");
    }

    if (report.name !== "record_fact") return;
    if (input.validity === "conflicted" || input.findingStatus === "needs_review") {
      this.mark("evidence_conflict");
      return;
    }
    if (
      input.type === "finding"
      || input.findingStatus === "validating"
      || input.findingStatus === "verified"
    ) {
      this.mark("finding_verification");
    }
  }

  consume(): EventTrigger | null {
    const trigger = this.pending;
    this.pending = null;
    if (trigger) this.successfulCommandsSinceReview = 0;
    return trigger;
  }

  private observeFailure(scopeKey: string, report: ToolExecutionReport): void {
    const fingerprint = computeFailureFingerprint(report.name, report.input);
    const previous = this.failuresByScope.get(scopeKey);
    const sameCall = previous?.fingerprint === fingerprint;
    const pivotedAfterReview = previous?.reviewed === true && !sameCall;
    const next: FailureSequence = {
      fingerprint,
      identicalCount: sameCall ? previous.identicalCount + 1 : 1,
      unresolvedCount: pivotedAfterReview ? 1 : (previous?.unresolvedCount ?? 0) + 1,
      reviewed: sameCall ? previous.reviewed : false,
    };
    this.failuresByScope.set(scopeKey, next);

    if (
      !next.reviewed
      && (
        next.identicalCount >= IDENTICAL_FAILURE_THRESHOLD
        || next.unresolvedCount >= UNRESOLVED_FAILURE_THRESHOLD
      )
    ) {
      next.reviewed = true;
      this.mark("repeated_failure");
    }
  }

  private mark(trigger: EventTrigger): void {
    if (!this.pending || PRIORITY[trigger] > PRIORITY[this.pending]) this.pending = trigger;
  }
}
