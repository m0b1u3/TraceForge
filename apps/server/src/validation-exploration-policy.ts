import type { ValidationPriorityShift } from "./validation-priority-hysteresis.js";
import type { RankedValidationTask } from "./validation-task-priority.js";

export const MAX_CONSECUTIVE_VALIDATION_SHIFTS = 2;
export const EXPLORATION_WINDOW_BOUNDARIES = 3;

export interface ValidationExplorationState {
  consecutiveValidationShifts: number;
  explorationBoundariesRemaining: number;
}

export interface ValidationExplorationDecision {
  allowValidationShift: boolean;
  bypassed: boolean;
  notifyExplorationWindow: boolean;
  explorationTaskId?: string;
  reason: "shift_allowed" | "critical_bypass" | "validated_path_bypass" | "exploration_window_opened" | "exploration_window_active";
  state: ValidationExplorationState;
}

export function initialValidationExplorationState(): ValidationExplorationState {
  return { consecutiveValidationShifts: 0, explorationBoundariesRemaining: 0 };
}

export function advanceExplorationBoundary(state: ValidationExplorationState): ValidationExplorationState {
  if (state.explorationBoundariesRemaining <= 0) return state;
  const remaining = state.explorationBoundariesRemaining - 1;
  return {
    consecutiveValidationShifts: remaining === 0 ? 0 : state.consecutiveValidationShifts,
    explorationBoundariesRemaining: remaining,
  };
}

export function applyValidationExplorationPolicy(input: {
  state: ValidationExplorationState;
  shift: ValidationPriorityShift;
  ranked: RankedValidationTask[];
}): ValidationExplorationDecision {
  const prioritized = input.shift.next
    ? input.ranked.find((item) => item.task.id === input.shift.next?.taskId)
    : undefined;
  const critical = prioritized?.reasons.includes("severity:critical") ?? false;
  const validatedPath = prioritized?.reasons.includes("attack-path:validated") ?? false;
  if (critical || validatedPath) {
    return {
      allowValidationShift: true,
      bypassed: true,
      notifyExplorationWindow: false,
      reason: critical ? "critical_bypass" : "validated_path_bypass",
      state: input.state,
    };
  }

  const exploration = input.ranked.find((item) => !item.validation);
  if (!exploration) {
    return {
      allowValidationShift: true,
      bypassed: false,
      notifyExplorationWindow: false,
      reason: "shift_allowed",
      state: { ...input.state, consecutiveValidationShifts: input.state.consecutiveValidationShifts + 1 },
    };
  }
  if (input.state.explorationBoundariesRemaining > 0) {
    return {
      allowValidationShift: false,
      bypassed: false,
      notifyExplorationWindow: false,
      explorationTaskId: exploration.task.id,
      reason: "exploration_window_active",
      state: input.state,
    };
  }
  if (input.state.consecutiveValidationShifts >= MAX_CONSECUTIVE_VALIDATION_SHIFTS) {
    return {
      allowValidationShift: false,
      bypassed: false,
      notifyExplorationWindow: true,
      explorationTaskId: exploration.task.id,
      reason: "exploration_window_opened",
      state: { ...input.state, explorationBoundariesRemaining: EXPLORATION_WINDOW_BOUNDARIES },
    };
  }
  return {
    allowValidationShift: true,
    bypassed: false,
    notifyExplorationWindow: false,
    reason: "shift_allowed",
    state: { ...input.state, consecutiveValidationShifts: input.state.consecutiveValidationShifts + 1 },
  };
}
