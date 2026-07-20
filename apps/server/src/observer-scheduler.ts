import type { ObserverReviewTrigger, ToolExecutionReport } from "@traceforge/extension";

const PRIORITY: Record<Exclude<ObserverReviewTrigger, "interval" | "final">, number> = {
  finding_verification: 1,
  repeated_failure: 2,
  high_risk: 3,
  evidence_conflict: 4,
};

type EventTrigger = keyof typeof PRIORITY;

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

export class ObserverScheduler {
  private pending: EventTrigger | null = null;
  private consecutivePermanentFailures = 0;

  observe(report: ToolExecutionReport): void {
    const input = inputRecord(report.input);

    if (report.blocked || (!report.ok && report.failureClass === "permanent")) {
      this.consecutivePermanentFailures += 1;
      if (report.blocked || this.consecutivePermanentFailures >= 2) this.mark("repeated_failure");
      return;
    }

    if (!report.ok) return;
    this.consecutivePermanentFailures = 0;

    if (report.risk === "command") this.mark("high_risk");

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
    return trigger;
  }

  private mark(trigger: EventTrigger): void {
    if (!this.pending || PRIORITY[trigger] > PRIORITY[this.pending]) this.pending = trigger;
  }
}
