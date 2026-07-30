import {
  parseObserverCorrectionAudit,
  type ObserverIssueType,
  type ObserverWarning,
} from "@traceforge/shared";

export interface VerifiedObserverRecoveryStrategy {
  warningId: string;
  fingerprint: string;
  issueType: ObserverIssueType;
  subject: string;
  instruction: string;
  evidenceRefs: string[];
  attributionReason: "correction_linked_result" | "execution_recovered";
  verifiedAt: string;
  usageCount: number;
  successCount: number;
  failureCount: number;
  effectiveness: "active" | "degraded";
  score: number;
}

function normalizedInstruction(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export interface ObserverRecoveryStrategyEffect {
  usageCount: number;
  successCount: number;
  failureCount: number;
  pendingCount: number;
  score: number;
  withdrawn: boolean;
}

function attributedResolution(warning: ObserverWarning): boolean {
  const audit = parseObserverCorrectionAudit(warning.correctionEvidence);
  return warning.status === "resolved"
    && warning.correctionOutcome === "resolved"
    && audit?.attributed === true;
}

function failedReuse(warning: ObserverWarning): boolean {
  return warning.correctionOutcome === "persisted"
    || warning.correctionOutcome === "stalled"
    || warning.correctionOutcome === "escalated";
}

export function observerRecoveryStrategyEffects(
  warnings: ObserverWarning[],
): Map<string, ObserverRecoveryStrategyEffect> {
  const referenced = new Map<string, ObserverWarning[]>();
  for (const warning of warnings) {
    for (const strategyId of new Set(warning.recoveryStrategyRefs)) {
      const uses = referenced.get(strategyId) ?? [];
      uses.push(warning);
      referenced.set(strategyId, uses);
    }
  }
  const effects = new Map<string, ObserverRecoveryStrategyEffect>();
  for (const [strategyId, uses] of referenced) {
    const successCount = uses.filter(attributedResolution).length;
    const failureCount = uses.filter(failedReuse).length;
    const pendingCount = uses.length - successCount - failureCount;
    const score = 1 + (successCount * 2) - failureCount;
    effects.set(strategyId, {
      usageCount: uses.length,
      successCount,
      failureCount,
      pendingCount,
      score,
      withdrawn: failureCount >= 2 && successCount === 0,
    });
  }
  return effects;
}

export function verifiedObserverRecoveryStrategies(
  warnings: ObserverWarning[],
  options: { excludeRunId?: string; limit?: number } = {},
): VerifiedObserverRecoveryStrategy[] {
  const effects = observerRecoveryStrategyEffects(warnings);
  const eligible = warnings.flatMap((warning): VerifiedObserverRecoveryStrategy[] => {
    if (
      warning.status !== "resolved"
      || warning.correctionOutcome !== "resolved"
      || warning.lastCorrectionTrigger !== "human_direction"
      || (options.excludeRunId && warning.relatedRunId === options.excludeRunId)
    ) {
      return [];
    }
    const audit = parseObserverCorrectionAudit(warning.correctionEvidence);
    if (
      !audit?.attributed
      || (audit.reason !== "correction_linked_result" && audit.reason !== "execution_recovered")
      || !audit.instruction.trim()
    ) {
      return [];
    }
    const effect = effects.get(warning.id) ?? {
      usageCount: 0,
      successCount: 0,
      failureCount: 0,
      pendingCount: 0,
      score: 1,
      withdrawn: false,
    };
    if (effect.withdrawn) return [];
    return [{
      warningId: warning.id,
      fingerprint: warning.fingerprint,
      issueType: warning.issueType,
      subject: warning.subject,
      instruction: audit.instruction.trim(),
      evidenceRefs: audit.evidenceRefs,
      attributionReason: audit.reason,
      verifiedAt: warning.resolvedAt
        ?? warning.lastCorrectionAt
        ?? warning.lastObservedAt
        ?? warning.createdAt,
      usageCount: effect.usageCount,
      successCount: effect.successCount,
      failureCount: effect.failureCount,
      effectiveness: effect.failureCount > effect.successCount ? "degraded" : "active",
      score: effect.score,
    }];
  });

  eligible.sort((left, right) =>
    right.score - left.score
    || right.verifiedAt.localeCompare(left.verifiedAt));
  const unique = new Map<string, VerifiedObserverRecoveryStrategy>();
  for (const strategy of eligible) {
    const key = `${strategy.fingerprint}:${normalizedInstruction(strategy.instruction)}`;
    if (!unique.has(key)) unique.set(key, strategy);
  }
  return [...unique.values()].slice(0, Math.max(0, options.limit ?? 6));
}

export function verifiedObserverRecoveryStrategiesSummary(
  warnings: ObserverWarning[],
  options: { excludeRunId?: string; limit?: number } = {},
): string {
  const strategies = verifiedObserverRecoveryStrategies(warnings, options);
  if (strategies.length === 0) return "(none)";
  return strategies.map((strategy) => [
    `${strategy.warningId} [${strategy.issueType}; subject=${strategy.subject || "unspecified"}]`,
    `candidate=${strategy.instruction}`,
    `attribution=${strategy.attributionReason}`,
    `evidenceRefs=${strategy.evidenceRefs.join(",") || "recovered_execution"}`,
    `reuse=${strategy.effectiveness}; uses=${strategy.usageCount}; successes=${strategy.successCount}; failures=${strategy.failureCount}`,
  ].join("; ")).join("\n");
}
