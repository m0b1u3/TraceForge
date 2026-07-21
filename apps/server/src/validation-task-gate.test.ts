import { describe, expect, it } from "vitest";
import { FactSchema, HypothesisSchema, TaskSchema } from "@traceforge/shared";
import type { ValidationConsensusResult } from "./validation-consensus.js";
import { evaluateValidationTaskCompletion } from "./validation-task-gate.js";

const now = "2026-07-21T00:00:00.000Z";
const finding = FactSchema.parse({
  id: "fact_idor", caseId: "case_1", type: "finding", title: "Order IDOR",
  value: {}, source: { type: "agent", ref: "run_1" }, confidence: 1, tags: [],
  validity: "valid", findingStatus: "validating", evidenceRefs: ["fact_evidence"],
  hypothesisIds: ["hyp_original"], taskIds: ["task_original"], actionIds: ["action_1"],
  observations: [], createdAt: now, updatedAt: now,
});
const task = (status: string) => TaskSchema.parse({
  id: `task_${status}`, caseId: "case_1", runId: "run_2",
  title: `[Consensus:${finding.id}:${status}] follow up`, status: "done", reason: "",
  blockedBy: [], triggerWhen: [], relatedFacts: [finding.id], hypothesisIds: finding.hypothesisIds,
  priority: "high", createdAt: now, updatedAt: now,
});
const consensus = (status: ValidationConsensusResult["status"]): ValidationConsensusResult => ({
  findingId: finding.id, status,
  independentSupports: status === "supported" ? 2 : status === "conflicted" ? 1 : 0,
  independentRefutes: status === "refuted" ? 2 : status === "conflicted" ? 1 : 0,
  inconclusive: 0, duplicatesExcluded: 0, confidence: 0.9,
  recommendation: status === "supported" ? "mark_verified" : status === "refuted" ? "consider_rejected" : status === "conflicted" ? "keep_needs_review" : "collect_more",
  evidenceGroups: [], rationale: [],
});

describe("validation task completion gate", () => {
  it("leaves ordinary tasks outside the consensus gate", () => {
    const ordinary = { ...task("insufficient"), title: "Inspect another endpoint" };
    expect(evaluateValidationTaskCompletion({ task: ordinary, facts: [], consensus: [], hypotheses: [] }).allowed).toBe(true);
  });

  it("blocks insufficient and conflicted tasks until consensus changes", () => {
    expect(evaluateValidationTaskCompletion({ task: task("insufficient"), facts: [finding], consensus: [consensus("insufficient")], hypotheses: [] }).missing[0]).toContain("independent");
    expect(evaluateValidationTaskCompletion({ task: task("conflicted"), facts: [finding], consensus: [consensus("conflicted")], hypotheses: [] }).missing[0]).toContain("conflict");
  });

  it("requires the complete verified Finding chain for supported consensus", () => {
    const blocked = evaluateValidationTaskCompletion({ task: task("supported"), facts: [finding], consensus: [consensus("supported")], hypotheses: [] });
    expect(blocked.missing).toEqual(expect.arrayContaining(["write a verification summary", "record at least one source-linked Observation", "complete the Finding lifecycle transition to verified"]));
    const verified = FactSchema.parse({
      ...finding, findingStatus: "verified", verificationSummary: "Reproduced twice.",
      observations: [{ id: "obs_1", sourceType: "traffic", sourceRef: "traffic_1", summary: "same secret", observedAt: now }],
    });
    expect(evaluateValidationTaskCompletion({ task: task("supported"), facts: [verified], consensus: [consensus("supported")], hypotheses: [] }).allowed).toBe(true);
  });

  it("allows refuted closure through rejection or an evidence-linked adjacent hypothesis", () => {
    const adjacent = HypothesisSchema.parse({
      id: "hyp_adjacent", caseId: "case_1", runId: "run_2", statement: "Different asset boundary",
      status: "active", basedOnFactIds: ["fact_evidence"], createdAt: now, updatedAt: now,
    });
    expect(evaluateValidationTaskCompletion({ task: task("refuted"), facts: [finding], consensus: [consensus("refuted")], hypotheses: [] }).allowed).toBe(false);
    expect(evaluateValidationTaskCompletion({ task: task("refuted"), facts: [finding], consensus: [consensus("refuted")], hypotheses: [adjacent] }).allowed).toBe(true);
  });
});
