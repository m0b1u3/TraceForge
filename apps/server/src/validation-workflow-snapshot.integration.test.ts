import { describe, expect, it } from "vitest";
import { createDb } from "./db/client.js";
import { AttackPathStore } from "./stores/attack-path-store.js";
import { FactStore } from "./stores/fact-store.js";
import { HypothesisStore } from "./stores/hypothesis-store.js";
import { TaskStore } from "./stores/task-store.js";
import { TimelineStore } from "./stores/timeline-store.js";
import { ValidationConsensusStore } from "./stores/validation-consensus-store.js";
import { buildValidationWorkflowSnapshot, makeGetValidationWorkflowStateTool } from "./validation-workflow-snapshot.js";

describe("validation workflow snapshot with real SQLite", () => {
  it("aggregates consensus, lease, priority, missing evidence, feedback, and audit issues", async () => {
    const db = createDb(":memory:");
    const facts = new FactStore(db);
    const hypotheses = new HypothesisStore(db);
    const tasks = new TaskStore(db);
    const consensus = new ValidationConsensusStore(db);
    const paths = new AttackPathStore(db);
    const timeline = new TimelineStore(db);
    consensus.upsert("case_1", {
      findingId: "fact_missing", status: "insufficient", independentSupports: 0, independentRefutes: 0,
      inconclusive: 0, duplicatesExcluded: 0, confidence: 0.4, recommendation: "collect_more", evidenceGroups: [], rationale: [],
    });
    const task = tasks.create("case_1", {
      runId: "run_1", title: "[Consensus:fact_missing:insufficient] collect evidence", status: "running",
      reason: "[Consistency audit] Finding fact_missing is missing.", blockedBy: [], triggerWhen: [],
      relatedFacts: [], hypothesisIds: ["hyp_missing"], priority: "high",
    });
    timeline.append("case_1", "validation_feedback_recorded", JSON.stringify({
      findingId: "fact_missing", taskId: task.id, tool: "replay_traffic", evidenceProduced: 0,
      consensusAdvanced: false, attackPathAdvanced: false, failed: false, noProgress: true,
    }), task.id, "run_1");

    const get = () => buildValidationWorkflowSnapshot({
      caseId: "case_1", runId: "run_1", facts, hypotheses, tasks, consensus, paths, timeline,
      runtime: { leader: { taskId: task.id, score: 72 }, exploration: { consecutiveValidationShifts: 1, explorationBoundariesRemaining: 2 } },
    });
    const snapshot = get();
    expect(snapshot.runningLease).toBe(task.id);
    expect(snapshot.items[0].missingEvidence).toContain("Finding fact_missing is missing");
    expect(snapshot.items[0].feedback?.noProgress).toBe(1);
    expect(snapshot.auditIssues).toHaveLength(1);
    const toolResult = await makeGetValidationWorkflowStateTool(get).execute({});
    expect(toolResult.ok).toBe(true);
    expect(JSON.parse(toolResult.content).leader.taskId).toBe(task.id);
  });
});
