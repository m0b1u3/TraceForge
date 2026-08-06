import type { Task, TimelineEntry } from "@traceforge/shared";
import type { ToolDescriptor } from "@traceforge/extension";
import type { FactStore } from "./stores/fact-store.js";
import type { HypothesisStore } from "./stores/hypothesis-store.js";
import type { TaskStore } from "./stores/task-store.js";
import type { TimelineStore } from "./stores/timeline-store.js";
import type { ValidationConsensusStore } from "./stores/validation-consensus-store.js";
import type { ArtifactStore } from "./stores/artifact-store.js";
import type { ArtifactAnalysisAttemptStore } from "./stores/artifact-analysis-attempt-store.js";
import type { ArtifactLimitationStore } from "./stores/artifact-limitation-store.js";
import type { ArtifactAnalyzerRegistry } from "./artifact-analyzer.js";
import { evaluateValidationTaskCompletion } from "./validation-task-gate.js";
import { evaluateValidationTaskExecutionTransition, isConsensusValidationTask } from "./validation-task-execution.js";
import { combineTaskCompletionGates, evaluateArtifactTaskReadiness } from "./artifact-task-readiness.js";

type ControlEvent = { type: "task_updated"; task: Task } | { type: "timeline_appended"; entry: TimelineEntry };
const KEY = /^\[Consensus:([^:\]]+):(insufficient|supported|conflicted|refuted)\]/;

export function makeManageValidationTaskTool(input: {
  caseId: string;
  runId: string;
  facts: FactStore;
  hypotheses: HypothesisStore;
  tasks: TaskStore;
  consensus: ValidationConsensusStore;
  artifacts?: ArtifactStore;
  artifactAttempts?: ArtifactAnalysisAttemptStore;
  artifactLimitations?: ArtifactLimitationStore;
  artifactAnalyzers?: ArtifactAnalyzerRegistry;
  timeline: TimelineStore;
  emit: (event: ControlEvent) => void;
}): ToolDescriptor {
  const persist = (task: Task, eventType: string, detail: string) => {
    input.emit({ type: "task_updated", task });
    const entry = input.timeline.append(input.caseId, eventType, detail, task.id, input.runId);
    input.emit({ type: "timeline_appended", entry });
  };
  return {
    name: "manage_validation_task",
    description: "Atomically claim, release, or complete one consensus validation Task. Use this instead of manually changing validation task status with record_task.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        action: { type: "string", enum: ["claim", "release", "complete"] },
        reason: { type: "string" },
      },
      required: ["taskId", "action"],
    },
    risk: "normal",
    source: "builtin",
    executionMode: "serial",
    execute: async (raw) => {
      const request = raw as { taskId?: string; action?: string; reason?: string };
      const task = request.taskId ? input.tasks.getById(request.taskId) : undefined;
      if (!task || task.caseId !== input.caseId) return { ok: false, content: "Validation task not found in this Case." };
      if (task.runId !== input.runId) return { ok: false, content: `Validation task ${task.id} belongs to Run ${task.runId ?? "unassigned"}, not ${input.runId}.` };
      const key = KEY.exec(task.title);
      if (!key || !isConsensusValidationTask(task)) return { ok: false, content: `Task ${task.id} is not a consensus validation task.` };
      const [, findingId, expectedStatus] = key;
      const consensus = input.consensus.listByCase(input.caseId).find((item) => item.findingId === findingId);

      if (request.action === "claim") {
        if (!consensus) return { ok: false, content: `Validation consensus for ${findingId} is missing.` };
        if (consensus.status !== expectedStatus) {
          return { ok: false, content: `Task ${task.id} is stale: it expects ${expectedStatus}, current consensus is ${consensus.status}. Use the current follow-up task.` };
        }
        if (task.status === "running") return { ok: true, content: `Validation task ${task.id} is already claimed by this Run.` };
        if (!["open", "blocked", "recheck_candidate", "approved"].includes(task.status)) {
          return { ok: false, content: `Validation task ${task.id} cannot be claimed from status ${task.status}.` };
        }
        const gate = evaluateValidationTaskExecutionTransition({ current: task, requestedStatus: "running", tasks: input.tasks.listByCase(input.caseId) });
        if (!gate.allowed) return { ok: false, content: gate.message ?? "Another validation task is already running." };
        const claimed = input.tasks.update(task.id, {
          status: "running",
          reason: request.reason?.trim() || task.reason,
        });
        if (!claimed) return { ok: false, content: `Failed to claim validation task ${task.id}.` };
        persist(claimed, "validation_task_claimed", `Task=${task.id}; consensus=${consensus.status}`);
        return { ok: true, content: `Claimed validation task ${task.id}. Evidence and tool outcomes now attribute to this task.` };
      }

      if (request.action === "release") {
        if (task.status !== "running") return { ok: false, content: `Validation task ${task.id} is not running.` };
        const released = input.tasks.update(task.id, {
          status: "recheck_candidate",
          reason: request.reason?.trim() || `Released by Run ${input.runId}.`,
          triggerWhen: [...new Set([...task.triggerWhen, "Reclaim after reviewing the latest evidence and current consensus."])],
        });
        if (!released) return { ok: false, content: `Failed to release validation task ${task.id}.` };
        persist(released, "validation_task_released", `Task=${task.id}; reason=${released.reason}`);
        return { ok: true, content: `Released validation task ${task.id} for later continuation.` };
      }

      if (request.action === "complete") {
        if (task.status !== "running") return { ok: false, content: `Validation task ${task.id} must be running before completion.` };
        const currentFacts = input.facts.listByCase(input.caseId);
        const completion = combineTaskCompletionGates(
          evaluateValidationTaskCompletion({
            task,
            facts: currentFacts,
            consensus: input.consensus.listByCase(input.caseId),
            hypotheses: input.hypotheses.listByCase(input.caseId),
          }),
          input.artifacts && input.artifactAttempts
            ? evaluateArtifactTaskReadiness({
              task,
              facts: currentFacts,
              artifacts: input.artifacts.listByCase(input.caseId),
              attempts: input.artifactAttempts.listByCase(input.caseId),
              dispositions: input.artifactLimitations?.listByCase(input.caseId),
              capabilitiesByArtifact: input.artifactAnalyzers
                ? Object.fromEntries(input.artifacts.listByCase(input.caseId).map((artifact) => [artifact.id, input.artifactAnalyzers!.capabilities(artifact)]))
                : undefined,
            })
            : { allowed: true, missing: [] },
        );
        const completed = input.tasks.update(task.id, completion.allowed ? {
          status: "done",
          reason: request.reason?.trim() || task.reason,
        } : {
          status: "blocked",
          reason: `[Completion gate] ${completion.missing.join("; ")}`,
          triggerWhen: completion.missing,
        });
        if (!completed) return { ok: false, content: `Failed to complete validation task ${task.id}.` };
        persist(completed, completion.allowed ? "validation_task_completed" : "validation_task_completion_blocked", `Task=${task.id}; missing=${completion.missing.join("; ") || "none"}`);
        return completion.allowed
          ? { ok: true, content: `Completed validation task ${task.id}.` }
          : { ok: true, content: `Validation task ${task.id} remains blocked. Missing evidence: ${completion.missing.join("; ")}` };
      }
      return { ok: false, content: "action must be claim, release, or complete" };
    },
  };
}
