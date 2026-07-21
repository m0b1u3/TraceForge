import { describe, expect, it } from "vitest";
import { createDb } from "./db/client.js";
import { TaskStore } from "./stores/task-store.js";
import { TimelineStore } from "./stores/timeline-store.js";
import { releaseValidationTaskLeases } from "./validation-task-lease.js";

describe("validation task lease recovery with real SQLite", () => {
  it("releases only running consensus validation tasks from the terminated Run and is idempotent", () => {
    const db = createDb(":memory:");
    const tasks = new TaskStore(db);
    const timeline = new TimelineStore(db);
    const validation = tasks.create("case_1", {
      runId: "run_1", title: "[Consensus:fact_1:conflicted] isolate variable", status: "running", reason: "testing",
      blockedBy: [], triggerWhen: [], relatedFacts: ["fact_1"], hypothesisIds: ["hyp_1"], priority: "high",
    });
    const ordinary = tasks.create("case_1", {
      runId: "run_1", title: "Explore reset flow", status: "running", reason: "exploring",
      blockedBy: [], triggerWhen: [], relatedFacts: [], hypothesisIds: ["hyp_1"], priority: "medium",
    });
    const otherRun = tasks.create("case_1", {
      runId: "run_2", title: "[Consensus:fact_2:insufficient] collect evidence", status: "running", reason: "testing",
      blockedBy: [], triggerWhen: [], relatedFacts: ["fact_2"], hypothesisIds: ["hyp_2"], priority: "high",
    });

    const first = releaseValidationTaskLeases({ caseId: "case_1", runId: "run_1", reason: "run interrupted", tasks, timeline });
    const second = releaseValidationTaskLeases({ caseId: "case_1", runId: "run_1", reason: "run interrupted", tasks, timeline });
    expect(first.tasks.map((task) => task.id)).toEqual([validation.id]);
    expect(second.tasks).toHaveLength(0);
    expect(tasks.getById(validation.id)?.status).toBe("recheck_candidate");
    expect(tasks.getById(validation.id)?.reason).toContain("run interrupted");
    expect(tasks.getById(ordinary.id)?.status).toBe("running");
    expect(tasks.getById(otherRun.id)?.status).toBe("running");
    expect(timeline.listByCase("case_1").filter((entry) => entry.eventType === "validation_task_lease_released")).toHaveLength(1);
  });
});
