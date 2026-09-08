import type { ExecutionResourceLimits, ResourceLimitKind } from "./protocol.js";

export interface ProcessResourceSample {
  /** Stable native birth identity, not a reusable PID alone. */
  identity: string;
  cpuTimeMs: number;
  residentBytes: number;
  writeBytes: number;
}
export interface ResourceBudgetDecision {
  exceeded: ResourceLimitKind | null;
  cpuTimeMs: number;
  residentBytes: number;
  writeBytes: number;
  processCount: number;
}

/** Cumulative counters retain departed processes. Sampling may miss short-lived
 * children and permits overshoot; this is never a kernel hard-limit proof. */
export class SampledResourceBudget {
  private readonly limits: ExecutionResourceLimits;
  private readonly counters = new Map<string, { cpuTimeMs: number; writeBytes: number }>();
  private lastTime = -1;
  private exceeded: ResourceLimitKind | null = null;
  constructor(limits: ExecutionResourceLimits, private readonly maximumIdentities = 10000) {
    this.limits = structuredClone(limits);
    for (const [key, value] of Object.entries(this.limits)) {
      if (!Number.isSafeInteger(value) || value < (key === "writeBytes" ? 0 : 1)) throw new Error("Invalid resource budget");
    }
    if (!Number.isSafeInteger(maximumIdentities) || maximumIdentities < 1 || maximumIdentities > 100000) throw new Error("Invalid sampling capacity");
  }
  observe(monotonicTimeMs: number, samples: readonly ProcessResourceSample[]): ResourceBudgetDecision {
    if (!Number.isFinite(monotonicTimeMs) || monotonicTimeMs < 0 || monotonicTimeMs <= this.lastTime) throw new Error("Stale resource sample");
    if (samples.length > this.maximumIdentities) throw new Error("Resource sampling capacity exceeded");
    const next = new Map(this.counters), seen = new Set<string>();
    let residentBytes = 0;
    for (const sample of samples) {
      if (typeof sample.identity !== "string" || !sample.identity.trim() || sample.identity.length > 256 || seen.has(sample.identity)) throw new Error("Invalid process birth identity");
      seen.add(sample.identity);
      for (const value of [sample.cpuTimeMs, sample.residentBytes, sample.writeBytes]) {
        if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid native resource counter");
      }
      const prior = next.get(sample.identity);
      if (prior && (sample.cpuTimeMs < prior.cpuTimeMs || sample.writeBytes < prior.writeBytes)) throw new Error("Native resource counter regressed");
      next.set(sample.identity, { cpuTimeMs: sample.cpuTimeMs, writeBytes: sample.writeBytes });
      residentBytes += sample.residentBytes;
    }
    if (next.size > this.maximumIdentities) throw new Error("Resource identity history exhausted");
    let cpuTimeMs = 0, writeBytes = 0;
    for (const counter of next.values()) { cpuTimeMs += counter.cpuTimeMs; writeBytes += counter.writeBytes; }
    if (![cpuTimeMs, writeBytes, residentBytes].every(Number.isSafeInteger)) throw new Error("Resource counter overflow");
    const exceeded = this.exceeded ?? (cpuTimeMs > this.limits.cpuTimeMs ? "cpu_time"
      : residentBytes > this.limits.memoryBytes ? "memory"
      : samples.length > this.limits.maximumProcesses ? "process_count"
      : writeBytes > this.limits.writeBytes ? "write_bytes" : null);
    this.counters.clear(); for (const [key, value] of next) this.counters.set(key, value);
    this.lastTime = monotonicTimeMs; this.exceeded = exceeded;
    return { exceeded, cpuTimeMs, residentBytes, writeBytes, processCount: samples.length };
  }
}
