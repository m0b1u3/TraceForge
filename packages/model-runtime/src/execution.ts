import { randomUUID } from "node:crypto";
import type {
  CognitiveModelRole,
  ModelAdmissionOutcome,
  ModelAdmissionPermit,
  ModelCallContext,
} from "./index.js";

export interface ModelUsageSnapshot {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ModelJsonRequest {
  system: string;
  user: string;
  schema: Record<string, unknown>;
  signal?: AbortSignal;
  onUsage?: (usage: ModelUsageSnapshot) => void;
  /** Host-local authorization recheck after admission and before each actual dispatch. */
  beforeDispatch?: () => void | Promise<void>;
}

export interface ModelJsonProviderPort {
  extractJson(request: ModelJsonRequest): Promise<unknown>;
}

export interface ModelRolePolicy {
  routeIds: string[];
  timeoutMs: number;
  maximumAttemptsPerRoute: number;
  circuitFailureThreshold: number;
  circuitResetMs: number;
  maximumRunTokens: number;
  maximumEstimatedCallTokens: number;
}

export interface ModelCallRecord {
  id: string;
  snapshotId: string;
  runId: string;
  caseId: string;
  workId: string | null;
  role: CognitiveModelRole;
  routeId: string;
  routeAttempt: number;
  status: "running" | "completed" | "failed" | "timed_out";
  reservedTokens: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
}

export const DEFAULT_MODEL_ROLE_POLICIES: Record<CognitiveModelRole, ModelRolePolicy> = {
  planner: {
    routeIds: ["primary"], timeoutMs: 120_000, maximumAttemptsPerRoute: 2,
    circuitFailureThreshold: 3, circuitResetMs: 60_000, maximumRunTokens: 250_000, maximumEstimatedCallTokens: 64_000,
  },
  observer: {
    routeIds: ["primary"], timeoutMs: 90_000, maximumAttemptsPerRoute: 2,
    circuitFailureThreshold: 3, circuitResetMs: 60_000, maximumRunTokens: 150_000, maximumEstimatedCallTokens: 48_000,
  },
  worker: {
    routeIds: ["primary"], timeoutMs: 120_000, maximumAttemptsPerRoute: 2,
    circuitFailureThreshold: 3, circuitResetMs: 60_000, maximumRunTokens: 500_000, maximumEstimatedCallTokens: 64_000,
  },
};

export class ModelBudgetExceededError extends Error {
  constructor(readonly runId: string, readonly role: CognitiveModelRole, readonly limit: number, readonly committed: number, readonly requested: number) {
    super(`Model token budget exceeded for ${role} in Run ${runId}: ${committed} committed/reserved + ${requested} requested > ${limit}`);
    this.name = "ModelBudgetExceededError";
  }
}

export interface ModelExecutionStore {
  recoverInterrupted(at: string): number;
  reserve(input: {
    id: string;
    context: ModelCallContext;
    routeId: string;
    routeAttempt: number;
    reservedTokens: number;
    maximumRunTokens: number;
    at: string;
  }): void;
  finish(id: string, status: "completed" | "failed" | "timed_out", usage: ModelUsageSnapshot, error: string | null, at: string, terminationKind?: "cancelled"): void;
  circuit(role: CognitiveModelRole, routeId: string): { consecutiveFailures: number; openUntil: string | null };
  recordRouteSuccess(role: CognitiveModelRole, routeId: string, at: string): void;
  recordRouteFailure(role: CognitiveModelRole, routeId: string, threshold: number, resetMs: number, at: string): void;
}

export interface ModelAdmissionPort {
  acquire(context: ModelCallContext, signal?: AbortSignal): Promise<ModelAdmissionPermit>;
  cancelRun(runId: string, reason?: string): void;
  cancelWork(runId: string, workId: string, reason?: string): void;
  shutdown(reason?: string): void;
}

export interface ModelExecutionEventPort {
  append(event: {
    method: "item/started" | "item/completed";
    runId: string;
    caseId: string;
    workId: string | null;
    turnId: string;
    role: CognitiveModelRole;
    params: {
      item: {
        type: "modelCall";
        id: string;
        routeId: string;
        attempt: number;
        status: "inProgress" | "completed" | "failed" | "timedOut" | "cancelled";
        reservedTokens: number;
        usage: ModelUsageSnapshot | null;
        error: string | null;
      };
    };
  }): unknown;
}

function estimateTokens(request: ModelJsonRequest): number {
  return Math.max(1, Math.ceil((request.system.length + request.user.length + JSON.stringify(request.schema).length) / 4));
}

function emptyUsage(): ModelUsageSnapshot {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function retryable(error: unknown): boolean {
  const value = error as { name?: string; status?: number; statusCode?: number; code?: string; message?: string };
  if (value.name === "AbortError" || value.name === "TimeoutError") return true;
  const status = value.status ?? value.statusCode;
  if (status !== undefined) return [408, 409, 425, 429, 500, 502, 503, 504].includes(status);
  return /timeout|network|econn|fetch failed|socket|rate limit/i.test(`${value.code ?? ""} ${value.message ?? ""}`);
}

export class ModelExecutionRuntime {
  private readonly activeControllers = new Map<string, { context: ModelCallContext; controller: AbortController }>();

  constructor(
    private readonly routes: ReadonlyMap<string, ModelJsonProviderPort>,
    private readonly policies: Record<CognitiveModelRole, ModelRolePolicy>,
    private readonly store: ModelExecutionStore,
    private readonly admissions: ModelAdmissionPort,
    private readonly createId: () => string = randomUUID,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly events?: ModelExecutionEventPort,
  ) {
    this.store.recoverInterrupted(this.now());
    for (const [role, policy] of Object.entries(policies)) {
      if (!policy.routeIds.length || policy.timeoutMs < 1 || policy.maximumAttemptsPerRoute < 1 || policy.circuitFailureThreshold < 1
        || policy.circuitResetMs < 1 || policy.maximumRunTokens < 1 || policy.maximumEstimatedCallTokens < 1) {
        throw new Error(`Invalid model policy for ${role}`);
      }
      if (!policy.routeIds.some((routeId) => routes.has(routeId))) throw new Error(`Model policy for ${role} has no configured route`);
    }
  }

  async extractJson(context: ModelCallContext, request: ModelJsonRequest): Promise<unknown> {
    const policy = this.policies[context.role];
    const estimate = estimateTokens(request);
    if (estimate > policy.maximumEstimatedCallTokens) {
      throw new ModelBudgetExceededError(context.runId, context.role, policy.maximumEstimatedCallTokens, 0, estimate);
    }
    let lastError: unknown = new Error(`No available model route for ${context.role}`);
    for (const routeId of policy.routeIds) {
      const provider = this.routes.get(routeId);
      if (!provider) { lastError = new Error(`Unknown model route ${routeId}`); continue; }
      const circuit = this.store.circuit(context.role, routeId);
      if (circuit.openUntil && Date.parse(circuit.openUntil) > Date.parse(this.now())) {
        lastError = new Error(`Model route ${routeId} circuit is open until ${circuit.openUntil}`);
        continue;
      }
      for (let attempt = 1; attempt <= policy.maximumAttemptsPerRoute; attempt += 1) {
        const permit = await this.admissions.acquire(context, request.signal);
        const circuitAfterAdmission = this.store.circuit(context.role, routeId);
        if (circuitAfterAdmission.openUntil && Date.parse(circuitAfterAdmission.openUntil) > Date.parse(this.now())) {
          const reason = `Model route ${routeId} circuit opened while request was queued until ${circuitAfterAdmission.openUntil}`;
          permit.release("cancelled", reason);
          lastError = new Error(reason);
          break;
        }
        const callId = this.createId();
        let permitOutcome: Exclude<ModelAdmissionOutcome, null> = "failed";
        let permitReason: string | undefined;
        try {
          this.store.reserve({ id: callId, context, routeId, routeAttempt: attempt, reservedTokens: estimate, maximumRunTokens: policy.maximumRunTokens, at: this.now() });
          this.emitModelItem(context, "item/started", callId, routeId, attempt, "inProgress", estimate, null, null);
        } catch (error) {
          permitReason = errorMessage(error);
          permit.release(permitOutcome, permitReason);
          throw error;
        }
        const usage = emptyUsage();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new DOMException("model call timed out", "TimeoutError")), policy.timeoutMs);
        timer.unref();
        const externalAbort = () => controller.abort(request.signal?.reason ?? new DOMException("model call cancelled", "AbortError"));
        request.signal?.addEventListener("abort", externalAbort, { once: true });
        if (request.signal?.aborted) externalAbort();
        this.activeControllers.set(callId, { context, controller });
        let settled = false;
        let dispatched = false;
        let abortCall: (() => void) | undefined;
        try {
          const aborted = new Promise<never>((_resolve, reject) => {
            abortCall = () => reject(controller.signal.reason);
            controller.signal.addEventListener("abort", abortCall, { once: true });
            if (controller.signal.aborted) abortCall();
          });
          // The host deadline must hold even if a Provider ignores AbortSignal.
          const invocation = Promise.resolve().then(async () => {
            controller.signal.throwIfAborted();
            await request.beforeDispatch?.();
            controller.signal.throwIfAborted();
            const { beforeDispatch: _hostCheck, ...providerRequest } = request;
            dispatched = true;
            return provider.extractJson({
              ...providerRequest,
              signal: controller.signal,
              onUsage: (value) => {
                if (settled || controller.signal.aborted) return;
                usage.promptTokens += value.promptTokens;
                usage.completionTokens += value.completionTokens;
                usage.totalTokens += value.totalTokens;
                request.onUsage?.(value);
              },
            });
          });
          const output = await Promise.race([invocation, aborted]);
          controller.signal.throwIfAborted();
          settled = true;
          clearTimeout(timer);
          this.store.finish(callId, "completed", usage, null, this.now());
          this.store.recordRouteSuccess(context.role, routeId, this.now());
          this.emitModelItem(context, "item/completed", callId, routeId, attempt, "completed", estimate, usage, null);
          permitOutcome = "completed";
          return output;
        } catch (error) {
          const timedOut = controller.signal.aborted && controller.signal.reason instanceof DOMException
            && controller.signal.reason.name === "TimeoutError";
          const cancelled = controller.signal.aborted && !timedOut;
          this.store.finish(callId, timedOut ? "timed_out" : "failed", usage, errorMessage(error), this.now(), cancelled ? "cancelled" : undefined);
          if (!cancelled && dispatched) this.store.recordRouteFailure(context.role, routeId, policy.circuitFailureThreshold, policy.circuitResetMs, this.now());
          permitOutcome = timedOut ? "timed_out" : cancelled ? "cancelled" : "failed";
          permitReason = errorMessage(error);
          this.emitModelItem(context, "item/completed", callId, routeId, attempt,
            timedOut ? "timedOut" : cancelled ? "cancelled" : "failed", estimate, usage, permitReason);
          lastError = error;
          if (cancelled || !dispatched) throw error;
          if (!retryable(error)) break;
          const updatedCircuit = this.store.circuit(context.role, routeId);
          if (updatedCircuit.openUntil && Date.parse(updatedCircuit.openUntil) > Date.parse(this.now())) break;
        } finally {
          settled = true;
          if (abortCall) controller.signal.removeEventListener("abort", abortCall);
          clearTimeout(timer);
          request.signal?.removeEventListener("abort", externalAbort);
          this.activeControllers.delete(callId);
          permit.release(permitOutcome, permitReason);
        }
      }
    }
    throw lastError;
  }

