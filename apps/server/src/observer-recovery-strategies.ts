import {
  parseObserverCorrectionAudit,
  type ObserverIssueType,
  type ObserverRecoveryRelevanceReason,
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
  relevanceScore: number;
  relevanceReasons: ObserverRecoveryRelevanceReason[];
}

function normalizedInstruction(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizedIdentity(value: string): string {
  return value.trim().toLowerCase().replace(/[\s:_-]+/g, " ");
}

function lexicalTerms(value: string): Set<string> {
  const normalized = value.toLowerCase();
  const terms = new Set(normalized.match(/[a-z0-9]{4,}/g) ?? []);
  for (const segment of normalized.match(/\p{Script=Han}+/gu) ?? []) {
    for (let index = 0; index < segment.length - 1; index += 1) {
      terms.add(segment.slice(index, index + 2));
    }
  }
  return terms;
}

function lexicalOverlapScore(left: string, right: string): number {
  const leftTerms = lexicalTerms(left);
  const rightTerms = lexicalTerms(right);
  let score = 0;
  for (const term of leftTerms) {
    if (rightTerms.has(term)) score += /\p{Script=Han}/u.test(term) ? 2 : Math.min(12, term.length);
  }
  return score;
}

export interface ObserverRecoveryStrategyFocus {
  goal: string;
  trajectory: string;
  activeWarnings: ObserverWarning[];
}

export interface ObserverRecoveryStrategyOptions {
  excludeRunId?: string;
  limit?: number;
  maxCharacters?: number;
  focus?: ObserverRecoveryStrategyFocus;
}

export interface ObserverRecoveryStrategySelection {
  strategies: VerifiedObserverRecoveryStrategy[];
  summary: string;
  characterCount: number;
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

function recoveryStrategyRelevance(
  strategy: Pick<
    VerifiedObserverRecoveryStrategy,
    "fingerprint" | "issueType" | "subject" | "instruction" | "evidenceRefs"
  >,
  focus: ObserverRecoveryStrategyFocus,
): { score: number; reasons: ObserverRecoveryRelevanceReason[] } {
  const activeEvidence = new Set(focus.activeWarnings.flatMap((warning) => [
    ...warning.relatedFacts,
    ...warning.relatedTasks,
  ]));
  const normalizedSubject = normalizedIdentity(strategy.subject);
  let score = 0;
  const reasons = new Set<ObserverRecoveryRelevanceReason>();
  for (const warning of focus.activeWarnings) {
    if (strategy.fingerprint === warning.fingerprint) {
      score += 100;
      reasons.add("fingerprint_match");
    }
    if (strategy.issueType === warning.issueType) {
      score += 24;
      reasons.add("issue_type_match");
    }
    if (
      normalizedSubject
      && normalizedSubject === normalizedIdentity(warning.subject)
    ) {
      score += 40;
      reasons.add("subject_match");
    }
  }
  const evidenceMatches = strategy.evidenceRefs.filter((reference) =>
    activeEvidence.has(reference)).length;
  score += Math.min(36, evidenceMatches * 18);
  if (evidenceMatches > 0) reasons.add("evidence_reference_match");

  const focusText = [
    focus.goal,
    focus.trajectory,
    ...focus.activeWarnings.flatMap((warning) => [
      warning.subject,
      warning.title,
      warning.description,
      warning.evidence ?? "",
      warning.suggestedAction,
      warning.suggestedGoal ?? "",
    ]),
  ].join("\n");
  const lexicalSubject = strategy.subject.replace(/^[a-z][\w-]*:/i, "");
  const lexicalScore = Math.max(
    lexicalOverlapScore(lexicalSubject, focusText),
    lexicalOverlapScore(strategy.instruction, focusText),
  );
  const lexicalThreshold = focus.activeWarnings.length > 0 ? 8 : 4;
  if (lexicalScore >= lexicalThreshold) {
    score += Math.min(24, lexicalScore);
    reasons.add("lexical_context_match");
  }
  return { score, reasons: [...reasons] };
}

export function verifiedObserverRecoveryStrategies(
  warnings: ObserverWarning[],
  options: ObserverRecoveryStrategyOptions = {},
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
      relevanceScore: 0,
      relevanceReasons: [],
    }];
  });

  for (const strategy of eligible) {
    const relevance = options.focus
      ? recoveryStrategyRelevance(strategy, options.focus)
      : { score: 0, reasons: [] };
    strategy.relevanceScore = relevance.score;
    strategy.relevanceReasons = relevance.reasons;
  }
  const relevant = options.focus
    ? eligible.filter((strategy) => strategy.relevanceScore > 0)
    : eligible;
  relevant.sort((left, right) =>
    right.relevanceScore - left.relevanceScore
    || right.score - left.score
    || right.verifiedAt.localeCompare(left.verifiedAt));
  const unique = new Map<string, VerifiedObserverRecoveryStrategy>();
  for (const strategy of relevant) {
    const key = `${strategy.fingerprint}:${normalizedInstruction(strategy.instruction)}`;
    if (!unique.has(key)) unique.set(key, strategy);
  }
  return [...unique.values()].slice(0, Math.max(0, options.limit ?? 6));
}

function compactSummaryValue(value: string, limit: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= limit ? compact : `${compact.slice(0, limit - 1)}…`;
}

function strategySummary(strategy: VerifiedObserverRecoveryStrategy): string {
  return [
    `${strategy.warningId} [${strategy.issueType}; subject=${compactSummaryValue(strategy.subject || "unspecified", 160)}]`,
    `candidate=${compactSummaryValue(strategy.instruction, 420)}`,
    `attribution=${strategy.attributionReason}`,
    `evidenceRefs=${compactSummaryValue(strategy.evidenceRefs.join(",") || "recovered_execution", 240)}`,
    `reuse=${strategy.effectiveness}; uses=${strategy.usageCount}; successes=${strategy.successCount}; failures=${strategy.failureCount}`,
  ].join("; ");
}

export function selectVerifiedObserverRecoveryStrategies(
  warnings: ObserverWarning[],
  options: ObserverRecoveryStrategyOptions = {},
): ObserverRecoveryStrategySelection {
  const strategies = verifiedObserverRecoveryStrategies(warnings, options);
  const maxCharacters = Math.max(6, options.maxCharacters ?? 2_400);
  const included: VerifiedObserverRecoveryStrategy[] = [];
  const lines: string[] = [];
  let characterCount = 0;
  for (const strategy of strategies) {
    const line = strategySummary(strategy);
    const separatorLength = lines.length > 0 ? 1 : 0;
    if (characterCount + separatorLength + line.length > maxCharacters) continue;
    included.push(strategy);
    lines.push(line);
    characterCount += separatorLength + line.length;
  }
  const summary = lines.join("\n") || "(none)";
  return {
    strategies: included,
    summary,
    characterCount: summary.length,
  };
}

export function verifiedObserverRecoveryStrategiesSummary(
  warnings: ObserverWarning[],
  options: ObserverRecoveryStrategyOptions = {},
): string {
  return selectVerifiedObserverRecoveryStrategies(warnings, options).summary;
}
