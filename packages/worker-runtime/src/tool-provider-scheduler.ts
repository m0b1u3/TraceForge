import { randomUUID } from "node:crypto";

export interface ToolProviderSchedulingLimits {
  global: number;
  perProvider: number;
  perTool: number;
  perRun: number;
  perWork: number;
  maximumQueued: number;
  maximumWaitMs: number;
}

export interface ToolProviderSchedulingIdentity {
  providerId: string;
  providerVersion: string;
  toolName: string;
  caseId: string;
  runId: string;
  workId: string;
}

export type ToolProviderSchedulingRejectionReason = "queue_full" | "wait_timeout" | "cancelled";

export interface ToolProviderSchedulingAuditRecord {
  schemaVersion: 1;
  id: string;
  outcome: "rejected" | "timed_out" | "cancelled";
  reason: ToolProviderSchedulingRejectionReason;
  identity: ToolProviderSchedulingIdentity;
  queuedAt: string;
  decidedAt: string;
  waitMs: number;
}

export interface ToolProviderSchedulingAuditWriter {
  write(record: ToolProviderSchedulingAuditRecord): void;
}

export interface ToolProviderSchedulingSnapshot {
  active: number;
  retained: number;
  occupied: number;
  occupiedByProvider: Record<string,number>;
  occupiedByTool: Record<string,number>;
  occupiedByRun: Record<string,number>;
  occupiedByWork: Record<string,number>;
  queued: number;
  activeByProvider: Record<string, number>;
  activeByTool: Record<string, number>;
  activeByRun: Record<string, number>;
  activeByWork: Record<string, number>;
}

export interface ToolProviderSchedulingLease {
  readonly acquiredAt: string;
  release(): void;
}

export class ToolProviderSchedulingError extends Error {
  readonly retryable = true;
  readonly countsTowardProviderRecovery = false;

  constructor(readonly reason: ToolProviderSchedulingRejectionReason) {
    super(reason === "queue_full"
      ? "Tool Provider scheduling queue is full"
      : reason === "wait_timeout"
        ? "Tool Provider scheduling wait timed out"
        : "Tool Provider scheduling wait was cancelled");
    this.name = "ToolProviderSchedulingError";
  }
}

interface PendingAcquisition {
  identity: ToolProviderSchedulingIdentity;
  queuedAt: Date;
  resolve(lease: ToolProviderSchedulingLease): void;
  reject(error: ToolProviderSchedulingError): void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
}

const defaultLimits: ToolProviderSchedulingLimits = {
  global: 16,
  perProvider: 8,
  perTool: 4,
  perRun: 4,
  perWork: 1,
  maximumQueued: 256,
  maximumWaitMs: 30_000,
};

export class ToolProviderFairScheduler {
  private active = 0;
  private readonly retained = new Map<string, ToolProviderSchedulingIdentity>();
  private queued = 0;
  private readonly activeByProvider = new Map<string, number>();
  private readonly activeByTool = new Map<string, number>();
  private readonly activeByRun = new Map<string, number>();
  private readonly activeByWork = new Map<string, number>();
  private readonly queues = new Map<string, PendingAcquisition[]>();
  private runOrder: string[] = [];
  private cursor = 0;

  readonly limits: ToolProviderSchedulingLimits;

