import type { Task, TimelineEntry } from "@traceforge/shared";
import type { TaskStore } from "./stores/task-store.js";
import type { TimelineStore } from "./stores/timeline-store.js";
import { isConsensusValidationTask } from "./validation-task-execution.js";

export interface ValidationLeaseReleaseResult {
  tasks: Task[];
  timelineEntries: TimelineEntry[];
}

export function releaseValidationTaskLeases(input: {
  caseId: string;
  runId: string;
  reason: string;
  tasks: TaskStore;
  timeline: TimelineStore;
}): ValidationLeaseReleaseResult {
  const result: ValidationLeaseReleaseResult = { tasks: [], timelineEntries: [] };
  const running = input.tasks.listByCase(input.caseId).filter((task) =>
    task.runId === input.runId && task.status === "running" && isConsensusValidationTask(task));
  for (const task of running) {
    const released = input.tasks.update(task.id, {
      status: "recheck_candidate",
      reason: `[Validation lease released] ${input.reason}. Previous reason: ${task.reason || "none"}`,
      triggerWhen: [...new Set([...task.triggerWhen, "Resume in an active Run after reviewing the last recorded evidence."])],
    });
    if (!released) continue;
    result.tasks.push(released);
    result.timelineEntries.push(input.timeline.append(
      input.caseId,
      "validation_task_lease_released",
      `Task=${released.id}; Run=${input.runId}; reason=${input.reason}`,
      released.id,
      input.runId,
    ));
  }
  return result;
}
