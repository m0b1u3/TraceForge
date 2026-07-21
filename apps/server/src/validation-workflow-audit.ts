import type { Task, TimelineEntry } from "@traceforge/shared";
import type { FactStore } from "./stores/fact-store.js";
import type { HypothesisStore } from "./stores/hypothesis-store.js";
import type { TaskStore } from "./stores/task-store.js";
import type { TimelineStore } from "./stores/timeline-store.js";
import type { ValidationConsensusStore } from "./stores/validation-consensus-store.js";

const KEY = /^\[Consensus:([^:\]]+):(insufficient|supported|conflicted|refuted)\]/;
const ACTIVE = new Set<Task["status"]>(["open", "blocked", "recheck_candidate", "approved", "running"]);

export interface ValidationWorkflowAuditResult {
  tasks: Task[];
  timelineEntries: TimelineEntry[];
}

export function auditValidationWorkflow(input: {
  caseId: string;
  facts: FactStore;
  hypotheses: HypothesisStore;
  tasks: TaskStore;
  consensus: ValidationConsensusStore;
  timeline: TimelineStore;
}): ValidationWorkflowAuditResult {
  const result: ValidationWorkflowAuditResult = { tasks: [], timelineEntries: [] };
  const facts = input.facts.listByCase(input.caseId);
  const hypotheses = input.hypotheses.listByCase(input.caseId);
  const consensus = input.consensus.listByCase(input.caseId);

  const update = (task: Task, patch: Parameters<TaskStore["update"]>[1], issue: string) => {
    const changed = input.tasks.update(task.id, patch);
    if (!changed) return;
    result.tasks.push(changed);
    result.timelineEntries.push(input.timeline.append(
      input.caseId,
      "validation_workflow_repaired",
      `Task=${task.id}; issue=${issue}; status=${changed.status}`,
      task.id,
      task.runId,
    ));
  };

  for (const task of input.tasks.listByCase(input.caseId).filter((item) => ACTIVE.has(item.status))) {
    const match = KEY.exec(task.title);
    if (!match) continue;
    const [, findingId, expectedStatus] = match;
    const finding = facts.find((item) => item.id === findingId && item.type === "finding");
    const state = consensus.find((item) => item.findingId === findingId);
    if (!finding || !state) {
      update(task, { status: "rejected", reason: `[Consistency audit] ${!finding ? "Finding" : "Consensus"} ${findingId} is missing.` }, "orphaned validation task");
      continue;
    }
    if (state.status !== expectedStatus) {
      update(task, { status: "rejected", reason: `[Consistency audit] Superseded by consensus ${state.status}.` }, `stale consensus ${expectedStatus}->${state.status}`);
      continue;
    }
    const linked = (task.hypothesisIds ?? []).map((id) => hypotheses.find((item) => item.id === id));
    if (!linked.length || linked.some((item) => !item || item.runId !== task.runId)) {
      update(task, {
        status: "blocked",
        reason: "[Consistency audit] Validation task lacks a valid same-Run Hypothesis.",
        triggerWhen: [...new Set([...task.triggerWhen, "Create or attach a Hypothesis owned by the same Run before claiming this task."])],
      }, "invalid Run/Hypothesis attribution");
    }
  }

  const repaired = input.tasks.listByCase(input.caseId).filter((task) => ACTIVE.has(task.status) && KEY.test(task.title));
  const duplicateGroups = new Map<string, Task[]>();
  for (const task of repaired) {
    const key = `${task.runId ?? "unassigned"}:${KEY.exec(task.title)?.[0] ?? task.title}`;
    duplicateGroups.set(key, [...(duplicateGroups.get(key) ?? []), task]);
  }
  for (const group of duplicateGroups.values()) {
    const ordered = group.sort((left, right) =>
      Number(right.status === "running") - Number(left.status === "running")
      || left.createdAt.localeCompare(right.createdAt)
      || left.id.localeCompare(right.id));
    for (const duplicate of ordered.slice(1)) {
      update(duplicate, { status: "rejected", reason: `[Consistency audit] Duplicate of active validation task ${ordered[0].id}.` }, "duplicate active validation task");
    }
  }

  const runningByRun = new Map<string, Task[]>();
  for (const task of input.tasks.listByCase(input.caseId).filter((item) => item.status === "running" && KEY.test(item.title))) {
    const key = task.runId ?? "unassigned";
    runningByRun.set(key, [...(runningByRun.get(key) ?? []), task]);
  }
  for (const group of runningByRun.values()) {
    const ordered = group.sort((left, right) => left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id));
    for (const extra of ordered.slice(1)) {
      update(extra, {
        status: "recheck_candidate",
        reason: `[Consistency audit] Released duplicate lease; ${ordered[0].id} remains running.`,
      }, "multiple running validation leases");
    }
  }
  return result;
}
