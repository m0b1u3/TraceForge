import type { ScenarioWorkItem, WorkerDescriptor } from "@traceforge/orchestration-core";
import type { WorkerAssignment } from "./model.js";

export function assignment(): { worker: WorkerDescriptor; assignment: WorkerAssignment } {
  const worker: WorkerDescriptor = {
    id: "worker_1", roles: ["researcher"], capabilities: ["evidence.read"], maxConcurrentWork: 1,
    status: "online", heartbeatAt: "2026-08-24T08:00:00.000Z",
  };
  const work: ScenarioWorkItem = {
    id: "work_1", runId: "run_1", phaseId: "phase_1", kind: "research", title: "Work", objective: "Collect facts",
    priority: 50, status: "running", allowedWorkerRoles: ["researcher"], requiredCapabilities: [], hypothesisIds: [], evidenceRefs: [],
    workerId: worker.id, leaseId: "lease_1", leaseExpiresAt: "2026-08-24T09:00:00.000Z", attempt: 1, maxAttempts: 3,
    idempotencyKey: "effect", latestCheckpoint: null, resumeFromCheckpoint: false, pendingApproval: null, approvalHistory: [], grantedActionKeys: [], resultSummary: null, error: null,
    createdAt: "2026-08-24T08:00:00.000Z", startedAt: "2026-08-24T08:00:01.000Z", finishedAt: null,
  };
  return {
    worker,
    assignment: {
      runId: "run_1", leaseId: "lease_1", leaseExpiresAt: work.leaseExpiresAt!, runRevision: 3,
      runContext: { caseId: "case_1", goal: "Assess", scopeRef: "scope_1", activePhaseId: "phase_1", directives: [] }, work,
    },
  };
}
