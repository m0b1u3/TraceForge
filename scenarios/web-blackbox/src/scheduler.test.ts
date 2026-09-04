import { describe, expect, it } from "vitest";
import {
  CapabilityScheduler,
  ScenarioKernel,
  type ScenarioRunState,
  type ScenarioWorkItem,
  type WorkerDescriptor,
} from "@traceforge/orchestration-core";
import { WEB_BLACKBOX_CAPABILITIES, WEB_BLACKBOX_SCENARIO } from "../test-fixtures/descriptor.js";

const now = "2026-08-24T08:00:10.000Z";

function work(overrides: Partial<ScenarioWorkItem>): ScenarioWorkItem {
  return {
    id: "work_1",
    runId: "run_1",
    phaseId: "surface_mapping",
    kind: "research",
    title: "Collect observations",
    objective: "Collect authorized observations",
    priority: 50,
    status: "queued",
    allowedWorkerRoles: ["researcher"],
    requiredCapabilities: ["http.request"],
    hypothesisIds: [],
    evidenceRefs: [],
    workerId: null,
    leaseId: null,
    leaseExpiresAt: null,
    attempt: 0,
    maxAttempts: 3,
    idempotencyKey: "effect_work_1",
    latestCheckpoint: null,
    resumeFromCheckpoint: false,
    pendingApproval: null,
    approvalHistory: [],
    grantedActionKeys: [],
    resultSummary: null,
    error: null,
    createdAt: "2026-08-24T08:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

function state(items: ScenarioWorkItem[]): ScenarioRunState {
  return {
    id: "run_1",
    caseId: "case_1",
    definitionKind: "web_blackbox",
    definitionVersion: 1,
    scenarioPackage: { id: "traceforge.web-blackbox", version: "0.1.0", schemaRevision: 1 },
    goal: "Assess authorized scope",
    scopeRef: "scope_1",
    status: "running",
    activePhaseId: "surface_mapping",
    availableCapabilities: [],
    workItems: items,
    outputs: [],
    directives: [],
    suspension: null,
    revision: 1,
    blockedReason: null,
    createdAt: "2026-08-24T08:00:00.000Z",
    updatedAt: "2026-08-24T08:00:00.000Z",
    completedAt: null,
  };
}

function worker(overrides: Partial<WorkerDescriptor>): WorkerDescriptor {
  return {
    id: "worker_1",
    roles: ["researcher"],
    capabilities: ["http.request"],
    maxConcurrentWork: 1,
    status: "online",
    heartbeatAt: "2026-08-24T08:00:09.000Z",
    ...overrides,
  };
}

describe("CapabilityScheduler", () => {
  it("matches role, capability, liveness, priority, and capacity", () => {
    const scheduler = new CapabilityScheduler();
    const planned = scheduler.plan(state([
      work({ id: "lower", priority: 10, idempotencyKey: "effect_lower" }),
      work({ id: "higher", priority: 90, idempotencyKey: "effect_higher" }),
    ]), [
      worker({ id: "stale", heartbeatAt: "2026-08-24T07:00:00.000Z" }),
      worker({ id: "healthy" }),
    ], { now, heartbeatTimeoutMs: 5_000, maxParallelWork: 4 });
    expect(planned).toEqual([{ workId: "higher", workerId: "healthy" }]);
  });

  it("reserves a single validation execution slot", () => {
    const scheduler = new CapabilityScheduler();
    const planned = scheduler.plan(state([
      work({ id: "validation_1", kind: "validation", allowedWorkerRoles: ["validator"], hypothesisIds: ["hypothesis_1"], idempotencyKey: "effect_1" }),
      work({ id: "validation_2", kind: "validation", allowedWorkerRoles: ["validator"], hypothesisIds: ["hypothesis_2"], idempotencyKey: "effect_2" }),
    ]), [worker({ roles: ["validator"], maxConcurrentWork: 2 })], { now, heartbeatTimeoutMs: 5_000, maxParallelWork: 4 });
    expect(planned).toHaveLength(1);
  });

  it("finds expired leases and the kernel requeues recoverable work", () => {
    const scheduler = new CapabilityScheduler();
    const running = work({
      status: "running",
      workerId: "worker_1",
      leaseId: "lease_1",
      leaseExpiresAt: "2026-08-24T08:00:09.000Z",
      attempt: 1,
    });
    expect(scheduler.expiredLeases(state([running]), now)).toEqual([{ workId: "work_1", leaseId: "lease_1" }]);

    const kernel = new ScenarioKernel(WEB_BLACKBOX_SCENARIO);
    const recovered = kernel.execute(state([running]), {
      type: "expire_lease",
      workId: "work_1",
      leaseId: "lease_1",
      at: now,
    }).state.workItems[0];
    expect(recovered.status).toBe("queued");
    expect(recovered.latestCheckpoint).toBeNull();
  });

  it("fails work when the expired lease consumed its final attempt", () => {
    const kernel = new ScenarioKernel(WEB_BLACKBOX_SCENARIO);
    const exhausted = work({
      status: "running",
      workerId: "worker_1",
      leaseId: "lease_1",
      leaseExpiresAt: "2026-08-24T08:00:09.000Z",
      attempt: 3,
      maxAttempts: 3,
    });
    const failed = kernel.execute(state([exhausted]), {
      type: "expire_lease",
      workId: "work_1",
      leaseId: "lease_1",
      at: now,
    }).state.workItems[0];
    expect(failed.status).toBe("failed");
  });
});
