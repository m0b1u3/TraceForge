export type ToolProviderFailureKind = "crash" | "transport" | "protocol" | "policy" | "resource" | "unknown";
export type ToolProviderRecoveryStatus = "healthy" | "backoff" | "recovering" | "observing" | "quarantined";

export interface ToolProviderRecoveryIdentity {
  providerId: string;
  version: string;
}

export interface ToolProviderFailureRecord {
  kind: ToolProviderFailureKind;
  message: string;
  retryable: boolean;
  at: string;
}

export interface ToolProviderRecoverySnapshot {
  schemaVersion: 1;
  identity: ToolProviderRecoveryIdentity;
  status: ToolProviderRecoveryStatus;
  revision: number;
  failures: ToolProviderFailureRecord[];
  nextAttemptAt: string | null;
  stabilityDeadlineAt: string | null;
  quarantineReason: string | null;
  updatedAt: string;
}

export interface ToolProviderRecoveryStatePort {
  load(identity: ToolProviderRecoveryIdentity): Promise<ToolProviderRecoverySnapshot | undefined>;
  save(snapshot: ToolProviderRecoverySnapshot): Promise<void>;
}

export interface ToolProviderRecoveryOptions {
  identity: ToolProviderRecoveryIdentity;
  state: ToolProviderRecoveryStatePort;
  baseDelayMs: number;
  maximumDelayMs: number;
  failureBudget: number;
  failureWindowMs: number;
  stabilityWindowMs: number;
  jitterRatio?: number;
  now?: () => Date;
  random?: () => number;
}

export interface ToolProviderRecoveryAttemptResult {
  attempted: boolean;
  recovered: boolean;
  coalesced?: boolean;
  snapshot: ToolProviderRecoverySnapshot;
}

/** Persistent, scenario-neutral restart admission and quarantine state machine. */
export class ToolProviderRecoverySupervisor {
  private snapshotValue: ToolProviderRecoverySnapshot;
  private activeRecovery: Promise<ToolProviderRecoveryAttemptResult> | undefined;
  private readonly now: () => Date;
  private readonly random: () => number;

  private constructor(private readonly options: ToolProviderRecoveryOptions) {
    validateOptions(options);
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? Math.random;
    const at = this.now().toISOString();
    this.snapshotValue = {
      schemaVersion: 1,
      identity: normalizedIdentity(options.identity),
      status: "healthy",
      revision: 0,
      failures: [],
      nextAttemptAt: null,
      stabilityDeadlineAt: null,
      quarantineReason: null,
      updatedAt: at,
    };
  }

  static async open(options: ToolProviderRecoveryOptions): Promise<ToolProviderRecoverySupervisor> {
    const supervisor = new ToolProviderRecoverySupervisor(options);
    const stored = await options.state.load(supervisor.snapshotValue.identity);
    if (stored) {
      supervisor.snapshotValue = parseToolProviderRecoverySnapshot(stored, supervisor.snapshotValue.identity);
      if (stored.status === "recovering") {
        const now = supervisor.now();
        supervisor.snapshotValue = supervisor.next({
          status: "backoff",
          nextAttemptAt: new Date(now.getTime() + options.baseDelayMs).toISOString(),
          stabilityDeadlineAt: null,
          quarantineReason: null,
        }, now);
        await supervisor.persist();
      }
    }
    return supervisor;
  }

  snapshot(): ToolProviderRecoverySnapshot {
    return structuredClone(this.snapshotValue);
  }

  canAttempt(at = this.now()): boolean {
    return this.snapshotValue.status === "backoff"
      && this.snapshotValue.nextAttemptAt !== null
      && Date.parse(this.snapshotValue.nextAttemptAt) <= at.getTime();
  }

  async recordFailure(error: unknown): Promise<ToolProviderRecoverySnapshot> {
    if (this.snapshotValue.status === "quarantined") return this.snapshot();
    const at = this.now();
    const failure = classifyToolProviderFailure(error, at);
    const cutoff = at.getTime() - this.options.failureWindowMs;
    const failures = this.snapshotValue.failures
      .filter((entry) => Date.parse(entry.at) >= cutoff)
      .concat(failure)
      .slice(-this.options.failureBudget);
    const budgetExhausted = failures.length >= this.options.failureBudget;
    if (!failure.retryable || budgetExhausted) {
      this.snapshotValue = this.next({
        status: "quarantined",
        failures,
        nextAttemptAt: null,
        stabilityDeadlineAt: null,
        quarantineReason: !failure.retryable
          ? `${failure.kind} failure requires explicit operator recovery: ${failure.message}`
          : `Failure budget ${this.options.failureBudget} exhausted within ${this.options.failureWindowMs}ms`,
      }, at);
    } else {
      const delay = backoffDelay(this.options, failures.length, this.random());
      this.snapshotValue = this.next({
        status: "backoff",
        failures,
        nextAttemptAt: new Date(at.getTime() + delay).toISOString(),
        stabilityDeadlineAt: null,
        quarantineReason: null,
      }, at);
    }
    await this.persist();
    return this.snapshot();
  }

