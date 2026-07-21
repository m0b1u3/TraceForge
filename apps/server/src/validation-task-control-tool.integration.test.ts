import { describe, expect, it } from "vitest";
import { createDb } from "./db/client.js";
import { FactStore } from "./stores/fact-store.js";
import { HypothesisStore } from "./stores/hypothesis-store.js";
import { TaskStore } from "./stores/task-store.js";
import { TimelineStore } from "./stores/timeline-store.js";
import { ValidationConsensusStore } from "./stores/validation-consensus-store.js";
import { makeManageValidationTaskTool } from "./validation-task-control-tool.js";

function setup(status: "insufficient" | "conflicted" = "insufficient") {
  const db = createDb(":memory:");
  const facts = new FactStore(db);
  const hypotheses = new HypothesisStore(db);
  const tasks = new TaskStore(db);
  const consensus = new ValidationConsensusStore(db);
  const timeline = new TimelineStore(db);
  const hypothesis = hypotheses.create("case_1", { runId: "run_1", statement: "Validate ownership", basedOnFactIds: [], status: "active" });
  consensus.upsert("case_1", {
    findingId: "fact_1", status, independentSupports: 0, independentRefutes: 0, inconclusive: 0,
    duplicatesExcluded: 0, confidence: 0.5, recommendation: "collect_more", evidenceGroups: [], rationale: [],
  });
  const task = tasks.create("case_1", {
    runId: "run_1", title: "[Consensus:fact_1:insufficient] collect evidence", status: "open", reason: "",
    blockedBy: [], triggerWhen: [], relatedFacts: ["fact_1"], hypothesisIds: [hypothesis.id], priority: "high",
  });
  const tool = makeManageValidationTaskTool({ caseId: "case_1", runId: "run_1", facts, hypotheses, tasks, consensus, timeline, emit: () => undefined });
  return { tasks, timeline, task, tool };
}

describe("atomic validation task control with real SQLite", () => {
  it("claims, blocks premature completion, and records the transitions", async () => {
    const { tasks, timeline, task, tool } = setup();
    expect((await tool.execute({ taskId: task.id, action: "claim" })).ok).toBe(true);
    expect(tasks.getById(task.id)?.status).toBe("running");
    const completion = await tool.execute({ taskId: task.id, action: "complete" });
    expect(completion.ok).toBe(true);
    expect(completion.content).toContain("remains blocked");
    expect(tasks.getById(task.id)?.status).toBe("blocked");
    expect(timeline.listByCase("case_1").map((entry) => entry.eventType)).toEqual(["validation_task_claimed", "validation_task_completion_blocked"]);
  });

  it("rejects a stale task whose embedded consensus no longer matches", async () => {
    const { tasks, task, tool } = setup("conflicted");
    const result = await tool.execute({ taskId: task.id, action: "claim" });
    expect(result.ok).toBe(false);
    expect(result.content).toContain("stale");
    expect(tasks.getById(task.id)?.status).toBe("open");
  });

  it("releases a claimed task into a resumable state", async () => {
    const { tasks, task, tool } = setup();
    await tool.execute({ taskId: task.id, action: "claim" });
    expect((await tool.execute({ taskId: task.id, action: "release", reason: "pivot to identity setup" })).ok).toBe(true);
    expect(tasks.getById(task.id)?.status).toBe("recheck_candidate");
    expect(tasks.getById(task.id)?.reason).toBe("pivot to identity setup");
  });
});
