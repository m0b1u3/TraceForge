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
  if (input.requestedStatus !== "running") return { allowed: true };
  const active = input.tasks.find((task) =>
    task.id !== input.current.id && task.runId === input.current.runId && task.status === "running");
  if (!active) return { allowed: true };
  return {
    allowed: false,
    message: `Validation task ${active.id} is already running in Run ${input.current.runId ?? "unassigned"}. Release or finish it before starting ${input.current.id}.`,
  };
}

export function evaluateRecordTaskValidationStatusTransition(input: {
  current: Task;
  requestedStatus: Task["status"];
  patch?: Partial<Task>;
  tasks?: Task[];
}): TaskStatusGateResult {
  if (input.requestedStatus === "running" && input.current.relationshipGate?.blockedHypothesisIds.length) {
    return {
      allowed: false,
      message: `Task ${input.current.id} is queued behind hypotheses ${input.current.relationshipGate.blockedHypothesisIds.join(", ")}.`,
    };
  }
  if (input.requestedStatus === "running" && input.tasks) {
    const execution = evaluateValidationTaskExecutionTransition({
      current: input.current,
      requestedStatus: input.requestedStatus,
      tasks: input.tasks,
    });
    if (!execution.allowed) return execution;
  }
  if (!isConsensusValidationTask(input.current)) return { allowed: true };
  const titleChanged = input.patch?.title !== undefined && input.patch.title !== input.current.title;
  if (!titleChanged && input.requestedStatus === input.current.status) return { allowed: true };
  return {
    allowed: false,
    message: `Consensus validation task ${input.current.id} title and status are controlled by manage_validation_task and the consensus workflow. Use claim, release, or complete instead of record_task.`,
  };
}
