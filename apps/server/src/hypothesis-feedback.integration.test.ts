import { describe, expect, it } from "vitest";
import { createDb } from "./db/client.js";
import { HypothesisFeedbackCoordinator, deriveHypothesisFeedback } from "./hypothesis-feedback.js";
import { HypothesisStore } from "./stores/hypothesis-store.js";
import { FactStore } from "./stores/fact-store.js";
import { TaskStore } from "./stores/task-store.js";
import { AttackPathStore } from "./stores/attack-path-store.js";
import { ValidationConsensusStore } from "./stores/validation-consensus-store.js";
import type { Hypothesis } from "@traceforge/shared";
import type { ValidationConsensusResult } from "./validation-consensus.js";

const now = "2026-07-22T00:00:00.000Z";
const hypothesis = (scoreFactors?: Hypothesis["scoreFactors"]): Hypothesis => ({
  id: "hyp_1", caseId: "case_1", runId: "run_1", statement: "Possible authorization bypass", status: "candidate",
  priorityScore: 50, scoreFactors, basedOnFactIds: ["fact_1"], relatedTaskIds: ["task_1"],
  createdAt: now, updatedAt: now, updateCount: 0, auditTrail: [],
});

const consensus = (status: ValidationConsensusResult["status"]): ValidationConsensusResult => ({
  findingId: "fact_1", status,
  independentSupports: status === "supported" ? 2 : status === "conflicted" ? 1 : 0,
  independentRefutes: status === "refuted" ? 2 : status === "conflicted" ? 1 : 0,
  inconclusive: 0, duplicatesExcluded: 0, confidence: 0.9,
  recommendation: status === "supported" ? "mark_verified" : status === "refuted" ? "consider_rejected" : status === "conflicted" ? "keep_needs_review" : "collect_more",
  evidenceGroups: [], rationale: [],
});

describe("Hypothesis validation feedback with real state", () => {
  it("turns supported evidence and productive outcomes into stronger factors", () => {
    const result = deriveHypothesisFeedback({
      hypothesis: hypothesis(),
      facts: [{ id: "fact_1", caseId: "case_1", type: "note", title: "Observed ID", value: "42", source: { type: "traffic", ref: "req_1" }, confidence: 0.9, tags: [], createdAt: now, updatedAt: now, updateCount: 0, validity: "valid", hypothesisIds: ["hyp_1"] }],
      tasks: [{ id: "task_1", caseId: "case_1", runId: "run_1", title: "Verify access", status: "done", reason: "", blockedBy: [], triggerWhen: [], relatedFacts: ["fact_1"], hypothesisIds: ["hyp_1"], priority: "high", createdAt: now, updatedAt: now, updateCount: 0 }],
      attackPaths: [], consensus: [consensus("supported")],
      feedback: { fact_1: { toolBoundaries: 2, evidenceProduced: 2, consensusAdvances: 1, attackPathAdvances: 0, failures: 0, noProgress: 0, scoreAdjustment: 12 } },
      now: new Date(now),
    });
    expect(result.factors.evidenceStrength).toBeGreaterThan(70);
    expect(result.factors.verificationCost).toBeLessThan(50);
    expect(result.reason).toContain("supported");
  });

  it("keeps conflicted evidence valuable for review while repeated failures raise cost", () => {
    const result = deriveHypothesisFeedback({
      hypothesis: hypothesis(), facts: [], tasks: [], attackPaths: [], consensus: [consensus("conflicted")],
      feedback: { fact_1: { toolBoundaries: 6, evidenceProduced: 0, consensusAdvances: 0, attackPathAdvances: 0, failures: 2, noProgress: 3, scoreAdjustment: -16 } },
      now: new Date(now),
    });
    expect(result.factors.pathRelevance).toBeGreaterThan(35);
    expect(result.factors.verificationCost).toBeGreaterThan(50);
    expect(result.factors.evidenceStrength).toBeLessThan(50);
  });

  it("persists automatic feedback and remains idempotent on unchanged inputs", () => {
    const db = createDb(":memory:");
    const hypotheses = new HypothesisStore(db);
    const facts = new FactStore(db);
    const tasks = new TaskStore(db);
    const paths = new AttackPathStore(db);
    const consensusStore = new ValidationConsensusStore(db);
    const fact = facts.create("case_1", { type: "note", title: "Observed identifier", value: "42", source: { type: "traffic", ref: "req_1" }, confidence: 0.9, tags: [] });
    const stored = hypotheses.create("case_1", { runId: "run_1", statement: "Possible authorization bypass", basedOnFactIds: [fact.id] });
    facts.update(fact.id, { hypothesisIds: [stored.id] });
    tasks.create("case_1", { runId: "run_1", title: "Verify access", status: "done", reason: "", blockedBy: [], triggerWhen: [], relatedFacts: [fact.id], hypothesisIds: [stored.id], priority: "high" });
    consensusStore.upsert("case_1", { ...consensus("supported"), findingId: fact.id });
    const coordinator = new HypothesisFeedbackCoordinator(hypotheses, facts, tasks, paths, consensusStore);
    expect(coordinator.reconcile("case_1", "run_1", {})).toHaveLength(1);
    const first = hypotheses.getById(stored.id);
    expect(first?.auditTrail.at(-1)?.reason).toContain("Automatic validation feedback");
    expect(coordinator.reconcile("case_1", "run_1", {})).toHaveLength(0);
  });
});
