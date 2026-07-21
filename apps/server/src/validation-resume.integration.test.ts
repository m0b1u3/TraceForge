import { describe, expect, it } from "vitest";
import { createDb } from "./db/client.js";
import { FactStore } from "./stores/fact-store.js";
import { HypothesisStore } from "./stores/hypothesis-store.js";
import { TaskStore } from "./stores/task-store.js";
import { TimelineStore } from "./stores/timeline-store.js";
import { ValidationConsensusStore } from "./stores/validation-consensus-store.js";
import { ActionCardStore } from "./stores/action-store.js";
import { resumePendingValidations } from "./validation-resume.js";

describe("cross-Run validation resumption with real SQLite", () => {
  it("derives one current-Run hypothesis and task from unresolved project consensus", () => {
    const db = createDb(":memory:");
    const facts = new FactStore(db);
    const hypotheses = new HypothesisStore(db);
    const tasks = new TaskStore(db);
    const consensus = new ValidationConsensusStore(db);
    const timeline = new TimelineStore(db);
    const actions = new ActionCardStore(db);
    const evidence = facts.create("case_1", {
      type: "http_observation", title: "Cross-account response", value: {},
      source: { type: "traffic", ref: "traffic_1" }, confidence: 1, tags: [],
    });
    const oldHypothesis = hypotheses.create("case_1", {
      runId: "run_1", statement: "Object ownership may be missing",
      basedOnFactIds: [evidence.id], status: "active",
    });
    const oldTask = tasks.create("case_1", {
      runId: "run_1", title: "Compare order ownership", status: "done", reason: "captured",
      blockedBy: [], triggerWhen: [], relatedFacts: [evidence.id], hypothesisIds: [oldHypothesis.id], priority: "high",
    });
    const action = actions.create({
      id: "action_run_1", caseId: "case_1", title: "Replay order request", goal: "Validate ownership",
      evidenceRefs: [evidence.id], hypothesisRefs: [oldHypothesis.id], taskRefs: [oldTask.id],
      reasoning: "change identity only", steps: ["replay"], expectedResults: ["deny"], riskNotes: [],
      tool: "compare_identity_traffic", priority: "high", requiresHumanApproval: false, status: "succeeded",
      createdAt: "2026-07-21T00:00:00.000Z", updatedAt: "2026-07-21T00:00:00.000Z",
    });
    const finding = facts.create("case_1", {
      type: "finding", title: "Possible order IDOR", value: {},
      source: { type: "agent", ref: "run_1" }, confidence: 0.8, tags: [],
      evidenceRefs: [evidence.id], hypothesisIds: [oldHypothesis.id], taskIds: [oldTask.id], actionIds: [action.id],
    });
    facts.update(finding.id, { findingStatus: "validating" });
    consensus.upsert("case_1", {
      findingId: finding.id, status: "insufficient", independentSupports: 1,
      independentRefutes: 0, inconclusive: 0, duplicatesExcluded: 0, confidence: 0.6,
      recommendation: "collect_more", evidenceGroups: [], rationale: ["one independent group"],
    });

    const input = { caseId: "case_1", runId: "run_2", facts, hypotheses, tasks, consensus, timeline };
    const first = resumePendingValidations(input);
    const second = resumePendingValidations(input);

    expect(first.hypotheses).toHaveLength(1);
    expect(first.tasks).toHaveLength(1);
    expect(second.hypotheses).toHaveLength(0);
    expect(second.tasks).toHaveLength(0);
    const resumedTask = tasks.listByCase("case_1").find((item) => item.runId === "run_2");
    expect(resumedTask?.hypothesisIds).toEqual([first.hypotheses[0].id]);
    expect(resumedTask?.hypothesisIds).not.toContain(oldHypothesis.id);
    expect(timeline.listByCase("case_1").filter((item) => item.eventType === "validation_followup_resumed")).toHaveLength(1);
  });

  it("does not resume a supported Finding whose evidence lifecycle is already complete", () => {
    const db = createDb(":memory:");
    const facts = new FactStore(db);
    const hypotheses = new HypothesisStore(db);
    const tasks = new TaskStore(db);
    const consensus = new ValidationConsensusStore(db);
    const timeline = new TimelineStore(db);
    const actions = new ActionCardStore(db);
    const evidence = facts.create("case_1", {
      type: "http_observation", title: "Foreign order returned", value: {},
      source: { type: "traffic", ref: "traffic_1" }, confidence: 1, tags: [],
    });
    const hypothesis = hypotheses.create("case_1", {
      runId: "run_1", statement: "Order ownership is missing", basedOnFactIds: [evidence.id], status: "active",
    });
    const task = tasks.create("case_1", {
      runId: "run_1", title: "Validate order ownership", status: "done", reason: "reproduced",
      blockedBy: [], triggerWhen: [], relatedFacts: [evidence.id], hypothesisIds: [hypothesis.id], priority: "high",
    });
    const action = actions.create({
      id: "action_verified", caseId: "case_1", title: "Replay as second user", goal: "Validate ownership",
      evidenceRefs: [evidence.id], hypothesisRefs: [hypothesis.id], taskRefs: [task.id],
      reasoning: "change identity only", steps: ["replay"], expectedResults: ["deny"], riskNotes: [],
      tool: "compare_identity_traffic", priority: "high", requiresHumanApproval: false, status: "succeeded",
      createdAt: "2026-07-21T00:00:00.000Z", updatedAt: "2026-07-21T00:00:00.000Z",
    });
    const candidate = facts.create("case_1", {
      type: "finding", title: "Verified order IDOR", value: {},
      source: { type: "agent", ref: "run_1" }, confidence: 1, tags: [],
      evidenceRefs: [evidence.id], hypothesisIds: [hypothesis.id], taskIds: [task.id], actionIds: [action.id],
    });
    facts.update(candidate.id, { findingStatus: "validating" });
    const finding = facts.update(candidate.id, {
      findingStatus: "verified", verificationSummary: "Reproduced across identities.",
      observations: [{ id: "obs_1", sourceType: "traffic", sourceRef: "traffic_1", condition: "second user requests first user's order", summary: "foreign order returned", observedAt: "2026-07-21T00:00:00.000Z" }],
    })!;
    consensus.upsert("case_1", {
      findingId: finding.id, status: "supported", independentSupports: 2,
      independentRefutes: 0, inconclusive: 0, duplicatesExcluded: 0, confidence: 0.95,
      recommendation: "mark_verified", evidenceGroups: [], rationale: ["two groups"],
    });

    const resumed = resumePendingValidations({ caseId: "case_1", runId: "run_2", facts, hypotheses, tasks, consensus, timeline });
    expect(resumed.tasks).toHaveLength(0);
    expect(hypotheses.listByCase("case_1").filter((item) => item.runId === "run_2")).toHaveLength(0);
  });
});
