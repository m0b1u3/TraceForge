import { describe, expect, it } from "vitest";
import { createDb } from "./db/client.js";
import { ActionCardStore } from "./stores/action-store.js";
import { FactStore } from "./stores/fact-store.js";
import { HypothesisStore } from "./stores/hypothesis-store.js";
import { TaskStore } from "./stores/task-store.js";
import { TimelineStore } from "./stores/timeline-store.js";
import { ValidationConsensusStore } from "./stores/validation-consensus-store.js";
import { auditValidationWorkflow } from "./validation-workflow-audit.js";

describe("validation workflow consistency audit with real SQLite", () => {
  it("rejects orphaned and duplicate tasks while blocking cross-Run hypothesis attribution", () => {
    const db = createDb(":memory:");
    const facts = new FactStore(db);
    const hypotheses = new HypothesisStore(db);
    const tasks = new TaskStore(db);
    const actions = new ActionCardStore(db);
    const consensus = new ValidationConsensusStore(db);
    const timeline = new TimelineStore(db);
    const evidence = facts.create("case_1", { type: "http_observation", title: "response", value: {}, source: { type: "traffic", ref: "traffic_1" }, confidence: 1, tags: [] });
    const hypothesis = hypotheses.create("case_1", { runId: "run_1", statement: "ownership missing", basedOnFactIds: [evidence.id], status: "active" });
    const originTask = tasks.create("case_1", { runId: "run_1", title: "origin", status: "done", reason: "", blockedBy: [], triggerWhen: [], relatedFacts: [evidence.id], hypothesisIds: [hypothesis.id], priority: "high" });
    const action = actions.create({
      id: "action_1", caseId: "case_1", title: "replay", goal: "validate", evidenceRefs: [evidence.id], hypothesisRefs: [hypothesis.id], taskRefs: [originTask.id],
      reasoning: "identity differential", steps: ["replay"], expectedResults: ["denied"], riskNotes: [], tool: "replay_traffic", priority: "high",
      requiresHumanApproval: false, status: "succeeded", createdAt: "now", updatedAt: "now",
    });
    const finding = facts.create("case_1", {
      type: "finding", title: "Order IDOR", value: { severity: "high" }, source: { type: "agent", ref: "run_1" }, confidence: 0.8, tags: [],
      evidenceRefs: [evidence.id], hypothesisIds: [hypothesis.id], taskIds: [originTask.id], actionIds: [action.id],
    });
    consensus.upsert("case_1", { findingId: finding.id, status: "insufficient", independentSupports: 1, independentRefutes: 0, inconclusive: 0, duplicatesExcluded: 0, confidence: 0.6, recommendation: "collect_more", evidenceGroups: [], rationale: [] });
    const first = tasks.create("case_1", { runId: "run_1", title: `[Consensus:${finding.id}:insufficient] collect`, status: "open", reason: "", blockedBy: [], triggerWhen: [], relatedFacts: [finding.id], hypothesisIds: [hypothesis.id], priority: "high" });
    const duplicate = tasks.create("case_1", { runId: "run_1", title: first.title, status: "open", reason: "", blockedBy: [], triggerWhen: [], relatedFacts: [finding.id], hypothesisIds: [hypothesis.id], priority: "high" });
    const wrongRun = tasks.create("case_1", { runId: "run_2", title: `[Consensus:${finding.id}:insufficient] continue`, status: "open", reason: "", blockedBy: [], triggerWhen: [], relatedFacts: [finding.id], hypothesisIds: [hypothesis.id], priority: "high" });
    const orphan = tasks.create("case_1", { runId: "run_1", title: "[Consensus:missing:insufficient] orphan", status: "open", reason: "", blockedBy: [], triggerWhen: [], relatedFacts: [], hypothesisIds: [hypothesis.id], priority: "high" });
    const secondFinding = facts.create("case_1", {
      type: "finding", title: "Profile IDOR", value: { severity: "medium" }, source: { type: "agent", ref: "run_1" }, confidence: 0.7, tags: [],
      evidenceRefs: [evidence.id], hypothesisIds: [hypothesis.id], taskIds: [originTask.id], actionIds: [action.id],
    });
    consensus.upsert("case_1", { findingId: secondFinding.id, status: "insufficient", independentSupports: 0, independentRefutes: 0, inconclusive: 0, duplicatesExcluded: 0, confidence: 0.4, recommendation: "collect_more", evidenceGroups: [], rationale: [] });
    const secondLease = tasks.create("case_1", { runId: "run_1", title: `[Consensus:${secondFinding.id}:insufficient] collect`, status: "running", reason: "", blockedBy: [], triggerWhen: [], relatedFacts: [secondFinding.id], hypothesisIds: [hypothesis.id], priority: "high" });
    tasks.update(first.id, { status: "running" });

    const result = auditValidationWorkflow({ caseId: "case_1", facts, hypotheses, tasks, consensus, timeline });
    expect([tasks.getById(first.id)?.status, tasks.getById(secondLease.id)?.status].sort()).toEqual(["recheck_candidate", "running"]);
    expect(tasks.getById(duplicate.id)?.status).toBe("rejected");
    expect(tasks.getById(wrongRun.id)?.status).toBe("blocked");
    expect(tasks.getById(orphan.id)?.status).toBe("rejected");
    expect(result.timelineEntries).toHaveLength(4);
  });
});
