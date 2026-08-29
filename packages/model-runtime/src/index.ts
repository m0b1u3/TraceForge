import { randomUUID } from "node:crypto";

export * from "./execution.js";

export type CognitiveModelRole = "planner" | "observer" | "worker";

export interface ModelCallContext {
  snapshotId: string;
  runId: string;
  caseId: string;
  workId?: string;
  role: CognitiveModelRole;
}

export interface ModelResourcePolicy {
  maximumConcurrentCalls: number;
  maximumConcurrentCallsPerRun: number;
  maximumQueueDepth: number;
  maximumQueueWaitMs: number;
  priorityAgingIntervalMs: number;
  roleConcurrency: Record<CognitiveModelRole, number>;
  rolePriorities: Record<CognitiveModelRole, number>;
}

export type ModelResourcePolicyOverrides = Omit<Partial<ModelResourcePolicy>, "roleConcurrency" | "rolePriorities"> & {
  roleConcurrency?: Partial<Record<CognitiveModelRole, number>>;
  rolePriorities?: Partial<Record<CognitiveModelRole, number>>;
};

export const DEFAULT_MODEL_RESOURCE_POLICY: ModelResourcePolicy = {
  maximumConcurrentCalls: 8,
  maximumConcurrentCallsPerRun: 2,
  maximumQueueDepth: 128,
  maximumQueueWaitMs: 120_000,
  priorityAgingIntervalMs: 5_000,
  roleConcurrency: { planner: 2, observer: 2, worker: 6 },
  rolePriorities: { planner: 80, observer: 100, worker: 60 },
};

export type ModelAdmissionStatus = "queued" | "admitted" | "released" | "cancelled" | "timed_out" | "interrupted" | "rejected";
export type ModelAdmissionOutcome = "completed" | "failed" | "timed_out" | "cancelled" | null;

export interface ModelAdmissionRecord {
  id: string;
  snapshotId: string;
  runId: string;
  caseId: string;
  workId: string | null;
  role: CognitiveModelRole;
  priority: number;
  status: ModelAdmissionStatus;
  outcome: ModelAdmissionOutcome;
  queuedAt: string;
  admittedAt: string | null;
  releasedAt: string | null;
  queueWaitMs: number | null;
  reason: string | null;
}

export interface ModelAdmissionStore {
  recoverInterrupted(at: string): number;
  enqueue(id: string, context: ModelCallContext, priority: number, at: string): void;
  admit(id: string, waitMs: number, at: string): void;
  finish(
    id: string,
    status: Exclude<ModelAdmissionStatus, "queued" | "admitted" | "interrupted">,
    outcome: ModelAdmissionOutcome,
    reason: string | null,
    at: string,
  ): void;
}

export interface ModelAdmissionEventPort {
  append(event: {
    method: "item/started" | "item/updated" | "item/completed";
    runId: string;
    caseId: string;
    workId: string | null;
    turnId: string;
    role: CognitiveModelRole;
    params: {
      item: {
        type: "modelAdmission";
        id: string;
        status: "queued" | "admitted" | "released" | "cancelled" | "timedOut" | "rejected";
        priority: number;
        queueWaitMs: number | null;
        outcome: "completed" | "failed" | "timedOut" | "cancelled" | null;
        reason: string | null;
      };
    };
  }): unknown;
}

export class ModelAdmissionRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelAdmissionRejectedError";
  }
}

export interface ModelAdmissionPermit {
  id: string;
  release(outcome: Exclude<ModelAdmissionOutcome, null>, reason?: string): void;
}

interface QueueEntry {
  id: string;
  context: ModelCallContext;
  priority: number;
  queuedAtMs: number;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abortListener?: () => void;
  resolve: (permit: ModelAdmissionPermit) => void;
  reject: (error: Error) => void;
}

interface ActiveEntry {
  context: ModelCallContext;
  role: CognitiveModelRole;
}

function abortError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  const error = new Error(typeof reason === "string" ? reason : "model admission cancelled");
  error.name = "AbortError";
  return error;
}

