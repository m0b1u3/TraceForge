import type { Task, ValidationWorkflowSnapshot } from "@traceforge/shared";
import type { ToolDescriptor } from "@traceforge/extension";
import type { AttackPathStore } from "./stores/attack-path-store.js";
import type { FactStore } from "./stores/fact-store.js";
import type { HypothesisStore } from "./stores/hypothesis-store.js";
import type { TaskStore } from "./stores/task-store.js";
import type { TimelineStore } from "./stores/timeline-store.js";
import type { ValidationConsensusStore } from "./stores/validation-consensus-store.js";
import type { ArtifactStore } from "./stores/artifact-store.js";
import type { ArtifactAnalysisAttemptStore } from "./stores/artifact-analysis-attempt-store.js";
import type { ArtifactLimitationStore } from "./stores/artifact-limitation-store.js";
import type { ValidationExplorationState } from "./validation-exploration-policy.js";
import type { ValidationPriorityLeader } from "./validation-priority-hysteresis.js";
import { evaluateValidationTaskCompletion } from "./validation-task-gate.js";
import { recoverValidationFeedback, summarizeValidationFeedbackHistory } from "./validation-task-feedback.js";
import { rankValidationTasks } from "./validation-task-priority.js";
import { combineTaskCompletionGates, evaluateArtifactTaskReadiness } from "./artifact-task-readiness.js";

const ACTIVE = new Set<Task["status"]>(["open", "blocked", "recheck_candidate", "approved", "running"]);

export interface ValidationRuntimeSnapshot {
  leader?: ValidationPriorityLeader;
  exploration?: ValidationExplorationState;
}

export function buildValidationWorkflowSnapshot(input: {
  caseId: string;
  runId?: string;
  revision?: number;
  facts: FactStore;
  hypotheses: HypothesisStore;
  tasks: TaskStore;
  consensus: ValidationConsensusStore;
  artifacts?: ArtifactStore;
  artifactAttempts?: ArtifactAnalysisAttemptStore;
  artifactLimitations?: ArtifactLimitationStore;
  paths: AttackPathStore;
  timeline: TimelineStore;
  runtime?: ValidationRuntimeSnapshot;
}): ValidationWorkflowSnapshot {
  const facts = input.facts.listByCase(input.caseId);
  const hypotheses = input.hypotheses.listByCase(input.caseId);
  const consensus = input.consensus.listByCase(input.caseId);
  const tasks = input.tasks.listByCase(input.caseId);
  const feedback = summarizeValidationFeedbackHistory(recoverValidationFeedback(input.timeline.listByCase(input.caseId)));
  const activeTasks = tasks.filter((task) =>
    ACTIVE.has(task.status) && (!input.runId || task.runId === input.runId));
  const ranked = rankValidationTasks({
    tasks: activeTasks,
    facts,
    consensus,
    paths: input.paths.listByCase(input.caseId),
    feedback,
  });
  const rankingByTask = new Map(ranked.map((item) => [item.task.id, item]));

  return {
    caseId: input.caseId,
    runId: input.runId ?? null,
    revision: input.revision ?? 0,
    generatedAt: new Date().toISOString(),
    runningLease: activeTasks.find((task) => task.status === "running" && task.title.startsWith("[Consensus:"))?.id ?? null,
    leader: input.runtime?.leader ?? null,
    exploration: input.runtime?.exploration ?? { consecutiveValidationShifts: 0, explorationBoundariesRemaining: 0 },
    items: consensus.map((state) => {
      const finding = facts.find((fact) => fact.id === state.findingId && fact.type === "finding");
      const matchingTasks = activeTasks.filter((task) => task.title.startsWith(`[Consensus:${state.findingId}:${state.status}]`));
      const task = matchingTasks.sort((left, right) => Number(right.status === "running") - Number(left.status === "running") || left.createdAt.localeCompare(right.createdAt))[0];
      const completion = combineTaskCompletionGates(
        evaluateValidationTaskCompletion({
          task: { title: task?.title ?? `[Consensus:${state.findingId}:${state.status}]` },
          facts,
          consensus,
          hypotheses,
        }),
        task && input.artifacts && input.artifactAttempts
          ? evaluateArtifactTaskReadiness({
            task,
            facts,
            artifacts: input.artifacts.listByCase(input.caseId),
            attempts: input.artifactAttempts.listByCase(input.caseId),
            dispositions: input.artifactLimitations?.listByCase(input.caseId),
          })
          : { allowed: true, missing: [] },
      );
      const ranking = task ? rankingByTask.get(task.id) : undefined;
      return {
        findingId: state.findingId,
        findingTitle: finding?.title ?? null,
        findingStatus: finding?.findingStatus ?? null,
        consensusStatus: state.status,
        confidence: state.confidence,
        taskId: task?.id ?? null,
        taskStatus: task?.status ?? null,
        priorityScore: ranking?.score ?? null,
        priorityReasons: ranking?.reasons ?? [],
        completionReady: completion.allowed,
        missingEvidence: completion.missing,
        feedback: feedback[state.findingId] ?? null,
      };
    }),
    auditIssues: tasks.filter((task) => task.reason.startsWith("[Consistency audit]")).map((task) => ({
      taskId: task.id,
      status: task.status,
      issue: task.reason,
    })),
  };
}

export function makeGetValidationWorkflowStateTool(get: () => ReturnType<typeof buildValidationWorkflowSnapshot>): ToolDescriptor {
  return {
    name: "get_validation_workflow_state",
    description: "Get the current validation consensus, ranked tasks, running lease, missing completion evidence, outcome feedback, exploration window, and consistency issues.",
    inputSchema: { type: "object", properties: {} },
    risk: "normal",
    source: "builtin",
    execute: async () => ({ ok: true, content: JSON.stringify(get(), null, 2) }),
  };
}
