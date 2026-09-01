import type { ScenarioRunState, ScenarioWorkItem, WorkerDescriptor } from "./model.js";

export interface WorkAssignment {
  workId: string;
  workerId: string;
}

export interface SchedulerOptions {
  now: string;
  heartbeatTimeoutMs: number;
  maxParallelWork: number;
  workerActiveWork?: Readonly<Record<string, number>>;
}

function hasAll(required: string[], available: string[]): boolean {
  const inventory = new Set(available);
  return required.every((capability) => inventory.has(capability));
}

function isHealthy(worker: WorkerDescriptor, options: SchedulerOptions): boolean {
  const heartbeatAge = Date.parse(options.now) - Date.parse(worker.heartbeatAt);
  return worker.status === "online" && Number.isFinite(heartbeatAge) && heartbeatAge >= 0 && heartbeatAge <= options.heartbeatTimeoutMs;
}

function canExecute(work: ScenarioWorkItem, worker: WorkerDescriptor): boolean {
  return work.allowedWorkerRoles.some((role) => worker.roles.includes(role))
    && hasAll(work.requiredCapabilities, worker.capabilities);
}

export class CapabilityScheduler {
  plan(state: ScenarioRunState, workers: WorkerDescriptor[], options: SchedulerOptions): WorkAssignment[] {
    if (state.status !== "running") return [];
    const runningCounts = new Map<string, number>(Object.entries(options.workerActiveWork ?? {}));
    if (!options.workerActiveWork) {
      for (const work of state.workItems) {
        if (work.status === "running" && work.workerId) {
          runningCounts.set(work.workerId, (runningCounts.get(work.workerId) ?? 0) + 1);
        }
      }
    }

    const healthy = workers
      .filter((worker) => isHealthy(worker, options))
      .sort((left, right) => left.id.localeCompare(right.id));
    const queued = state.workItems
      .filter((work) => work.status === "queued" && work.phaseId === state.activePhaseId
        && (work.resumeFromCheckpoint || work.attempt < work.maxAttempts))
      .sort((left, right) => right.priority - left.priority || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    const assignments: WorkAssignment[] = [];
    const activeInPhase = state.workItems.filter((work) => work.phaseId === state.activePhaseId && work.status === "running").length;
    let remainingPhaseCapacity = Math.max(0, options.maxParallelWork - activeInPhase);
    let validationReserved = state.workItems.some((work) => work.kind === "validation" && work.status === "running");

    for (const work of queued) {
      if (remainingPhaseCapacity === 0) break;
      if (work.kind === "validation" && validationReserved) continue;
      const worker = healthy.find((candidate) => {
        const used = runningCounts.get(candidate.id) ?? 0;
        return used < candidate.maxConcurrentWork && canExecute(work, candidate);
      });
      if (!worker) continue;
      assignments.push({ workId: work.id, workerId: worker.id });
      runningCounts.set(worker.id, (runningCounts.get(worker.id) ?? 0) + 1);
      remainingPhaseCapacity -= 1;
      if (work.kind === "validation") validationReserved = true;
    }
    return assignments;
  }

  expiredLeases(state: ScenarioRunState, now: string): Array<{ workId: string; leaseId: string }> {
    const instant = Date.parse(now);
    if (!Number.isFinite(instant)) throw new Error(`Invalid scheduler time ${now}`);
    return state.workItems
      .filter((work) => work.status === "running" && work.leaseId && work.leaseExpiresAt && Date.parse(work.leaseExpiresAt) <= instant)
      .map((work) => ({ workId: work.id, leaseId: work.leaseId! }));
  }
}
