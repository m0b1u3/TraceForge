import { describe, expect, it } from "vitest";
import {
  ObserverWarningSchema,
  serializeObserverCorrectionAudit,
  type ObserverWarning,
} from "@traceforge/shared";
import {
  observerRecoveryStrategyEffects,
  selectVerifiedObserverRecoveryStrategies,
  verifiedObserverRecoveryStrategies,
  verifiedObserverRecoveryStrategiesSummary,
} from "./observer-recovery-strategies.js";

function warning(id: string, patch: Partial<ObserverWarning> = {}): ObserverWarning {
  return ObserverWarningSchema.parse({
    id,
    caseId: "case_1",
    level: "critical",
    issueType: "evidence_gap",
    subject: "task:task_1",
    title: "Evidence remains incomplete",
    description: "A traceable result is still required.",
    relatedFacts: [],
    relatedTasks: ["task_1"],
    suggestedAction: "Collect another result.",
    status: "resolved",
    fingerprint: "stable-fingerprint",
    occurrenceCount: 2,
    lastObservedAt: "2026-07-30T01:00:00.000Z",
    correctionCount: 1,
    correctionResolvedCount: 1,
    correctionFailedCount: 0,
    correctionOutcome: "resolved",
    correctionEvidence: serializeObserverCorrectionAudit({
      version: 1,
      attributed: true,
      reason: "correction_linked_result",
      trigger: "human_direction",
      instruction: "Use an independent evidence source.",
      actions: [{ tool: "inspect", outcome: "succeeded", evidenceRefs: ["fact_1"] }],
      evidenceRefs: ["fact_1"],
      summary: "The human direction produced traceable evidence.",
    }),
    lastCorrectionAt: "2026-07-30T01:01:00.000Z",
    lastCorrectionTrigger: "human_direction",
    escalationReason: null,
    relatedRunId: "run_previous",
    suggestedGoal: "Use an independent evidence source.",
    resolvedAt: "2026-07-30T01:02:00.000Z",
    createdAt: "2026-07-30T00:00:00.000Z",
    ...patch,
  });
}

