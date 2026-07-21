import { describe, expect, it } from "vitest";
import { TaskSchema } from "@traceforge/shared";
import type { RankedValidationTask } from "./validation-task-priority.js";
import { advanceExplorationBoundary, applyValidationExplorationPolicy, initialValidationExplorationState } from "./validation-exploration-policy.js";

const now = "2026-07-21T00:00:00.000Z";
function ranked(id: string, validation: boolean, reasons: string[]): RankedValidationTask {
  return {
    task: TaskSchema.parse({
      id, caseId: "case_1", runId: "run_1", title: id, status: "open", reason: "", blockedBy: [],
      triggerWhen: [], relatedFacts: [], hypothesisIds: ["hyp_1"], priority: "high", createdAt: now, updatedAt: now,
    }),
    score: validation ? 90 : 50,
    validation,
    reasons,
  };
}
const shift = { shifted: true, next: { taskId: "validation", score: 90 }, reason: "score_hysteresis_exceeded" as const };

describe("validation/exploration anti-starvation policy", () => {
  it("opens a three-boundary exploration window after two validation shifts", () => {
    const decision = applyValidationExplorationPolicy({
      state: { consecutiveValidationShifts: 2, explorationBoundariesRemaining: 0 },
      shift,
      ranked: [ranked("validation", true, ["severity:high"]), ranked("explore", false, ["task:high"])],
    });
    expect(decision.allowValidationShift).toBe(false);
    expect(decision.explorationTaskId).toBe("explore");
    expect(decision.state.explorationBoundariesRemaining).toBe(3);
  });

  it("resets the validation shift count when the exploration window expires", () => {
    let state = { consecutiveValidationShifts: 2, explorationBoundariesRemaining: 3 };
    state = advanceExplorationBoundary(state);
    state = advanceExplorationBoundary(state);
    state = advanceExplorationBoundary(state);
    expect(state).toEqual(initialValidationExplorationState());
  });

  it.each(["severity:critical", "attack-path:validated"])("allows %s to bypass the exploration window", (reason) => {
    const decision = applyValidationExplorationPolicy({
      state: { consecutiveValidationShifts: 2, explorationBoundariesRemaining: 2 },
      shift,
      ranked: [ranked("validation", true, [reason]), ranked("explore", false, ["task:high"])],
    });
    expect(decision.allowValidationShift).toBe(true);
    expect(decision.bypassed).toBe(true);
  });

  it("does not defer validation when no exploration task is actionable", () => {
    const decision = applyValidationExplorationPolicy({
      state: { consecutiveValidationShifts: 2, explorationBoundariesRemaining: 0 },
      shift,
      ranked: [ranked("validation", true, ["severity:high"])],
    });
    expect(decision.allowValidationShift).toBe(true);
  });
});
