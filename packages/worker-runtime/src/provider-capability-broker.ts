import { randomUUID } from "node:crypto";
import { canonicalJson } from "@traceforge/orchestration-core";
import type { ToolExecutionContext } from "./model.js";

export interface ProviderCapabilityIdentity {
  id: string;
  version: string;
  generation: number;
}

export interface ProviderCapabilityInvocation {
  provider: ProviderCapabilityIdentity;
  parentRequestId: string;
  capability: string;
  action: string;
  idempotencyKey: string;
  input: unknown;
  attribution: ToolExecutionContext;
  depth: number;
}

export interface ProviderCapabilityAuthorizationDecision {
  decision: "approved" | "rejected" | "pending";
  authorizationRef?: string;
  approvalRef?: string;
  reason?: string;
}

export interface ProviderCapabilityAuthorizationPort {
  authorize(invocation: ProviderCapabilityInvocation): Promise<ProviderCapabilityAuthorizationDecision>;
}

export interface ProviderCapabilityHandlerResult {
  output: unknown;
  refs: string[];
}

export interface ProviderCapabilityHandler {
  capability: string;
  execute(invocation: ProviderCapabilityInvocation, signal: AbortSignal): Promise<ProviderCapabilityHandlerResult>;
}

export interface ProviderCapabilityReceipt {
  id: string;
  provider: ProviderCapabilityIdentity;
  parentRequestId: string;
  capability: string;
  action: string;
  idempotencyKey: string;
  inputFingerprint: string;
  attribution: Omit<ToolExecutionContext, "effectivePermissions">;
  status: "succeeded" | "failed" | "rejected" | "approval_required";
  authorizationRef?: string;
  approvalRef?: string;
  reason?: string;
  output?: unknown;
  refs: string[];
  requestBytes: number;
  responseBytes: number;
  retryable: boolean;
  startedAt: string;
  completedAt: string;
  replayed?: boolean;
}

export interface ProviderCapabilityReceiptPort {
  get(providerId: string, idempotencyKey: string): Promise<ProviderCapabilityReceipt | undefined>;
  put(receipt: ProviderCapabilityReceipt): Promise<void>;
}

export interface ProviderCapabilityBrokerLimits {
  maximumDepth: number;
  maximumConcurrent: number;
  maximumConcurrentPerProvider: number;
  maximumRequestBytes: number;
  maximumResponseBytes: number;
  timeoutMs: number;
}

export interface ProviderCapabilityBrokerOptions {
  authorizer: ProviderCapabilityAuthorizationPort;
  receipts: ProviderCapabilityReceiptPort;
  handlers: ProviderCapabilityHandler[];
  limits?: Partial<ProviderCapabilityBrokerLimits>;
  createId?: () => string;
  now?: () => string;
}

export interface ProviderCapabilityHost {
  invoke(input: ProviderCapabilityInvocation): Promise<ProviderCapabilityReceipt>;
}

const defaultLimits: ProviderCapabilityBrokerLimits = {
  maximumDepth: 1,
  maximumConcurrent: 32,
  maximumConcurrentPerProvider: 4,
  maximumRequestBytes: 256 * 1024,
  maximumResponseBytes: 4 * 1024 * 1024,
  timeoutMs: 15_000,
};

interface ActiveInvocation {
  fingerprint: string;
  promise: Promise<ProviderCapabilityReceipt>;
}

/** Generic host-side capability gate. Capability semantics live in registered handlers. */
export class ProviderCapabilityBroker {
  private readonly handlers = new Map<string, ProviderCapabilityHandler>();
  private readonly limits: ProviderCapabilityBrokerLimits;
  private readonly createId: () => string;
  private readonly now: () => string;
  private readonly active = new Map<string, ActiveInvocation>();
  private readonly activeByProvider = new Map<string, number>();
  private activeCount = 0;