describe("verified Observer recovery strategies", () => {
  it("admits only attributed and resolved human directions", () => {
    const verified = warning("warn_verified");
    const unattributed = warning("warn_unattributed", { correctionOutcome: "unattributed" });
    const automatic = warning("warn_automatic", { lastCorrectionTrigger: "interval" });
    const pending = warning("warn_pending", { status: "correcting", correctionOutcome: "pending" });

    expect(verifiedObserverRecoveryStrategies([
      unattributed,
      automatic,
      pending,
      verified,
    ])).toEqual([expect.objectContaining({
      warningId: "warn_verified",
      instruction: "Use an independent evidence source.",
      evidenceRefs: ["fact_1"],
    })]);
  });

  it("deduplicates equivalent strategies and excludes the current run", () => {
    const older = warning("warn_older", { resolvedAt: "2026-07-30T01:02:00.000Z" });
    const newer = warning("warn_newer", { resolvedAt: "2026-07-30T02:02:00.000Z" });
    const current = warning("warn_current", {
      fingerprint: "another-fingerprint",
      relatedRunId: "run_current",
    });

    expect(verifiedObserverRecoveryStrategies(
      [older, current, newer],
      { excludeRunId: "run_current" },
    ).map((strategy) => strategy.warningId)).toEqual(["warn_newer"]);
  });

  it("renders candidate context without converting it into an instruction", () => {
    const summary = verifiedObserverRecoveryStrategiesSummary([warning("warn_verified")]);

    expect(summary).toContain("candidate=Use an independent evidence source.");
    expect(summary).toContain("attribution=correction_linked_result");
    expect(summary).toContain("evidenceRefs=fact_1");
    expect(verifiedObserverRecoveryStrategiesSummary([])).toBe("(none)");
  });

  it("degrades after one failed reuse and withdraws after repeated failures", () => {
    const source = warning("warn_source");
    const other = warning("warn_other", {
      fingerprint: "other-fingerprint",
      subject: "task:task_2",
      resolvedAt: "2026-07-30T00:30:00.000Z",
    });
    const firstFailure = warning("warn_failure_1", {
      lastCorrectionTrigger: "interval",
      correctionOutcome: "persisted",
      correctionResolvedCount: 0,
      correctionFailedCount: 1,
      recoveryStrategyRefs: [source.id],
    });
    const oneFailure = verifiedObserverRecoveryStrategies([source, other, firstFailure]);
    expect(oneFailure.map((strategy) => strategy.warningId)).toEqual([other.id, source.id]);
    expect(oneFailure.find((strategy) => strategy.warningId === source.id)).toMatchObject({
      effectiveness: "degraded",
      failureCount: 1,
      score: 0,
    });

    const secondFailure = warning("warn_failure_2", {
      lastCorrectionTrigger: "interval",
      correctionOutcome: "stalled",
      correctionResolvedCount: 0,
      correctionFailedCount: 1,
      recoveryStrategyRefs: [source.id],
    });
    expect(verifiedObserverRecoveryStrategies([
      source,
      other,
      firstFailure,
      secondFailure,
    ]).map((strategy) => strategy.warningId)).toEqual([other.id]);
    expect(observerRecoveryStrategyEffects([
      firstFailure,
      secondFailure,
    ]).get(source.id)).toMatchObject({
      usageCount: 2,
      successCount: 0,
      failureCount: 2,
      withdrawn: true,
    });
  });

  it("retains a reused strategy when later evidence confirms it", () => {
    const source = warning("warn_source");
    const failed = warning("warn_failed", {
      lastCorrectionTrigger: "interval",
      correctionOutcome: "persisted",
      correctionResolvedCount: 0,
      correctionFailedCount: 1,
      recoveryStrategyRefs: [source.id],
    });
    const succeeded = warning("warn_succeeded", {
      lastCorrectionTrigger: "interval",
      recoveryStrategyRefs: [source.id],
    });

    expect(verifiedObserverRecoveryStrategies([
      source,
      failed,
      succeeded,
    ])).toEqual([expect.objectContaining({
      warningId: source.id,
      successCount: 1,
      failureCount: 1,
      effectiveness: "active",
      score: 2,
    })]);
  });

  it("ranks matching issue identity and excludes unrelated project history", () => {
    const relevant = warning("warn_relevant", {
      fingerprint: "current-fingerprint",
      issueType: "evidence_gap",
      subject: "task:current-candidate",
      resolvedAt: "2026-07-30T01:00:00.000Z",
    });
    const unrelated = warning("warn_unrelated", {
      fingerprint: "unrelated-fingerprint",
      issueType: "repeated_failure",
      subject: "task:historical-branch",
      correctionEvidence: serializeObserverCorrectionAudit({
        version: 1,
        attributed: true,
        reason: "execution_recovered",
        trigger: "human_direction",
        instruction: "Rebuild an unrelated historical branch.",
        actions: [{ tool: "inspect", outcome: "succeeded", evidenceRefs: ["fact_old"] }],
        evidenceRefs: ["fact_old"],
        summary: "A historical execution recovered.",
      }),
      resolvedAt: "2026-07-30T03:00:00.000Z",
    });
    const current = warning("warn_current", {
      status: "open",
      correctionOutcome: "pending",
      fingerprint: "current-fingerprint",
      subject: "task:current-candidate",
      relatedFacts: ["fact_1"],
      resolvedAt: null,
    });

    const selection = selectVerifiedObserverRecoveryStrategies(
      [unrelated, relevant, current],
      {
        focus: {
          goal: "Complete the current candidate with traceable evidence.",
          trajectory: "The current candidate still lacks an independent evidence source.",
          activeWarnings: [current],
        },
      },
    );

    expect(selection.strategies.map((strategy) => strategy.warningId)).toEqual([
      relevant.id,
    ]);
    expect(selection.summary).toContain(relevant.id);
    expect(selection.summary).not.toContain(unrelated.id);
    expect(selection.strategies[0]?.relevanceScore).toBeGreaterThan(0);
  });

  it("uses one character-budgeted selection for both summary and allowed ids", () => {
    const first = warning("warn_first", {
      fingerprint: "first-fingerprint",
      subject: "evidence checkpoint",
    });
    const second = warning("warn_second", {
      fingerprint: "second-fingerprint",
      subject: "evidence checkpoint two",
      correctionEvidence: serializeObserverCorrectionAudit({
        version: 1,
        attributed: true,
        reason: "correction_linked_result",
        trigger: "human_direction",
        instruction: "Use a second independent source and preserve every resulting reference.",
        actions: [{ tool: "inspect", outcome: "succeeded", evidenceRefs: ["fact_2"] }],
        evidenceRefs: ["fact_2"],
        summary: "A second source produced traceable evidence.",
      }),
    });

    const selection = selectVerifiedObserverRecoveryStrategies(
      [first, second],
      {
        maxCharacters: 420,
        focus: {
          goal: "Review the evidence checkpoint.",
          trajectory: "An evidence checkpoint needs another traceable source.",
          activeWarnings: [],
        },
      },
    );

    expect(selection.characterCount).toBeLessThanOrEqual(420);
    expect(selection.strategies).toHaveLength(1);
    expect(selection.summary).toContain(selection.strategies[0]!.warningId);
    expect([first.id, second.id].filter((id) => selection.summary.includes(id)))
      .toEqual(selection.strategies.map((strategy) => strategy.warningId));
  });
});