  constructor(
    limits: Partial<ToolProviderSchedulingLimits> = {},
    private readonly audit?: ToolProviderSchedulingAuditWriter,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.limits = { ...defaultLimits, ...limits };
    for (const [name, value] of Object.entries(this.limits)) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Tool Provider scheduling ${name} must be a positive integer`);
    }
  }

  acquire(identityValue: ToolProviderSchedulingIdentity, signal?: AbortSignal): Promise<ToolProviderSchedulingLease> {
    const identity = normalizeIdentity(identityValue);
    const queuedAt = this.now();
    if (signal?.aborted) return this.rejectImmediately(identity, queuedAt, "cancelled");
    if (this.queued >= this.limits.maximumQueued && !this.canAcquire(identity)) {
      return this.rejectImmediately(identity, queuedAt, "queue_full");
    }

    return new Promise<ToolProviderSchedulingLease>((resolve, reject) => {
      const pending: PendingAcquisition = {
        identity, queuedAt, resolve, reject,
        timer: setTimeout(() => this.removeAndReject(pending, "wait_timeout"), this.limits.maximumWaitMs),
        signal,
      };
      if (signal) {
        pending.onAbort = () => this.removeAndReject(pending, "cancelled");
        signal.addEventListener("abort", pending.onAbort, { once: true });
      }
      const queue = this.queues.get(identity.runId);
      if (queue) queue.push(pending);
      else {
        this.queues.set(identity.runId, [pending]);
        this.runOrder.push(identity.runId);
      }
      this.queued += 1;
      this.dispatch();
    });
  }

  snapshot(): ToolProviderSchedulingSnapshot {
    const providers=new Map(this.activeByProvider),tools=new Map(this.activeByTool),runs=new Map(this.activeByRun),works=new Map(this.activeByWork);
    for(const identity of this.retained.values()) {add(providers,providerKey(identity),-1);add(tools,toolKey(identity),-1);add(runs,identity.runId,-1);add(works,workKey(identity),-1);}
    return {
      active: this.active,
      retained: this.retained.size,
      occupied: this.active + this.retained.size,
      queued: this.queued,
      activeByProvider: Object.fromEntries(providers),
      activeByTool: Object.fromEntries(tools),
      activeByRun: Object.fromEntries(runs),
      activeByWork: Object.fromEntries(works),
      occupiedByProvider:Object.fromEntries(this.activeByProvider),occupiedByTool:Object.fromEntries(this.activeByTool),
      occupiedByRun:Object.fromEntries(this.activeByRun),occupiedByWork:Object.fromEntries(this.activeByWork),
    };
  }

  /** Trusted host restores durable external occupancy before admitting new work. */
  retain(key: string, value: ToolProviderSchedulingIdentity): void {
    if (!key || key.length>1024) throw new Error("Invalid retained execution key");
    const identity=normalizeIdentity(value), existing=this.retained.get(key);
    if (existing) {
      if (JSON.stringify(existing)!==JSON.stringify(identity)) throw new Error("Retained execution identity conflict");
      return;
    }
    this.retained.set(key,identity);
    this.increment(identity); this.active--;
  }

  /** Caller must first commit authorized cleanup evidence; this is not a public command. */
  releaseRetained(key: string): void {
    const identity=this.retained.get(key); if (!identity) return;
    this.retained.delete(key); this.decrement(identity); this.active++;
    this.dispatch();
  }

  private dispatch(): void {
    if (this.active + this.retained.size >= this.limits.global || this.runOrder.length === 0) return;
    let misses = 0;
    while (this.active + this.retained.size < this.limits.global && this.runOrder.length > 0 && misses < this.runOrder.length) {
      this.cursor %= this.runOrder.length;
      const runId = this.runOrder[this.cursor]!;
      const queue = this.queues.get(runId)!;
      const index = queue.findIndex((pending) => this.canAcquire(pending.identity));
      if (index < 0) {
        misses += 1;
        this.cursor = (this.cursor + 1) % this.runOrder.length;
        continue;
      }
      misses = 0;
      const [pending] = queue.splice(index, 1);
      this.queued -= 1;
      this.cleanupPending(pending!);
      this.increment(pending!.identity);
      if (queue.length === 0) this.removeRun(runId);
      else this.cursor = (this.cursor + 1) % this.runOrder.length;
      const acquiredAt = this.now().toISOString();
      let released = false;
      pending!.resolve({
        acquiredAt,
        release: () => {
          if (released) return;
          released = true;
          this.decrement(pending!.identity);
          this.dispatch();
        },
      });
    }
  }

  private canAcquire(identity: ToolProviderSchedulingIdentity): boolean {
    return this.active + this.retained.size < this.limits.global
      && count(this.activeByProvider, providerKey(identity)) < this.limits.perProvider
      && count(this.activeByTool, toolKey(identity)) < this.limits.perTool
      && count(this.activeByRun, identity.runId) < this.limits.perRun
      && count(this.activeByWork, workKey(identity)) < this.limits.perWork;
  }

  private increment(identity: ToolProviderSchedulingIdentity): void {
    this.active += 1;
    add(this.activeByProvider, providerKey(identity), 1);
    add(this.activeByTool, toolKey(identity), 1);
    add(this.activeByRun, identity.runId, 1);
    add(this.activeByWork, workKey(identity), 1);
  }

  private decrement(identity: ToolProviderSchedulingIdentity): void {
    this.active -= 1;
    add(this.activeByProvider, providerKey(identity), -1);
    add(this.activeByTool, toolKey(identity), -1);
    add(this.activeByRun, identity.runId, -1);
    add(this.activeByWork, workKey(identity), -1);
  }

  private removeAndReject(pending: PendingAcquisition, reason: ToolProviderSchedulingRejectionReason): void {
    const queue = this.queues.get(pending.identity.runId);
    const index = queue?.indexOf(pending) ?? -1;
    if (!queue || index < 0) return;
    queue.splice(index, 1);
    this.queued -= 1;
    this.cleanupPending(pending);
    if (queue.length === 0) this.removeRun(pending.identity.runId);
    this.writeAudit(pending.identity, pending.queuedAt, reason);
    pending.reject(new ToolProviderSchedulingError(reason));
    this.dispatch();
  }

  private rejectImmediately(identity: ToolProviderSchedulingIdentity, queuedAt: Date, reason: ToolProviderSchedulingRejectionReason): Promise<never> {
    this.writeAudit(identity, queuedAt, reason);
    return Promise.reject(new ToolProviderSchedulingError(reason));
  }

  private writeAudit(identity: ToolProviderSchedulingIdentity, queuedAt: Date, reason: ToolProviderSchedulingRejectionReason): void {
    const decidedAt = this.now();
    try {
      this.audit?.write({
        schemaVersion: 1,
        id: randomUUID(),
        outcome: reason === "queue_full" ? "rejected" : reason === "wait_timeout" ? "timed_out" : "cancelled",
        reason,
        identity: { ...identity },
        queuedAt: queuedAt.toISOString(),
        decidedAt: decidedAt.toISOString(),
        waitMs: Math.max(0, decidedAt.getTime() - queuedAt.getTime()),
      });
    } catch { /* Scheduling remains fail-closed even if audit persistence is unavailable. */ }
  }

  private cleanupPending(pending: PendingAcquisition): void {
    clearTimeout(pending.timer);
    if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
  }

  private removeRun(runId: string): void {
    const index = this.runOrder.indexOf(runId);
    if (index < 0) return;
    this.queues.delete(runId);
    this.runOrder.splice(index, 1);
    if (index < this.cursor) this.cursor -= 1;
    if (this.runOrder.length === 0) this.cursor = 0;
    else this.cursor %= this.runOrder.length;
  }
}

function normalizeIdentity(value: ToolProviderSchedulingIdentity): ToolProviderSchedulingIdentity {
  const entries = ["providerId","providerVersion","toolName","caseId","runId","workId"].map((name) => {
    const item=value[name as keyof ToolProviderSchedulingIdentity];
    if (typeof item!=="string" || item.includes("\0")) throw new Error(`Invalid Tool Provider scheduling ${name}`);
    const normalized = item.trim();
    if (!normalized) throw new Error(`Tool Provider scheduling ${name} is required`);
    if (normalized.length > 512) throw new Error(`Tool Provider scheduling ${name} is too long`);
    return [name, normalized];
  });
  return Object.fromEntries(entries) as unknown as ToolProviderSchedulingIdentity;
}

function providerKey(value: ToolProviderSchedulingIdentity): string { return `${value.providerId}\0${value.providerVersion}`; }
function toolKey(value: ToolProviderSchedulingIdentity): string { return `${providerKey(value)}\0${value.toolName}`; }
function workKey(value: ToolProviderSchedulingIdentity): string { return `${value.runId}\0${value.workId}`; }
function count(map: Map<string, number>, key: string): number { return map.get(key) ?? 0; }
function add(map: Map<string, number>, key: string, delta: number): void {
  const value = count(map, key) + delta;
  if (value === 0) map.delete(key);
  else map.set(key, value);
}