export class ModelAdmissionController {
  private readonly queue: QueueEntry[] = [];
  private readonly active = new Map<string, ActiveEntry>();
  private stopped = false;

  constructor(
    private readonly policy: ModelResourcePolicy,
    private readonly store: ModelAdmissionStore,
    private readonly createId: () => string = randomUUID,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly clock: () => number = Date.now,
    private readonly events?: ModelAdmissionEventPort,
  ) {
    if (policy.maximumConcurrentCalls < 1 || policy.maximumConcurrentCallsPerRun < 1 || policy.maximumQueueDepth < 1
      || policy.maximumQueueWaitMs < 1 || policy.priorityAgingIntervalMs < 1
      || Object.values(policy.roleConcurrency).some((value) => value < 1)
      || Object.values(policy.rolePriorities).some((value) => !Number.isFinite(value))) {
      throw new Error("Invalid model resource policy");
    }
    this.store.recoverInterrupted(this.now());
  }

  acquire(context: ModelCallContext, signal?: AbortSignal): Promise<ModelAdmissionPermit> {
    if (this.stopped) return Promise.reject(new ModelAdmissionRejectedError("model admission controller is stopped"));
    if (signal?.aborted) return Promise.reject(abortError(signal.reason));
    if (this.queue.length >= this.policy.maximumQueueDepth) {
      const id = this.createId();
      this.store.enqueue(id, context, this.policy.rolePriorities[context.role], this.now());
      this.store.finish(id, "rejected", null, "model admission queue is full", this.now());
      this.emit(context, "item/started", id, "queued", this.policy.rolePriorities[context.role], null, null, null);
      this.emit(context, "item/completed", id, "rejected", this.policy.rolePriorities[context.role], null, null, "model admission queue is full");
      return Promise.reject(new ModelAdmissionRejectedError("model admission queue is full"));
    }
    const id = this.createId();
    const priority = this.policy.rolePriorities[context.role];
    const queuedAtMs = this.clock();
    this.store.enqueue(id, context, priority, this.now());
    this.emit(context, "item/started", id, "queued", priority, null, null, null);
    return new Promise<ModelAdmissionPermit>((resolve, reject) => {
      const entry: QueueEntry = {
        id, context, priority, queuedAtMs, signal, resolve, reject,
        timer: setTimeout(() => this.removeQueued(id, "timed_out", "model admission queue wait timed out"), this.policy.maximumQueueWaitMs),
      };
      entry.timer.unref();
      entry.abortListener = () => this.removeQueued(id, "cancelled", abortError(signal?.reason).message);
      signal?.addEventListener("abort", entry.abortListener, { once: true });
      this.queue.push(entry);
      this.drain();
    });
  }

  cancelRun(runId: string, reason = "Run cancelled"): void {
    for (const entry of [...this.queue]) if (entry.context.runId === runId) this.removeQueued(entry.id, "cancelled", reason);
  }

  cancelWork(runId: string, workId: string, reason = "Work cancelled"): void {
    for (const entry of [...this.queue]) {
      if (entry.context.runId === runId && entry.context.workId === workId) this.removeQueued(entry.id, "cancelled", reason);
    }
  }

  shutdown(reason = "model runtime shutting down"): void {
    this.stopped = true;
    for (const entry of [...this.queue]) this.removeQueued(entry.id, "cancelled", reason);
  }

  snapshot(): { policy: ModelResourcePolicy; active: number; queued: number; activeByRole: Record<CognitiveModelRole, number> } {
    return {
      policy: this.policy,
      active: this.active.size,
      queued: this.queue.length,
      activeByRole: {
        planner: this.activeForRole("planner"), observer: this.activeForRole("observer"), worker: this.activeForRole("worker"),
      },
    };
  }