  constructor(private readonly options: ProviderCapabilityBrokerOptions) {
    this.limits = { ...defaultLimits, ...options.limits };
    for (const [name, value] of Object.entries(this.limits)) {
      if (!Number.isInteger(value) || value < 1) throw new Error(`Provider capability ${name} must be a positive integer`);
    }
    for (const handler of options.handlers) {
      const capability = required(handler.capability, "handler capability");
      if (this.handlers.has(capability)) throw new Error(`Duplicate Provider capability handler ${capability}`);
      this.handlers.set(capability, handler);
    }
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async invoke(input: ProviderCapabilityInvocation): Promise<ProviderCapabilityReceipt> {
    const invocation = this.validate(input);
    const fingerprint = canonicalJson({
      provider: { id: invocation.provider.id, version: invocation.provider.version },
      capability: invocation.capability,
      action: invocation.action,
      idempotencyKey: invocation.idempotencyKey,
      input: invocation.input ?? null,
      attribution: {
        caseId: invocation.attribution.caseId,
        runId: invocation.attribution.runId,
        workId: invocation.attribution.workId,
        workerId: invocation.attribution.workerId,
        scopeRef: invocation.attribution.scopeRef,
        leaseId: invocation.attribution.leaseId,
        idempotencyKey: invocation.attribution.idempotencyKey,
        effectivePermissions: invocation.attribution.effectivePermissions,
      },
      depth: invocation.depth,
    });
    const recorded = await this.options.receipts.get(invocation.provider.id, invocation.idempotencyKey);
    if (recorded) {
      if (recorded.inputFingerprint !== fingerprint) {
        throw new Error("Provider capability idempotency key was reused with different input");
      }
      if (recorded.status !== "approval_required") return { ...recorded, replayed: true };
    }

    const key = `${invocation.provider.id}\u0000${invocation.idempotencyKey}`;
    const active = this.active.get(key);
    if (active) {
      if (active.fingerprint !== fingerprint) throw new Error("Provider capability idempotency key was reused with different input");
      return { ...(await active.promise), replayed: true };
    }

    const promise = this.execute(invocation, fingerprint);
    this.active.set(key, { fingerprint, promise });
    try {
      return await promise;
    } finally {
      this.active.delete(key);
    }
  }

  private async execute(invocation: ProviderCapabilityInvocation, fingerprint: string): Promise<ProviderCapabilityReceipt> {
    const startedAt = this.now();
    const requestBytes = encodedBytes(invocation.input);
    const reject = (status: "failed" | "rejected" | "approval_required", reason: string, retryable = false,
      authorization?: ProviderCapabilityAuthorizationDecision) => this.persist({
        invocation, fingerprint, startedAt, requestBytes, status, reason, retryable,
        authorizationRef: authorization?.authorizationRef,
        approvalRef: authorization?.approvalRef,
      });

    if (invocation.depth > this.limits.maximumDepth) {
      return reject("rejected", `Provider capability call depth ${invocation.depth} exceeds limit ${this.limits.maximumDepth}`);
    }
    if (requestBytes > this.limits.maximumRequestBytes) {
      return reject("rejected", `Provider capability request exceeds ${this.limits.maximumRequestBytes} bytes`);
    }
    if (Date.parse(invocation.attribution.leaseExpiresAt) <= Date.parse(startedAt)) {
      return reject("rejected", `Provider capability lease ${invocation.attribution.leaseId} has expired`);
    }
    const handler = this.handlers.get(invocation.capability);
    if (!handler) return reject("rejected", `Provider capability ${invocation.capability} is not registered`);
    const providerActive = this.activeByProvider.get(invocation.provider.id) ?? 0;
    if (this.activeCount >= this.limits.maximumConcurrent) {
      return reject("rejected", "Provider capability global concurrency limit exceeded", true);
    }
    if (providerActive >= this.limits.maximumConcurrentPerProvider) {
      return reject("rejected", `Provider capability concurrency limit exceeded for ${invocation.provider.id}`, true);
    }

    this.activeCount += 1;
    this.activeByProvider.set(invocation.provider.id, providerActive + 1);
    try {
      let authorization: ProviderCapabilityAuthorizationDecision;
      try {
        authorization = await this.options.authorizer.authorize(invocation);
      } catch (error) {
        return reject("failed", `Provider capability authorization failed: ${message(error)}`, true);
      }
      if (authorization.decision === "rejected") {
        return reject("rejected", authorization.reason ?? "Provider capability authorization rejected", false, authorization);
      }
      if (authorization.decision === "pending") {
        return reject("approval_required", authorization.reason ?? "Provider capability approval required", true, authorization);
      }
      if (!authorization.authorizationRef?.trim()) {
        return reject("failed", "Approved Provider capability call is missing an authorization reference", false, authorization);
      }

      try {
        const result = await withTimeout(
          (signal) => handler.execute(invocation, signal),
          this.limits.timeoutMs,
        );
        if (!Array.isArray(result.refs) || result.refs.some((ref) => typeof ref !== "string" || !ref.trim())) {
          return reject("failed", "Provider capability handler returned invalid Evidence references", false, authorization);
        }
        const responseBytes = encodedBytes(result.output);
        if (responseBytes > this.limits.maximumResponseBytes) {
          return reject("failed", `Provider capability response exceeds ${this.limits.maximumResponseBytes} bytes`, false, authorization);
        }
        return this.persist({
          invocation, fingerprint, startedAt, requestBytes, responseBytes,
          status: "succeeded", authorizationRef: authorization.authorizationRef,
          output: result.output, refs: result.refs, retryable: false,
        });
      } catch (error) {
        return reject("failed", `Provider capability handler failed: ${message(error)}`, isRetryable(error), authorization);
      }
    } finally {
      this.activeCount -= 1;
      const remaining = (this.activeByProvider.get(invocation.provider.id) ?? 1) - 1;
      if (remaining > 0) this.activeByProvider.set(invocation.provider.id, remaining);
      else this.activeByProvider.delete(invocation.provider.id);
    }
  }

  private persist(input: {
    invocation: ProviderCapabilityInvocation;
    fingerprint: string;
    startedAt: string;
    requestBytes: number;
    responseBytes?: number;
    status: ProviderCapabilityReceipt["status"];
    authorizationRef?: string;
    approvalRef?: string;
    reason?: string;
    output?: unknown;
    refs?: string[];
    retryable: boolean;
  }): Promise<ProviderCapabilityReceipt> {
    const { effectivePermissions: _effectivePermissions, ...attribution } = input.invocation.attribution;
    const receipt: ProviderCapabilityReceipt = {
      id: this.createId(),
      provider: { ...input.invocation.provider },
      parentRequestId: input.invocation.parentRequestId,
      capability: input.invocation.capability,
      action: input.invocation.action,
      idempotencyKey: input.invocation.idempotencyKey,
      inputFingerprint: input.fingerprint,
      attribution,
      status: input.status,
      authorizationRef: input.authorizationRef,
      approvalRef: input.approvalRef,
      reason: input.reason,
      output: input.output,
      refs: input.refs ?? [],
      requestBytes: input.requestBytes,
      responseBytes: input.responseBytes ?? 0,
      retryable: input.retryable,
      startedAt: input.startedAt,
      completedAt: this.now(),
    };
    return this.options.receipts.put(receipt).then(() => receipt);
  }

  private validate(input: ProviderCapabilityInvocation): ProviderCapabilityInvocation {
    const provider = {
      id: required(input.provider.id, "provider id"),
      version: required(input.provider.version, "provider version"),
      generation: positiveInteger(input.provider.generation, "provider generation"),
    };
    const attribution = { ...input.attribution };
    for (const [label, value] of Object.entries({
      "parent request id": input.parentRequestId,
      capability: input.capability,
      action: input.action,
      "idempotency key": input.idempotencyKey,
      "case id": attribution.caseId,
      "run id": attribution.runId,
      "work id": attribution.workId,
      "worker id": attribution.workerId,
      "scope ref": attribution.scopeRef,
      "lease id": attribution.leaseId,
    })) required(value, label);
    if (!Number.isFinite(Date.parse(attribution.leaseExpiresAt))) throw new Error("Provider capability lease expiry is invalid");
    return {
      ...input,
      provider,
      parentRequestId: input.parentRequestId.trim(),
      capability: input.capability.trim(),
      action: input.action.trim(),
      idempotencyKey: input.idempotencyKey.trim(),
      attribution,
      depth: positiveInteger(input.depth, "call depth"),
    };
  }
}

async function withTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          const error = new Error(`timed out after ${timeoutMs}ms`);
          Object.assign(error, { retryable: true });
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function encodedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
}

function required(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Provider capability ${label} is required`);
  return value.trim();
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`Provider capability ${label} must be a positive integer`);
  return value;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

function isRetryable(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "retryable" in error && error.retryable === true)
    || /(?:timed out|timeout|temporar|network|ECONN|EAI_AGAIN)/i.test(message(error));
}
