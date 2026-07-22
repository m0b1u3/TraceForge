import type { AttackPath, Fact, Hypothesis, Task } from "@traceforge/shared";
import type { HypothesisStore } from "./stores/hypothesis-store.js";
import type { FactStore } from "./stores/fact-store.js";
import type { TaskStore } from "./stores/task-store.js";
import type { AttackPathStore } from "./stores/attack-path-store.js";
import type { ValidationConsensusStore } from "./stores/validation-consensus-store.js";
import type { ValidationConsensusResult } from "./validation-consensus.js";
import type { ValidationFeedbackSummary } from "./validation-task-feedback.js";

const BASE_FACTORS: NonNullable<Hypothesis["scoreFactors"]> = {
  impact: 50,
  evidenceStrength: 50,
  verificationCost: 50,
  operationRisk: 50,
  pathRelevance: 50,
  freshness: 50,
};

const clamp = (value: number) => Math.max(0, Math.min(100, Math.round(value)));

export interface HypothesisFeedbackInput {
  hypothesis: Hypothesis;
  facts: Fact[];
  tasks: Task[];
  attackPaths: AttackPath[];
  consensus: ValidationConsensusResult[];
  feedback: Record<string, ValidationFeedbackSummary>;
  now?: Date;
}

export interface HypothesisFeedbackResult {
  factors: NonNullable<Hypothesis["scoreFactors"]>;
  reason: string;
  evidenceFactIds: string[];
  changed: boolean;
}

export function deriveHypothesisFeedback(input: HypothesisFeedbackInput): HypothesisFeedbackResult {
  const current = input.hypothesis.scoreFactors ?? BASE_FACTORS;
  const linkedFactIds = new Set(input.hypothesis.basedOnFactIds);
  const linkedFacts = input.facts.filter((fact) => linkedFactIds.has(fact.id) || fact.hypothesisIds?.includes(input.hypothesis.id));
  for (const fact of linkedFacts) linkedFactIds.add(fact.id);
  const linkedTasks = input.tasks.filter((task) => input.hypothesis.relatedTaskIds.includes(task.id) || task.hypothesisIds?.includes(input.hypothesis.id));
  const linkedPaths = input.attackPaths.filter((path) => path.hypothesisIds.includes(input.hypothesis.id));
  const linkedConsensus = input.consensus.filter((item) => linkedFactIds.has(item.findingId));
  const linkedFeedback = linkedConsensus.map((item) => input.feedback[item.findingId]).filter((item): item is ValidationFeedbackSummary => Boolean(item));

  const validFacts = linkedFacts.filter((fact) => fact.validity === "valid");
  const conflictedFacts = linkedFacts.filter((fact) => fact.validity === "conflicted");
  const supported = linkedConsensus.filter((item) => item.status === "supported");
  const refuted = linkedConsensus.filter((item) => item.status === "refuted");
  const conflicted = linkedConsensus.filter((item) => item.status === "conflicted");
  const verifiedPaths = linkedPaths.filter((path) => path.status === "validated");
  const invalidPaths = linkedPaths.filter((path) => path.status === "invalidated");
  const failedTasks = linkedTasks.filter((task) => task.status === "failed" || task.status === "rejected");
  const blockedTasks = linkedTasks.filter((task) => task.status === "blocked" || task.status === "out_of_scope");
  const doneTasks = linkedTasks.filter((task) => task.status === "done");
  const feedbackAdjustment = linkedFeedback.reduce((sum, item) => sum + item.scoreAdjustment, 0);

  const evidenceStrength = clamp(35
    + validFacts.reduce((sum, fact) => sum + Math.round(fact.confidence * 10), 0)
    + supported.length * 22 - refuted.length * 28 - conflicted.length * 8 - conflictedFacts.length * 10
    + linkedFeedback.reduce((sum, item) => sum + item.evidenceProduced * 3 + item.consensusAdvances * 6, 0));
  const pathRelevance = clamp(35 + linkedPaths.length * 8 + verifiedPaths.length * 25 - invalidPaths.length * 25
    + conflicted.length * 10 + linkedFeedback.reduce((sum, item) => sum + item.attackPathAdvances * 8, 0));
  const verificationCost = clamp(35 + failedTasks.length * 12 + blockedTasks.length * 18
    + linkedFeedback.reduce((sum, item) => sum + item.failures * 5 + item.noProgress * 3, 0) - doneTasks.length * 6);
  const operationRisk = clamp(30 + blockedTasks.length * 20 + linkedTasks.filter((task) => task.status === "out_of_scope").length * 30);
  const impact = clamp(50 + verifiedPaths.length * 10 + supported.length * 5 - invalidPaths.length * 8);
  const latestAt = [input.hypothesis.updatedAt, ...linkedFacts.map((fact) => fact.updatedAt || fact.createdAt), ...linkedTasks.map((task) => task.updatedAt), ...linkedPaths.map((path) => path.updatedAt)]
    .map((value) => Date.parse(value)).filter(Number.isFinite).sort((left, right) => right - left)[0];
  const ageDays = latestAt === undefined ? 30 : Math.max(0, ((input.now ?? new Date()).getTime() - latestAt) / 86_400_000);
  const freshness = clamp(100 - ageDays * 4);
  const factors = { impact, evidenceStrength, verificationCost, operationRisk, pathRelevance, freshness };
  const changed = Object.keys(factors).some((key) => factors[key as keyof typeof factors] !== current[key as keyof typeof current]);
  const signals = [
    `${validFacts.length} valid fact(s)`,
    `${supported.length} supported / ${conflicted.length} conflicted / ${refuted.length} refuted consensus`,
    `${verifiedPaths.length} validated / ${invalidPaths.length} invalidated path(s)`,
    `${doneTasks.length} completed / ${failedTasks.length} failed / ${blockedTasks.length} blocked task(s)`,
    `outcome adjustment ${feedbackAdjustment >= 0 ? "+" : ""}${feedbackAdjustment}`,
  ];
  return { factors, changed, evidenceFactIds: [...linkedFactIds], reason: `Automatic validation feedback: ${signals.join("; ")}.` };
}

export class HypothesisFeedbackCoordinator {
  constructor(
    private hypotheses: HypothesisStore,
    private facts: FactStore,
    private tasks: TaskStore,
    private attackPaths: AttackPathStore,
    private consensus: ValidationConsensusStore,
  ) {}

  reconcile(caseId: string, runId: string, feedback: Record<string, ValidationFeedbackSummary>): Hypothesis[] {
    const facts = this.facts.listByCase(caseId);
    const tasks = this.tasks.listByCase(caseId);
    const attackPaths = this.attackPaths.listByCase(caseId);
    const consensus = this.consensus.listByCase(caseId);
    const changed: Hypothesis[] = [];
    for (const hypothesis of this.hypotheses.listByCase(caseId).filter((item) => item.runId === runId && ["candidate", "active"].includes(item.status))) {
      const result = deriveHypothesisFeedback({ hypothesis, facts, tasks, attackPaths, consensus, feedback });
      if (!result.changed) continue;
      const updated = this.hypotheses.update(hypothesis.id, { scoreFactors: result.factors }, {
        kind: "updated",
        reason: result.reason,
        evidenceFactIds: result.evidenceFactIds,
      });
      if (updated) changed.push(updated);
    }
    return changed;
  }
}
