import { randomUUID } from "node:crypto";
import {
  ObserverStrategyAuditSchema,
  type ObserverStrategyAudit,
} from "@traceforge/shared";
import type { ObserverReviewTrigger } from "@traceforge/extension";
import type { ObserverRecoveryStrategySelection } from "./observer-recovery-strategies.js";

export function buildObserverStrategyAudit(input: {
  caseId: string;
  runId: string;
  trigger: ObserverReviewTrigger;
  selection: ObserverRecoveryStrategySelection;
  warningIdsByStrategy: ReadonlyMap<string, ReadonlySet<string>>;
  createdAt?: string;
  id?: string;
}): ObserverStrategyAudit {
  const offeredCandidates = input.selection.strategies.map((strategy) => ({
    strategyId: strategy.warningId,
    relevanceScore: strategy.relevanceScore,
    relevanceReasons: strategy.relevanceReasons,
    effectiveness: strategy.effectiveness,
    usageCount: strategy.usageCount,
    successCount: strategy.successCount,
    failureCount: strategy.failureCount,
  }));
  const offeredIds = new Set(offeredCandidates.map((candidate) => candidate.strategyId));
  const adoptions = [...input.warningIdsByStrategy.entries()]
    .filter(([strategyId, warningIds]) => offeredIds.has(strategyId) && warningIds.size > 0)
    .map(([strategyId, warningIds]) => ({
      strategyId,
      warningIds: [...warningIds].sort(),
    }))
    .sort((left, right) => left.strategyId.localeCompare(right.strategyId));
  const adoptedIds = new Set(adoptions.map((adoption) => adoption.strategyId));
  return ObserverStrategyAuditSchema.parse({
    id: input.id ?? `observer_strategy_audit_${randomUUID()}`,
    caseId: input.caseId,
    runId: input.runId,
    trigger: input.trigger,
    offeredCandidates,
    adoptions,
    ignoredStrategyIds: offeredCandidates
      .map((candidate) => candidate.strategyId)
      .filter((strategyId) => !adoptedIds.has(strategyId)),
    contextCharacters: input.selection.characterCount,
    createdAt: input.createdAt ?? new Date().toISOString(),
  });
}
