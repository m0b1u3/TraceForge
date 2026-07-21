import type { Hypothesis, Task, TimelineEntry } from "@traceforge/shared";
import type { FactStore } from "./stores/fact-store.js";
import type { HypothesisStore } from "./stores/hypothesis-store.js";
import type { TaskStore } from "./stores/task-store.js";
import type { TimelineStore } from "./stores/timeline-store.js";
import type { ValidationConsensusStore } from "./stores/validation-consensus-store.js";
import { planValidationFollowup } from "./validation-followup.js";
import { evaluateValidationTaskCompletion } from "./validation-task-gate.js";

export interface ValidationResumeResult {
  hypotheses: Hypothesis[];
  tasks: Task[];
  timelineEntries: TimelineEntry[];
}

export function resumePendingValidations(input: {
  caseId: string;
  runId: string;
  facts: FactStore;
  hypotheses: HypothesisStore;
  tasks: TaskStore;
  consensus: ValidationConsensusStore;
  timeline: TimelineStore;
}): ValidationResumeResult {
  const facts = input.facts.listByCase(input.caseId);
  const hypotheses = input.hypotheses.listByCase(input.caseId);
  const consensus = input.consensus.listByCase(input.caseId);
  const result: ValidationResumeResult = { hypotheses: [], tasks: [], timelineEntries: [] };

  for (const state of consensus) {
    const finding = facts.find((item) => item.id === state.findingId && item.type === "finding");
    if (!finding) continue;
    const plan = planValidationFollowup(finding, state);
    const gate = evaluateValidationTaskCompletion({
      task: { title: plan.title },
      facts,
      consensus,
      hypotheses,
    });
    if (gate.allowed) continue;

    const currentTasks = input.tasks.listByCase(input.caseId).filter((task) =>
      task.runId === input.runId && task.title.startsWith(plan.key));
    const activeTask = currentTasks.find((task) =>
      ["open", "blocked", "recheck_candidate", "approved", "running"].includes(task.status));
    if (activeTask) continue;

    const hypothesisKey = `[Validation continuation:${finding.id}]`;
    let hypothesis = input.hypotheses.listByCase(input.caseId).find((item) =>
      item.runId === input.runId && item.statement.startsWith(hypothesisKey));
    if (!hypothesis) {
      hypothesis = input.hypotheses.create(input.caseId, {
        runId: input.runId,
        statement: `${hypothesisKey} Resolve ${state.status} consensus for ${finding.title}`,
        basedOnFactIds: [...new Set([finding.id, ...(finding.evidenceRefs ?? [])])],
        status: "active",
        priorityScore: plan.priority === "high" ? 85 : 65,
      });
      result.hypotheses.push(hypothesis);
    }

    const task = input.tasks.create(input.caseId, {
      runId: input.runId,
      title: plan.title,
      status: "open",
      reason: `Resumed from project validation consensus. ${plan.reason}`,
      blockedBy: [],
      triggerWhen: [...plan.triggerWhen, ...gate.missing],
      relatedFacts: [...new Set([finding.id, ...(finding.evidenceRefs ?? [])])],
      hypothesisIds: [hypothesis.id],
      priority: plan.priority,
    });
    input.hypotheses.update(hypothesis.id, {
      relatedTaskIds: [...new Set([...hypothesis.relatedTaskIds, task.id])],
    });
    result.tasks.push(task);
    result.timelineEntries.push(input.timeline.append(
      input.caseId,
      "validation_followup_resumed",
      `${task.title}; source consensus retained across Runs; missing=${gate.missing.join("; ")}`,
      task.id,
      input.runId,
    ));
  }
  return result;
}
