import type { Task } from "@traceforge/shared";
import type { TaskStatusGateResult } from "@traceforge/extension";

const CONSENSUS_TASK = /^\[Consensus:[^:\]]+:(insufficient|supported|conflicted|refuted)\]/;

export function isConsensusValidationTask(task: Pick<Task, "title">): boolean {
  return CONSENSUS_TASK.test(task.title);
}

export function validationFindingId(task: Pick<Task, "title">): string | undefined {
  return /^\[Consensus:([^:\]]+):/.exec(task.title)?.[1];
}

export function evaluateValidationTaskExecutionTransition(input: {
  current: Task;
  requestedStatus: Task["status"];
  tasks: Task[];
}): TaskStatusGateResult {
  if (input.requestedStatus !== "running" || !isConsensusValidationTask(input.current)) return { allowed: true };
  const active = input.tasks.find((task) =>
    task.id !== input.current.id && task.runId === input.current.runId && task.status === "running" && isConsensusValidationTask(task));
  if (!active) return { allowed: true };
  return {
    allowed: false,
    message: `Validation task ${active.id} is already running in Run ${input.current.runId ?? "unassigned"}. Release or finish it before starting ${input.current.id}.`,
  };
}