  async runRecovery(recover: () => Promise<void>): Promise<ToolProviderRecoveryAttemptResult> {
    if (this.activeRecovery) {
      const result = await this.activeRecovery;
      return { ...result, coalesced: true, snapshot: structuredClone(result.snapshot) };
    }
    if (!this.canAttempt()) return { attempted: false, recovered: false, snapshot: this.snapshot() };
    this.activeRecovery = this.performRecovery(recover).finally(() => { this.activeRecovery = undefined; });
    return this.activeRecovery;
  }

  async observeHealthy(): Promise<ToolProviderRecoverySnapshot> {
    const at = this.now();
    if (this.snapshotValue.status !== "observing" || this.snapshotValue.stabilityDeadlineAt === null
      || Date.parse(this.snapshotValue.stabilityDeadlineAt) > at.getTime()) return this.snapshot();
    this.snapshotValue = this.next({
      status: "healthy",
      failures: [],
      nextAttemptAt: null,
      stabilityDeadlineAt: null,
      quarantineReason: null,
    }, at);
    await this.persist();
    return this.snapshot();
  }

  private async performRecovery(recover: () => Promise<void>): Promise<ToolProviderRecoveryAttemptResult> {
    const previous = this.snapshot();
    const started = this.now();
    this.snapshotValue = this.next({
      status: "recovering",
      nextAttemptAt: null,
      stabilityDeadlineAt: null,
      quarantineReason: null,
    }, started);
    await this.persist();
    try {
      await recover();
      const completed = this.now();
      this.snapshotValue = this.next({
        status: "observing",
        nextAttemptAt: null,
        stabilityDeadlineAt: new Date(completed.getTime() + this.options.stabilityWindowMs).toISOString(),
        quarantineReason: null,
      }, completed);
      await this.persist();
      return { attempted: true, recovered: true, snapshot: this.snapshot() };
    } catch (error) {
      if (isRecoveryNeutral(error)) {
        const returned = this.now();
        this.snapshotValue = {
          ...previous,
          revision: this.snapshotValue.revision + 1,
          updatedAt: returned.toISOString(),
        };
        await this.persist();
        throw error;
      }
      const snapshot = await this.recordFailure(error);
      return { attempted: true, recovered: false, snapshot };
    }
  }

  private next(
    patch: Partial<Omit<ToolProviderRecoverySnapshot, "schemaVersion" | "identity" | "revision" | "updatedAt">>,
    at: Date,
  ): ToolProviderRecoverySnapshot {
    return {
      ...this.snapshotValue,
      ...patch,
      identity: { ...this.snapshotValue.identity },
      failures: patch.failures ? patch.failures.map((failure) => ({ ...failure })) : this.snapshotValue.failures.map((failure) => ({ ...failure })),
      revision: this.snapshotValue.revision + 1,
      updatedAt: at.toISOString(),
    };
  }

  private persist(): Promise<void> {
    return this.options.state.save(this.snapshot());
  }
}

function isRecoveryNeutral(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "countsTowardProviderRecovery" in error
    && error.countsTowardProviderRecovery === false);
}

export function classifyToolProviderFailure(error: unknown, at = new Date()): ToolProviderFailureRecord {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown Tool Provider failure";
  const lower = message.toLowerCase();
  const code = error && typeof error === "object" && "code" in error ? String(error.code).toLowerCase() : "";
  let kind: ToolProviderFailureKind = "unknown";
  if (/sandbox|attestation|permission|unauthorized|forbidden/.test(lower) || /policy|permission|unauthorized/.test(code)) kind = "policy";
  else if (/protocol|handshake|frame|identity mismatch|version mismatch|invalid rpc/.test(lower) || /protocol|schema/.test(code)) kind = "protocol";
  else if (/resource|quota|memory|cpu|process count|write bytes/.test(lower) || /resource|quota/.test(code)) kind = "resource";
  else if (/exited|exit code|signal|crash|terminated unexpectedly/.test(lower) || /exit|crash/.test(code)) kind = "crash";
  else if (/transport|disconnect|connection|broken pipe|timed out|timeout|unavailable/.test(lower)
    || /transport|disconnect|timeout|unavailable/.test(code)
    || Boolean(error && typeof error === "object" && "retryable" in error && error.retryable === true)) kind = "transport";
  return { kind, message, retryable: kind !== "policy" && kind !== "protocol", at: at.toISOString() };
}