  cancelRun(runId: string, reason = "Run cancelled"): void {
    this.admissions.cancelRun(runId, reason);
    for (const active of this.activeControllers.values()) {
      if (active.context.runId === runId) active.controller.abort(new DOMException(reason, "AbortError"));
    }
  }

  cancelWork(runId: string, workId: string, reason = "Work cancelled"): void {
    this.admissions.cancelWork(runId, workId, reason);
    for (const active of this.activeControllers.values()) {
      if (active.context.runId === runId && active.context.workId === workId) {
        active.controller.abort(new DOMException(reason, "AbortError"));
      }
    }
  }

  shutdown(reason = "model runtime shutting down"): void {
    this.admissions.shutdown(reason);
    for (const active of this.activeControllers.values()) active.controller.abort(new DOMException(reason, "AbortError"));
  }

  private emitModelItem(
    context: ModelCallContext,
    method: "item/started" | "item/completed",
    id: string,
    routeId: string,
    attempt: number,
    status: "inProgress" | "completed" | "failed" | "timedOut" | "cancelled",
    reservedTokens: number,
    usage: ModelUsageSnapshot | null,
    error: string | null,
  ): void {
    this.events?.append({
      method, runId: context.runId, caseId: context.caseId, workId: context.workId ?? null,
      turnId: context.snapshotId, role: context.role,
      params: { item: { type: "modelCall", id, routeId, attempt, status, reservedTokens, usage, error } },
    });
  }
}
