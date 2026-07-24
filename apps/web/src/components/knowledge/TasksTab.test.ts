import { describe, expect, it } from "vitest";
import type { Hypothesis, Task } from "@traceforge/shared";
import { getTaskGatePresentation } from "./TasksTab.js";

const task: Task = {
  id: "task_1",
  caseId: "case_1",
  runId: "run_1",
  title: "Replay privileged request",
  status: "blocked",
  reason: "Relationship gate",
  blockedBy: [],
  triggerWhen: [],
  relatedFacts: [],
  hypothesisIds: ["hyp_child"],
  relationshipGate: {
    blockedHypothesisIds: ["hyp_child"],
    resumeStatus: "approved",
    priorReason: "Operator approved controlled replay.",
  },
  priority: "high",
  createdAt: "now",
  updatedAt: "now",
  updateCount: 1,
};

const hypothesis: Hypothesis = {
  id: "hyp_child",
  caseId: "case_1",
  runId: "run_1",
  statement: "Authorization boundary can be bypassed",
  status: "candidate",
  priorityScore: 80,
  basedOnFactIds: ["fact_1"],
  relatedTaskIds: [task.id],
  createdAt: "now",
  updatedAt: "now",
  updateCount: 0,
  auditTrail: [],
};

describe("TasksTab relationship gate presentation", () => {
  it("resolves blocked hypothesis statements and the persisted resume state", () => {
    expect(getTaskGatePresentation(task, [hypothesis])).toEqual({
      blocked: [{ id: "hyp_child", statement: "Authorization boundary can be bypassed" }],
      resumeLabel: "Returns to approved when cleared",
    });
  });

  it("explains that a running task is not interrupted", () => {
    expect(getTaskGatePresentation({
      ...task,
      status: "running",
      relationshipGate: { ...task.relationshipGate!, resumeStatus: null },
    }, [hypothesis])?.resumeLabel).toBe("Current execution will not be interrupted");
  });
});