function backoffDelay(options: ToolProviderRecoveryOptions, failures: number, random: number): number {
  const raw = Math.min(options.maximumDelayMs, options.baseDelayMs * (2 ** Math.max(0, failures - 1)));
  const jitter = options.jitterRatio ?? 0.2;
  const boundedRandom = Math.min(1, Math.max(0, random));
  return Math.max(1, Math.round(raw * (1 - jitter + (2 * jitter * boundedRandom))));
}

function validateOptions(options: ToolProviderRecoveryOptions): void {
  normalizedIdentity(options.identity);
  for (const [name, value] of Object.entries({
    baseDelayMs: options.baseDelayMs,
    maximumDelayMs: options.maximumDelayMs,
    failureBudget: options.failureBudget,
    failureWindowMs: options.failureWindowMs,
    stabilityWindowMs: options.stabilityWindowMs,
  })) if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Tool Provider recovery ${name} must be a positive integer`);
  if (options.maximumDelayMs < options.baseDelayMs) throw new Error("Tool Provider recovery maximum delay cannot be shorter than base delay");
  const jitter = options.jitterRatio ?? 0.2;
  if (!Number.isFinite(jitter) || jitter < 0 || jitter > 1) throw new Error("Tool Provider recovery jitter ratio must be between 0 and 1");
}

function normalizedIdentity(identity: ToolProviderRecoveryIdentity): ToolProviderRecoveryIdentity {
  const providerId = identity.providerId.trim();
  const version = identity.version.trim();
  if (!providerId || !version) throw new Error("Tool Provider recovery identity is required");
  return { providerId, version };
}

export function parseToolProviderRecoverySnapshot(
  value: unknown,
  identity: ToolProviderRecoveryIdentity,
): ToolProviderRecoverySnapshot {
  const snapshot = value as ToolProviderRecoverySnapshot;
  if (!isRecord(snapshot) || snapshot.schemaVersion !== 1 || !isRecord(snapshot.identity)
    || snapshot.identity.providerId !== identity.providerId || snapshot.identity.version !== identity.version
    || typeof snapshot.status !== "string"
    || !["healthy", "backoff", "recovering", "observing", "quarantined"].includes(snapshot.status)
    || !Number.isSafeInteger(snapshot.revision) || Number(snapshot.revision) < 0 || !Array.isArray(snapshot.failures)
    || typeof snapshot.updatedAt !== "string" || !Number.isFinite(Date.parse(snapshot.updatedAt))) {
    throw new Error("Stored Tool Provider recovery state is invalid");
  }
  for (const failure of snapshot.failures) {
    if (!isRecord(failure) || typeof failure.kind !== "string"
      || !["crash", "transport", "protocol", "policy", "resource", "unknown"].includes(failure.kind)
      || typeof failure.message !== "string" || typeof failure.retryable !== "boolean" || !Number.isFinite(Date.parse(failure.at))) {
      throw new Error("Stored Tool Provider recovery failure is invalid");
    }
  }
  for (const value of [snapshot.nextAttemptAt, snapshot.stabilityDeadlineAt]) {
    if (value !== null && !Number.isFinite(Date.parse(value))) throw new Error("Stored Tool Provider recovery deadline is invalid");
  }
  if (snapshot.quarantineReason !== null && typeof snapshot.quarantineReason !== "string") {
    throw new Error("Stored Tool Provider quarantine reason is invalid");
  }
  if ((snapshot.status === "backoff") !== (snapshot.nextAttemptAt !== null)
    || (snapshot.status === "observing") !== (snapshot.stabilityDeadlineAt !== null)
    || (snapshot.status === "quarantined") !== (snapshot.quarantineReason !== null)) {
    throw new Error("Stored Tool Provider recovery lifecycle is inconsistent");
  }
  return structuredClone(snapshot);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
