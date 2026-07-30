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
}

function normalizedInstruction(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function verifiedObserverRecoveryStrategies(
  warnings: ObserverWarning[],
  options: { excludeRunId?: string; limit?: number } = {},
): VerifiedObserverRecoveryStrategy[] {
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
    }];
  });

  eligible.sort((left, right) => right.verifiedAt.localeCompare(left.verifiedAt));
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
  ].join("; ")).join("\n");
}
