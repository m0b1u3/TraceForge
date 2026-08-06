import type { ArtifactAnalyzerCapability, ArtifactRecovery, RuntimeEvent, Task } from "@traceforge/shared";
import type { ToolDescriptor } from "@traceforge/extension";
import { artifactAnalyzerCapabilityFingerprint, type ArtifactAnalyzerRegistry } from "./artifact-analyzer.js";
import { planArtifactAnalysis } from "./artifact-analysis-planner.js";
import type { ArtifactAnalysisAttemptStore } from "./stores/artifact-analysis-attempt-store.js";
import type { ArtifactRecoveryStore } from "./stores/artifact-recovery-store.js";
import type { ArtifactStore } from "./stores/artifact-store.js";
import type { TaskStore } from "./stores/task-store.js";
import type { TimelineStore } from "./stores/timeline-store.js";

type RecoveryEvent =
  | Extract<RuntimeEvent, { type: "artifact_recovery_updated" }>
  | Extract<RuntimeEvent, { type: "task_updated" }>
  | Extract<RuntimeEvent, { type: "timeline_appended" }>;

const ACTIVE_TASK_STATUSES = new Set<Task["status"]>(["open", "running", "blocked", "recheck_candidate"]);

export function evaluateArtifactRecoveryProof(beforeFingerprint: string, capability: ArtifactAnalyzerCapability) {
  const afterFingerprint = artifactAnalyzerCapabilityFingerprint(capability);
  const identityChanged = afterFingerprint !== beforeFingerprint;
  const available = (capability.availability ?? "ready") !== "unavailable";
  return {
    proven: identityChanged && available,
    afterFingerprint,
    identityChanged,
    available,
    reason: capability.availabilityReason ?? "none",
  };
}

