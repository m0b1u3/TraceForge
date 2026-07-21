import { describe, expect, it } from "vitest";
import { TaskSchema } from "@traceforge/shared";
import type { RankedValidationTask } from "./validation-task-priority.js";
import { decideValidationPriorityShift } from "./validation-priority-hysteresis.js";

const now = "2026-07-21T00:00:00.000Z";
function ranked(id: string, score: number, validation = true): RankedValidationTask {
  return {
    task: TaskSchema.parse({
      id, caseId: "case_1", runId: "run_1", title: id, status: "open", reason: "",
      blockedBy: [], triggerWhen: [], relatedFacts: [], hypothesisIds: ["hyp_1"], priority: "high",
      createdAt: now, updatedAt: now,
    }),
    score,
    validation,
    reasons: [`score:${score}`],
  };
}

describe("validation priority hysteresis", () => {
  it("ignores a different leader when its advantage is below the hysteresis", () => {
    const result = decideValidationPriorityShift({
      previous: { taskId: "task_a", score: 80 },
      ranked: [ranked("task_b", 90), ranked("task_a", 80)],
    });
    expect(result.shifted).toBe(false);
    expect(result.reason).toBe("unchanged");
  });

  it("soft-switches when a new leader exceeds the score hysteresis", () => {
    const result = decideValidationPriorityShift({
      previous: { taskId: "task_a", score: 80 },
      ranked: [ranked("task_b", 93), ranked("task_a", 80)],
    });
    expect(result.shifted).toBe(true);
    expect(result.reason).toBe("score_hysteresis_exceeded");
    expect(result.next?.taskId).toBe("task_b");
  });

  it("continues with the next validation when the current task leaves the active queue", () => {
    const result = decideValidationPriorityShift({
      previous: { taskId: "task_a", score: 95 },
      ranked: [ranked("task_b", 70)],
    });
    expect(result.shifted).toBe(true);
    expect(result.reason).toBe("current_task_settled");
  });

  it("does not introduce low-scoring validation work into an exploration run", () => {
    const result = decideValidationPriorityShift({ ranked: [ranked("task_low", 60)] });
    expect(result.shifted).toBe(false);
  });
});
