import { describe, expect, it } from "vitest";
import { makeRecordTaskTool } from "@traceforge/extension";
import { createDb } from "./db/client.js";
import { HypothesisStore } from "./stores/hypothesis-store.js";
import { TaskStore } from "./stores/task-store.js";
import { TimelineStore } from "./stores/timeline-store.js";
import { evaluateValidationTaskExecutionTransition } from "./validation-task-execution.js";

function setup() {
  const db = createDb(":memory:");
  const hypotheses = new HypothesisStore(db);
  const tasks = new TaskStore(db);
  const timeline = new TimelineStore(db);
  const hypothesis = hypotheses.create("case_1", { runId: "run_1", statement: "Validate ownership", basedOnFactIds: [], status: "active" });
  const tool = makeRecordTaskTool(
    "case_1", tasks, timeline, () => undefined, "run_1", hypotheses, undefined,
    (current, requestedStatus) => evaluateValidationTaskExecutionTransition({ current, requestedStatus, tasks: tasks.listByCase("case_1") }),
  );
  return { hypotheses, tasks, hypothesis, tool };
}

describe("validation task execution attribution with real SQLite", () => {
  it("requires the current validation task to be released before another starts in the same Run", async () => {
    const { tasks, hypothesis, tool } = setup();
    const first = tasks.create("case_1", {
      runId: "run_1", title: "[Consensus:fact_1:insufficient] first", status: "running", reason: "",
      blockedBy: [], triggerWhen: [], relatedFacts: [], hypothesisIds: [hypothesis.id], priority: "high",
    });
    const second = tasks.create("case_1", {
      runId: "run_1", title: "[Consensus:fact_2:conflicted] second", status: "open", reason: "",
      blockedBy: [], triggerWhen: [], relatedFacts: [], hypothesisIds: [hypothesis.id], priority: "high",
    });
    const denied = await tool.execute({ id: second.id, title: second.title, status: "running" });
    expect(denied.ok).toBe(false);
    expect(denied.content).toContain(first.id);
    expect(tasks.getById(second.id)?.status).toBe("open");
    expect((await tool.execute({ id: first.id, title: first.title, status: "open" })).ok).toBe(true);
    expect((await tool.execute({ id: second.id, title: second.title, status: "running" })).ok).toBe(true);
  });

  it("does not restrict an ordinary task while validation is running", async () => {
    const { tasks, hypothesis, tool } = setup();
    tasks.create("case_1", {
      runId: "run_1", title: "[Consensus:fact_1:supported] verify", status: "running", reason: "",
      blockedBy: [], triggerWhen: [], relatedFacts: [], hypothesisIds: [hypothesis.id], priority: "high",
    });
    const ordinary = tasks.create("case_1", {
      runId: "run_1", title: "Explore password reset", status: "open", reason: "",
      blockedBy: [], triggerWhen: [], relatedFacts: [], hypothesisIds: [hypothesis.id], priority: "medium",
    });
    expect((await tool.execute({ id: ordinary.id, title: ordinary.title, status: "running" })).ok).toBe(true);
  });
});
