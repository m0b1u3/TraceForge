import type { RankedValidationTask } from "./validation-task-priority.js";

export const VALIDATION_PRIORITY_HYSTERESIS = 12;
export const VALIDATION_PRIORITY_ENTRY_SCORE = 65;

export interface ValidationPriorityLeader {
  taskId: string;
  score: number;
}

export interface ValidationPriorityShift {
  shifted: boolean;
  previous?: ValidationPriorityLeader;
  next?: ValidationPriorityLeader;
  reason: "unchanged" | "no_validation_work" | "new_high_priority_validation" | "current_task_settled" | "score_hysteresis_exceeded";
}

export function validationPriorityLeader(ranked: RankedValidationTask[]): ValidationPriorityLeader | undefined {
  const first = ranked.find((item) => item.validation);
  return first ? { taskId: first.task.id, score: first.score } : undefined;
}

export function decideValidationPriorityShift(input: {
  previous?: ValidationPriorityLeader;
  ranked: RankedValidationTask[];
  hysteresis?: number;
  entryScore?: number;
}): ValidationPriorityShift {
  const next = validationPriorityLeader(input.ranked);
  if (!next) return { shifted: false, previous: input.previous, reason: "no_validation_work" };
  if (!input.previous) {
    const shifted = next.score >= (input.entryScore ?? VALIDATION_PRIORITY_ENTRY_SCORE);
    return { shifted, next, reason: shifted ? "new_high_priority_validation" : "unchanged" };
  }
  if (next.taskId === input.previous.taskId) {
    return { shifted: false, previous: input.previous, next, reason: "unchanged" };
  }
  const previousStillActive = input.ranked.some((item) => item.task.id === input.previous?.taskId);
  if (!previousStillActive) {
    return { shifted: true, previous: input.previous, next, reason: "current_task_settled" };
  }
  const shifted = next.score >= input.previous.score + (input.hysteresis ?? VALIDATION_PRIORITY_HYSTERESIS);
  return {
    shifted,
    previous: input.previous,
    next,
    reason: shifted ? "score_hysteresis_exceeded" : "unchanged",
  };
}