  private drain(): void {
    if (this.stopped) return;
    while (this.active.size < this.policy.maximumConcurrentCalls) {
      const candidates = this.queue
        .filter((entry) => this.canAdmit(entry))
        .sort((left, right) => this.effectivePriority(right) - this.effectivePriority(left) || left.queuedAtMs - right.queuedAtMs);
      const entry = candidates[0];
      if (!entry) return;
      const index = this.queue.findIndex((candidate) => candidate.id === entry.id);
      if (index < 0) continue;
      this.queue.splice(index, 1);
      clearTimeout(entry.timer);
      if (entry.abortListener) entry.signal?.removeEventListener("abort", entry.abortListener);
      if (entry.signal?.aborted) {
        this.store.finish(entry.id, "cancelled", "cancelled", abortError(entry.signal.reason).message, this.now());
        entry.reject(abortError(entry.signal.reason));
        continue;
      }
      this.active.set(entry.id, { context: entry.context, role: entry.context.role });
      this.store.admit(entry.id, Math.max(0, this.clock() - entry.queuedAtMs), this.now());
      this.emit(entry.context, "item/updated", entry.id, "admitted", entry.priority, Math.max(0, this.clock() - entry.queuedAtMs), null, null);
      let released = false;
      entry.resolve({
        id: entry.id,
        release: (outcome, reason) => {
          if (released) return;
          released = true;
          if (!this.active.delete(entry.id)) return;
          this.store.finish(entry.id, "released", outcome, reason ?? null, this.now());
          const protocolOutcome = outcome === "timed_out" ? "timedOut" : outcome;
          this.emit(entry.context, "item/completed", entry.id, "released", entry.priority,
            Math.max(0, this.clock() - entry.queuedAtMs), protocolOutcome, reason ?? null);
          this.drain();
        },
      });
    }
  }

  private canAdmit(entry: QueueEntry): boolean {
    return this.activeForRole(entry.context.role) < this.policy.roleConcurrency[entry.context.role]
      && this.activeForRun(entry.context.runId) < this.policy.maximumConcurrentCallsPerRun;
  }

  private activeForRole(role: CognitiveModelRole): number {
    let count = 0;
    for (const active of this.active.values()) if (active.role === role) count += 1;
    return count;
  }

  private activeForRun(runId: string): number {
    let count = 0;
    for (const active of this.active.values()) if (active.context.runId === runId) count += 1;
    return count;
  }

  private effectivePriority(entry: QueueEntry): number {
    return entry.priority + Math.floor(Math.max(0, this.clock() - entry.queuedAtMs) / this.policy.priorityAgingIntervalMs);
  }

  private removeQueued(id: string, status: "cancelled" | "timed_out", reason: string): void {
    const index = this.queue.findIndex((entry) => entry.id === id);
    if (index < 0) return;
    const [entry] = this.queue.splice(index, 1);
    clearTimeout(entry.timer);
    if (entry.abortListener) entry.signal?.removeEventListener("abort", entry.abortListener);
    this.store.finish(entry.id, status, status === "timed_out" ? "timed_out" : "cancelled", reason, this.now());
    this.emit(entry.context, "item/completed", entry.id, status === "timed_out" ? "timedOut" : "cancelled", entry.priority,
      Math.max(0, this.clock() - entry.queuedAtMs), status === "timed_out" ? "timedOut" : "cancelled", reason);
    entry.reject(status === "timed_out" ? new ModelAdmissionRejectedError(reason) : abortError(reason));
    this.drain();
  }

  private emit(
    context: ModelCallContext,
    method: "item/started" | "item/updated" | "item/completed",
    id: string,
    status: "queued" | "admitted" | "released" | "cancelled" | "timedOut" | "rejected",
    priority: number,
    queueWaitMs: number | null,
    outcome: "completed" | "failed" | "timedOut" | "cancelled" | null,
    reason: string | null,
  ): void {
    this.events?.append({
      method, runId: context.runId, caseId: context.caseId, workId: context.workId ?? null,
      turnId: context.snapshotId, role: context.role,
      params: { item: { type: "modelAdmission", id, status, priority, queueWaitMs, outcome, reason } },
    });
  }
}
