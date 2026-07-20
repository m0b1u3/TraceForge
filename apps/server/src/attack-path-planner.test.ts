import { describe, expect, it } from "vitest";
import { AttackPathSchema, HypothesisSchema, TaskSchema } from "@traceforge/shared";
import { formatAttackPathPlan, rankAttackPathBreakpoints } from "./attack-path-planner.js";

const now = "2026-07-20T00:00:00.000Z";
const hypothesis = HypothesisSchema.parse({
  id: "hyp_order", caseId: "case_1", runId: "run_2", statement: "Order ownership missing",
  status: "active", priorityScore: 90, basedOnFactIds: ["fact_order"], createdAt: now, updatedAt: now,
});
const task = TaskSchema.parse({
  id: "task_write", caseId: "case_1", runId: "run_2", title: "Verify write impact",
  status: "open", reason: "", blockedBy: [], triggerWhen: [], relatedFacts: ["fact_order"],
  hypothesisIds: ["hyp_order"], priority: "high", createdAt: now, updatedAt: now,
});

function path(id: string, kind: "request" | "impact", status: "proposed" | "observed", confidence: number) {
  return AttackPathSchema.parse({
    id, caseId: "case_1", title: id === "path_order" ? "Order IDOR chain" : "Destructive impact chain",
    objective: id === "path_order" ? "Validate order write authorization" : "Trigger destructive impact",
    status: "exploring", confidence, sourceRunId: "run_1", lastRunId: "run_2",
    hypothesisIds: ["hyp_order"], evidenceRefs: ["fact_order"], breakpoint: "Verify foreign order mutation",
    steps: [{
      id: `${id}_step`, order: 0, kind, title: "Change foreign order", description: "",
      status, factIds: [], taskId: id === "path_order" ? "task_write" : null,
      validation: "Controlled identity differential",
    }],
    createdAt: now, updatedAt: now,
  });
}

describe("attack-path breakpoint planning", () => {
  it("prioritizes relevant evidence gain over a riskier local path", () => {
    const candidates = rankAttackPathBreakpoints({
      paths: [path("path_impact", "impact", "proposed", 0.95), path("path_order", "request", "observed", 0.8)],
      hypotheses: [hypothesis],
      tasks: [task],
      goal: "validate order IDOR write authorization",
    });
    expect(candidates[0].pathId).toBe("path_order");
    expect(candidates[0].nextAction).toContain("task_write");
  });

  it("excludes completed paths and keeps the plan open to new evidence", () => {
    const completed = { ...path("path_done", "request", "observed", 1), status: "validated" as const };
    const candidates = rankAttackPathBreakpoints({
      paths: [completed], hypotheses: [hypothesis], tasks: [task], goal: "order",
    });
    expect(candidates).toEqual([]);
    expect(formatAttackPathPlan(candidates)).toContain("Continue open hypothesis discovery");
  });
});