export function makeManageArtifactRecoveryTool(input: {
  caseId: string;
  runId: string;
  artifacts: ArtifactStore;
  attempts: ArtifactAnalysisAttemptStore;
  analyzers: ArtifactAnalyzerRegistry;
  recoveries: ArtifactRecoveryStore;
  tasks: TaskStore;
  timeline: TimelineStore;
  emit: (event: RecoveryEvent) => void;
  onReplan?: (message: string) => void;
}): ToolDescriptor {
  const publish = (recovery: ArtifactRecovery, detail: string) => {
    input.emit({ type: "artifact_recovery_updated", recovery });
    const entry = input.timeline.append(input.caseId, `artifact_recovery_${recovery.status}`, detail, recovery.id, input.runId);
    input.emit({ type: "timeline_appended", entry });
  };
  const recoveryTrigger = (id: string) => `[Artifact recovery ${id}]`;
  return {
    name: "manage_artifact_recovery",
    description: "Plan and track recovery of an unavailable or failed artifact analyzer. Recovery succeeds only when a fresh preflight proves that analyzer conditions improved; success automatically re-plans the original artifact analysis.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["plan", "start", "verify", "fail", "cancel"] },
        recoveryId: { type: "string" },
        taskId: { type: "string" },
        artifactId: { type: "string" },
        analyzerId: { type: "string" },
        instruction: { type: "string" },
        result: { type: "string" },
      },
      required: ["action"],
    },
    risk: "normal",
    source: "builtin",
    executionMode: "serial",
    execute: async (raw) => {
      const request = raw as {
        action?: "plan" | "start" | "verify" | "fail" | "cancel";
        recoveryId?: string; taskId?: string; artifactId?: string; analyzerId?: string;
        instruction?: string; result?: string;
      };
      if (request.action === "plan") {
        if (!request.taskId || !request.artifactId || !request.analyzerId || !request.instruction?.trim()) {
          return { ok: false, content: "taskId, artifactId, analyzerId, and a concrete recovery instruction are required" };
        }
        const task = input.tasks.getById(request.taskId);
        const artifact = input.artifacts.getById(request.artifactId);
        if (!task || task.caseId !== input.caseId || task.runId !== input.runId || !ACTIVE_TASK_STATUSES.has(task.status)) {
          return { ok: false, content: "Recovery must remain attached to one active Task in this Run." };
        }
        const runningTasks = input.tasks.listByCase(input.caseId).filter((item) => item.runId === input.runId && item.status === "running");
        if (runningTasks.length > 1 || (runningTasks.length === 1 && runningTasks[0]?.id !== task.id)) {
          return { ok: false, content: "Another Task owns execution. Finish or release it before planning this recovery." };
        }
        if (!artifact || artifact.caseId !== input.caseId) return { ok: false, content: "Artifact was not found in this Case." };
        const attempts = input.attempts.listByArtifact(artifact.id);
        const failed = attempts.find((attempt) => attempt.analyzerId === request.analyzerId && ["failed", "unsupported"].includes(attempt.status));
        const capabilities = input.analyzers.capabilities(artifact);
        const capability = capabilities.find((item) => item.analyzerId === request.analyzerId && item.compatible);
        if (!capability) return { ok: false, content: "Analyzer is not compatible with this Artifact." };
        const plan = planArtifactAnalysis(artifact, capabilities, attempts);
        const candidate = plan.candidates.find((item) => item.analyzerId === request.analyzerId);
        if (plan.status !== "recovery_required" || !candidate?.requiresRecovery) {
          return { ok: false, content: `Analyzer recovery is not required by the current plan (${plan.status}). Re-plan analysis instead.` };
        }
        const recovery = input.recoveries.create({
          caseId: input.caseId, runId: input.runId, taskId: task.id, artifactId: artifact.id,
          analyzerId: capability.analyzerId, failedAttemptId: failed?.id ?? null,
          beforeFingerprint: artifactAnalyzerCapabilityFingerprint(capability),
          instruction: request.instruction.trim(),
        });
        const prefix = recoveryTrigger(recovery.id);
        if (!task.triggerWhen.some((value) => value.startsWith(prefix))) {
          const updatedTask = input.tasks.update(task.id, { triggerWhen: [...task.triggerWhen, `${prefix} ${recovery.instruction}`] });
          if (updatedTask) input.emit({ type: "task_updated", task: updatedTask });
        }
        publish(recovery, `Artifact=${artifact.id}; analyzer=${capability.analyzerId}; task=${task.id}; instruction=${recovery.instruction}`);
        return { ok: true, content: `Recovery ${recovery.id} planned within Task ${task.id}. Start it before performing the recovery action.` };
      }

      if (!request.recoveryId) return { ok: false, content: "recoveryId is required" };
      const recovery = input.recoveries.getById(request.recoveryId);
      if (!recovery || recovery.caseId !== input.caseId || recovery.runId !== input.runId) return { ok: false, content: "Recovery was not found in this Run." };
      if (request.action === "start" || request.action === "verify") {
        const owner = input.tasks.getById(recovery.taskId);
        const runningTasks = input.tasks.listByCase(input.caseId).filter((item) => item.runId === input.runId && item.status === "running");
        if (!owner || !ACTIVE_TASK_STATUSES.has(owner.status)
          || runningTasks.length > 1
          || (runningTasks.length === 1 && runningTasks[0]?.id !== owner.id)) {
          return { ok: false, content: "The recovery's original Task no longer owns serial execution. Restore that Task's ownership before continuing." };
        }
      }
      if (request.action === "start") {
        if (recovery.status !== "planned") return { ok: false, content: `Recovery is ${recovery.status}, not planned.` };
        const updated = input.recoveries.update(recovery.id, { status: "running" })!;
        publish(updated, `Artifact=${updated.artifactId}; analyzer=${updated.analyzerId}; recovery action started.`);
        return { ok: true, content: `Recovery ${updated.id} is running. Perform only the documented recovery action, then verify with fresh preflight.` };
      }
      if (request.action === "verify") {
        if (recovery.status !== "running") return { ok: false, content: `Recovery is ${recovery.status}; only a running recovery can be verified.` };
        const artifact = input.artifacts.getById(recovery.artifactId);
        if (!artifact) return { ok: false, content: "Artifact no longer exists." };
        const capabilities = input.analyzers.capabilities(artifact, { refresh: true });
        const capability = capabilities.find((item) => item.analyzerId === recovery.analyzerId && item.compatible);
        if (!capability) return { ok: false, content: "Analyzer is no longer compatible with this Artifact." };
        const proof = evaluateArtifactRecoveryProof(recovery.beforeFingerprint, capability);
        if (!proof.proven) {
          return {
            ok: false,
            content: `Recovery is not proven. Fresh preflight=${capability.availability ?? "ready"}; identityChanged=${proof.identityChanged}; reason=${proof.reason}. Keep the recovery running or record failure.`,
          };
        }
        const attempts = input.attempts.listByArtifact(artifact.id);
        const updated = input.recoveries.update(recovery.id, {
          status: "succeeded", afterFingerprint: proof.afterFingerprint,
          result: request.result?.trim() || capability.availabilityReason || "Fresh analyzer preflight succeeded.",
        })!;
        const task = input.tasks.getById(recovery.taskId);
        if (task) {
          const prefix = recoveryTrigger(recovery.id);
          const updatedTask = input.tasks.update(task.id, { triggerWhen: task.triggerWhen.filter((value) => !value.startsWith(prefix)) });
          if (updatedTask) input.emit({ type: "task_updated", task: updatedTask });
        }
        const replanned = planArtifactAnalysis(artifact, capabilities, attempts);
        const message = `Artifact recovery ${updated.id} succeeded. Re-plan status=${replanned.status}; nextAnalyzer=${replanned.recommendedAnalyzerId ?? "none"}; reason=${replanned.reason}`;
        publish(updated, message);
        input.onReplan?.(message);
        return { ok: true, content: message };
      }
      if (request.action === "fail" || request.action === "cancel") {
        if (!["planned", "running"].includes(recovery.status)) return { ok: false, content: `Recovery is already ${recovery.status}.` };
        if (request.action === "fail" && !request.result?.trim()) return { ok: false, content: "A concrete failure result is required." };
        const status = request.action === "fail" ? "failed" : "cancelled";
        const updated = input.recoveries.update(recovery.id, { status, result: request.result?.trim() || "Recovery cancelled." })!;
        if (status === "cancelled") {
          const task = input.tasks.getById(recovery.taskId);
          if (task) {
            const prefix = recoveryTrigger(recovery.id);
            const updatedTask = input.tasks.update(task.id, { triggerWhen: task.triggerWhen.filter((value) => !value.startsWith(prefix)) });
            if (updatedTask) input.emit({ type: "task_updated", task: updatedTask });
          }
        }
        publish(updated, `Artifact=${updated.artifactId}; analyzer=${updated.analyzerId}; result=${updated.result}`);
        return { ok: true, content: `Recovery ${updated.id} marked ${status}. The original analysis remains unresolved.` };
      }
      return { ok: false, content: "Unknown recovery action." };
    },
  };
}
