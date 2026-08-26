import { randomUUID } from "node:crypto";
import {
  CapabilityScheduler,
  RevisionConflictError,
  type DurableScenarioRuntime,
  type ScenarioDefinitionRegistry,
  type ScenarioRunState,
} from "@traceforge/orchestration-core";
import { SqliteWorkerRegistry } from "./scenario-event-store.js";

export interface ControlPlaneOptions {
  leaseDurationMs: number;
  heartbeatTimeoutMs: number;
  concurrencyRetries: number;
}

export interface ControlPlaneTickResult {
  state: ScenarioRunState | undefined;
  expiredLeaseIds: string[];
  assignments: Array<{ workId: string; workerId: string; leaseId: string; leaseExpiresAt: string }>;
}

const defaultOptions: ControlPlaneOptions = {
  leaseDurationMs: 60_000,
  heartbeatTimeoutMs: 30_000,
  concurrencyRetries: 4,
};

export class ScenarioControlPlane {
  private readonly scheduler = new CapabilityScheduler();

  constructor(
    private readonly runtime: DurableScenarioRuntime,
    private readonly definitions: ScenarioDefinitionRegistry,
    private readonly workers: SqliteWorkerRegistry,
    private readonly options: ControlPlaneOptions = defaultOptions,
    private readonly createId: () => string = randomUUID,
  ) {
    if (options.leaseDurationMs < 1 || options.heartbeatTimeoutMs < 1 || options.concurrencyRetries < 1) {
      throw new Error("Control-plane durations and retry count must be positive");
    }
  }

  tick(runId: string, at: string): ControlPlaneTickResult {
    for (let attempt = 1; attempt <= this.options.concurrencyRetries; attempt += 1) {
      try {
        return this.tickOnce(runId, at);
      } catch (error) {
        if (!(error instanceof RevisionConflictError) || attempt === this.options.concurrencyRetries) throw error;
      }
    }
    throw new Error(`Control-plane tick for ${runId} exhausted retries`);
  }

  private tickOnce(runId: string, at: string): ControlPlaneTickResult {
    let state = this.runtime.load(runId);
    if (!state || state.status !== "running") return { state, expiredLeaseIds: [], assignments: [] };
    const expiredLeaseIds: string[] = [];
    const assignments: ControlPlaneTickResult["assignments"] = [];

    for (const expired of this.scheduler.expiredLeases(state, at)) {
      const result = this.runtime.execute({
        commandId: `expire-lease:${expired.leaseId}`,
        runId,
        expectedRevision: state.revision,
        command: { type: "expire_lease", workId: expired.workId, leaseId: expired.leaseId, at },
      });
      state = result.state;
      expiredLeaseIds.push(expired.leaseId);
    }

    const definition = this.definitions.require(state.definitionKind, state.definitionVersion);
    const phase = definition.phases.find((candidate) => candidate.id === state!.activePhaseId);
    if (!phase) throw new Error(`Scenario definition has no active phase ${state.activePhaseId}`);
    const registeredWorkers = this.workers.list();
    const activeWork = this.workers.activeWorkCounts();
    const plan = this.scheduler.plan(state, registeredWorkers, {
      now: at,
      heartbeatTimeoutMs: this.options.heartbeatTimeoutMs,
      maxParallelWork: phase.maxParallelWork,
      workerActiveWork: activeWork,
    });

    for (const assignment of plan) {
      const worker = registeredWorkers.find((candidate) => candidate.id === assignment.workerId);
      if (!worker) throw new Error(`Scheduled worker ${assignment.workerId} disappeared`);
      const leaseId = this.createId();
      const leaseExpiresAt = new Date(Date.parse(at) + this.options.leaseDurationMs).toISOString();
      const result = this.runtime.execute({
        commandId: `claim-work:${leaseId}`,
        runId,
        expectedRevision: state.revision,
        command: {
          type: "claim_work",
          workId: assignment.workId,
          workerId: worker.id,
          workerRoles: worker.roles,
          workerCapabilities: worker.capabilities,
          workerCurrentWork: activeWork[worker.id] ?? 0,
          workerMaxConcurrentWork: worker.maxConcurrentWork,
          leaseId,
          leaseExpiresAt,
          at,
        },
      });
      state = result.state;
      activeWork[worker.id] = (activeWork[worker.id] ?? 0) + 1;
      assignments.push({ workId: assignment.workId, workerId: worker.id, leaseId, leaseExpiresAt });
    }
    return { state, expiredLeaseIds, assignments };
  }
}
