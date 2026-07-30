import { describe, it, expect } from "vitest";
import {
  observerRecoveryRequiresDirection,
  observerWarningContinueDisabled,
  observerWarningGroup,
  observerWarningRunGoal,
  observerWarningStatusLabel,
  observerStrategyOutcome,
} from "./ObserverTab.js";
import { ObserverStrategyAuditSchema, ObserverWarningSchema } from "@traceforge/shared";

function strategyAudit() {
  return ObserverStrategyAuditSchema.parse({
    id: "audit_1",
    caseId: "case_1",
    runId: "run_1",
    trigger: "interval",
    offeredCandidates: [{
      strategyId: "strategy_1",
      relevanceScore: 124,
      relevanceReasons: ["fingerprint_match"],
      effectiveness: "active",
      usageCount: 0,
      successCount: 0,
      failureCount: 0,
    }],
    adoptions: [{ strategyId: "strategy_1", warningIds: ["warning_1"] }],
    ignoredStrategyIds: [],
    contextCharacters: 240,
    createdAt: "2026-07-30T04:00:00.000Z",
  });
}

function linkedWarning(correctionOutcome: "pending" | "resolved" | "persisted" | "stalled") {
  return ObserverWarningSchema.parse({
    id: "warning_1",
    caseId: "case_1",
    level: "warning",
    issueType: "evidence_gap",
    subject: "task:candidate",
    title: "Evidence remains incomplete",
    description: "Another traceable result is required.",
    relatedFacts: [],
    relatedTasks: [],
    suggestedAction: "Collect independent evidence.",
    status: correctionOutcome === "resolved" ? "resolved" : "correcting",
    fingerprint: "warning-fingerprint",
    occurrenceCount: 1,
    lastObservedAt: "2026-07-30T04:00:00.000Z",
    correctionCount: 1,
    correctionResolvedCount: correctionOutcome === "resolved" ? 1 : 0,
    correctionFailedCount: correctionOutcome === "persisted" ? 1 : 0,
    correctionOutcome,
    correctionEvidence: null,
    lastCorrectionAt: "2026-07-30T04:00:00.000Z",
    lastCorrectionTrigger: "interval",
    recoveryStrategyRefs: ["strategy_1"],
    escalationReason: null,
    relatedRunId: "run_1",
    suggestedGoal: "Collect independent evidence.",
    resolvedAt: correctionOutcome === "resolved" ? "2026-07-30T04:01:00.000Z" : null,
    createdAt: "2026-07-30T04:00:00.000Z",
  });
}

describe("ObserverTab helpers", () => {
  it("labels observer warning workflow states", () => {
    expect(observerWarningStatusLabel("open")).toBe("Pending");
    expect(observerWarningStatusLabel("accepted")).toBe("Resumed");
    expect(observerWarningStatusLabel("converted_to_task")).toBe("Tasked");
    expect(observerWarningStatusLabel("dismissed")).toBe("Ignored");
  });

  it("uses suggestedGoal before falling back to suggestedAction", () => {
    expect(observerWarningRunGoal({
      suggestedGoal: "[Observer correction]\nContinue testing X",
      suggestedAction: "Continue testing X",
    })).toBe("[Observer correction]\nContinue testing X");
    expect(observerWarningRunGoal({
      suggestedGoal: "",
      suggestedAction: "Continue testing X",
    })).toBe("Continue testing X");
  });

  it("disables continue while any agent run is active or busy", () => {
    expect(observerWarningContinueDisabled(null, false, null)).toBe(false);
    expect(observerWarningContinueDisabled({ status: "running" }, false, null)).toBe(true);
    expect(observerWarningContinueDisabled(null, true, null)).toBe(true);
    expect(observerWarningContinueDisabled(null, false, "warn_1:task")).toBe(true);
  });

  it("requires explicit human direction only for stalled corrections", () => {
    expect(observerRecoveryRequiresDirection({ correctionOutcome: "stalled" })).toBe(true);
    expect(observerRecoveryRequiresDirection({ correctionOutcome: "persisted" })).toBe(false);
    expect(observerRecoveryRequiresDirection({ correctionOutcome: "pending" })).toBe(false);
  });

  it("groups warnings by intervention priority", () => {
    expect(observerWarningGroup("escalated")).toBe("action");
    expect(observerWarningGroup("open")).toBe("action");
    expect(observerWarningGroup("correcting")).toBe("monitoring");
    expect(observerWarningGroup("detected")).toBe("monitoring");
    expect(observerWarningGroup("resolved")).toBe("history");
    expect(observerWarningGroup("converted_to_task")).toBe("history");
  });

  it("derives recovery strategy outcomes only from linked warning lifecycle state", () => {
    const audit = strategyAudit();
    expect(observerStrategyOutcome(audit, "strategy_1", [])).toBe("pending");
    expect(observerStrategyOutcome(audit, "strategy_1", [linkedWarning("pending")])).toBe("pending");
    expect(observerStrategyOutcome(audit, "strategy_1", [linkedWarning("resolved")])).toBe("recovered");
    expect(observerStrategyOutcome(audit, "strategy_1", [linkedWarning("persisted")])).toBe("persisted");
    expect(observerStrategyOutcome(audit, "strategy_1", [linkedWarning("stalled")])).toBe("stalled");
    expect(observerStrategyOutcome({
      ...audit,
      adoptions: [],
      ignoredStrategyIds: ["strategy_1"],
    }, "strategy_1", [])).toBe("ignored");
  });
});
