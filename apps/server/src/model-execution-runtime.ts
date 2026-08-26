import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ExtractJsonArgs, LlmProvider, UsageSnapshot } from "@traceforge/llm";
import type { ModelAdmissionController, ModelAdmissionPermit } from "./model-admission-controller.js";
import type { ScenarioAgentEventWriter } from "./scenario-agent-event-stream.js";

export type CognitiveModelRole = "planner" | "observer" | "worker";

export interface ModelRolePolicy {
  routeIds: string[];
  timeoutMs: number;
  maximumAttemptsPerRoute: number;
  circuitFailureThreshold: number;
  circuitResetMs: number;
  maximumRunTokens: number;
  maximumEstimatedCallTokens: number;
}

export interface ModelCallContext {
  role: CognitiveModelRole;
  snapshotId: string;
  runId: string;
  caseId: string;
  workId?: string;
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

interface CallRow {
  id: string; snapshot_id: string; run_id: string; case_id: string; work_id: string | null;
  role: CognitiveModelRole; route_id: string; route_attempt: number; status: ModelCallRecord["status"];
  reserved_tokens: number; prompt_tokens: number; completion_tokens: number; total_tokens: number;
  error: string | null; started_at: string; completed_at: string | null;
}

function parseCall(row: CallRow): ModelCallRecord {
  return {
    id: row.id, snapshotId: row.snapshot_id, runId: row.run_id, caseId: row.case_id, workId: row.work_id,
    role: row.role, routeId: row.route_id, routeAttempt: row.route_attempt, status: row.status,
    reservedTokens: row.reserved_tokens, promptTokens: row.prompt_tokens, completionTokens: row.completion_tokens,
    totalTokens: row.total_tokens, error: row.error, startedAt: row.started_at, completedAt: row.completed_at,
  };
}

const callColumns = `id, snapshot_id, run_id, case_id, work_id, role, route_id, route_attempt, status,
  reserved_tokens, prompt_tokens, completion_tokens, total_tokens, error, started_at, completed_at`;

export class ModelBudgetExceededError extends Error {
  constructor(readonly runId: string, readonly role: CognitiveModelRole, readonly limit: number, readonly committed: number, readonly requested: number) {
    super(`Model token budget exceeded for ${role} in Run ${runId}: ${committed} committed/reserved + ${requested} requested > ${limit}`);
    this.name = "ModelBudgetExceededError";
  }
}

export class SqliteModelExecutionStore {
  constructor(private readonly sqlite: Database.Database) {}

  recoverInterrupted(at: string): number {
    return this.sqlite.prepare(`
      UPDATE scenario_model_calls
      SET status = 'failed', error = 'runtime restarted before model call completed', completed_at = ?
      WHERE status = 'running'
    `).run(at).changes;
  }

  reserve(input: {
    id: string; context: ModelCallContext; routeId: string; routeAttempt: number;
    reservedTokens: number; maximumRunTokens: number; at: string;
  }): void {
    this.sqlite.transaction(() => {
      const usage = this.usage(input.context.runId, input.context.role);
      if (usage.accountedTokens + input.reservedTokens > input.maximumRunTokens) {
        throw new ModelBudgetExceededError(
          input.context.runId, input.context.role, input.maximumRunTokens, usage.accountedTokens, input.reservedTokens,
        );
      }
      this.sqlite.prepare(`
        INSERT INTO scenario_model_calls
          (id, snapshot_id, run_id, case_id, work_id, role, route_id, route_attempt, status, reserved_tokens, started_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)
      `).run(
        input.id, input.context.snapshotId, input.context.runId, input.context.caseId, input.context.workId ?? null,
        input.context.role, input.routeId, input.routeAttempt, input.reservedTokens, input.at,
      );
    })();
  }

  finish(id: string, status: "completed" | "failed" | "timed_out", usage: UsageSnapshot, error: string | null, at: string): void {
    const updated = this.sqlite.prepare(`
      UPDATE scenario_model_calls SET status = ?, prompt_tokens = ?, completion_tokens = ?, total_tokens = ?,
        error = ?, completed_at = ? WHERE id = ? AND status = 'running'
    `).run(status, usage.promptTokens, usage.completionTokens, usage.totalTokens, error, at, id);
    if (updated.changes !== 1) throw new Error(`Unknown or completed model call ${id}`);
  }

  usage(runId: string, role?: CognitiveModelRole): { promptTokens: number; completionTokens: number; totalTokens: number; accountedTokens: number } {
    const row = (role
      ? this.sqlite.prepare(`
          SELECT COALESCE(SUM(prompt_tokens), 0) prompt, COALESCE(SUM(completion_tokens), 0) completion,
            COALESCE(SUM(total_tokens), 0) total,
            COALESCE(SUM(CASE WHEN total_tokens > reserved_tokens THEN total_tokens ELSE reserved_tokens END), 0) accounted
          FROM scenario_model_calls WHERE run_id = ? AND role = ?
        `).get(runId, role)
      : this.sqlite.prepare(`
          SELECT COALESCE(SUM(prompt_tokens), 0) prompt, COALESCE(SUM(completion_tokens), 0) completion,
            COALESCE(SUM(total_tokens), 0) total,
            COALESCE(SUM(CASE WHEN total_tokens > reserved_tokens THEN total_tokens ELSE reserved_tokens END), 0) accounted
          FROM scenario_model_calls WHERE run_id = ?
        `).get(runId)) as { prompt: number; completion: number; total: number; accounted: number };
    return { promptTokens: row.prompt, completionTokens: row.completion, totalTokens: row.total, accountedTokens: row.accounted };
  }

  circuit(role: CognitiveModelRole, routeId: string): { consecutiveFailures: number; openUntil: string | null } {
    const row = this.sqlite.prepare(`
      SELECT consecutive_failures, open_until FROM scenario_model_circuits WHERE role = ? AND route_id = ?
    `).get(role, routeId) as { consecutive_failures: number; open_until: string | null } | undefined;
    return row ? { consecutiveFailures: row.consecutive_failures, openUntil: row.open_until } : { consecutiveFailures: 0, openUntil: null };
  }

  recordRouteSuccess(role: CognitiveModelRole, routeId: string, at: string): void {
    this.sqlite.prepare(`
      INSERT INTO scenario_model_circuits (role, route_id, consecutive_failures, open_until, updated_at)
      VALUES (?, ?, 0, NULL, ?)
      ON CONFLICT(role, route_id) DO UPDATE SET consecutive_failures = 0, open_until = NULL, updated_at = excluded.updated_at
    `).run(role, routeId, at);
  }

  recordRouteFailure(role: CognitiveModelRole, routeId: string, threshold: number, resetMs: number, at: string): void {
    const current = this.circuit(role, routeId);
    const failures = current.consecutiveFailures + 1;
    const openUntil = failures >= threshold ? new Date(Date.parse(at) + resetMs).toISOString() : null;
    this.sqlite.prepare(`
      INSERT INTO scenario_model_circuits (role, route_id, consecutive_failures, open_until, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(role, route_id) DO UPDATE SET consecutive_failures = excluded.consecutive_failures,
        open_until = excluded.open_until, updated_at = excluded.updated_at
    `).run(role, routeId, failures, openUntil, at);
  }

  list(runId: string): ModelCallRecord[] {
    return (this.sqlite.prepare(`SELECT ${callColumns} FROM scenario_model_calls WHERE run_id = ? ORDER BY started_at ASC`)
      .all(runId) as CallRow[]).map(parseCall);
  }
}

function estimateTokens(request: ExtractJsonArgs): number {
  return Math.max(1, Math.ceil((request.system.length + request.user.length + JSON.stringify(request.schema).length) / 4));
}

function emptyUsage(): UsageSnapshot {
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
    private readonly routes: ReadonlyMap<string, LlmProvider>,
    private readonly policies: Record<CognitiveModelRole, ModelRolePolicy>,
    private readonly store: SqliteModelExecutionStore,
    private readonly admissions: ModelAdmissionController,
    private readonly createId: () => string = randomUUID,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly events?: ScenarioAgentEventWriter,
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

  async extractJson(context: ModelCallContext, request: ExtractJsonArgs): Promise<unknown> {
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
        let permitOutcome: Parameters<ModelAdmissionPermit["release"]>[0] = "failed";
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
        try {
          const output = await provider.extractJson({
            ...request,
            signal: controller.signal,
            onUsage: (value) => {
              usage.promptTokens += value.promptTokens;
              usage.completionTokens += value.completionTokens;
              usage.totalTokens += value.totalTokens;
              request.onUsage?.(value);
            },
          });
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
          this.store.finish(callId, timedOut ? "timed_out" : "failed", usage, errorMessage(error), this.now());
          if (!cancelled) this.store.recordRouteFailure(context.role, routeId, policy.circuitFailureThreshold, policy.circuitResetMs, this.now());
          permitOutcome = timedOut ? "timed_out" : cancelled ? "cancelled" : "failed";
          permitReason = errorMessage(error);
          this.emitModelItem(context, "item/completed", callId, routeId, attempt,
            timedOut ? "timedOut" : cancelled ? "cancelled" : "failed", estimate, usage, permitReason);
          lastError = error;
          if (cancelled) throw error;
          if (!retryable(error)) break;
          const updatedCircuit = this.store.circuit(context.role, routeId);
          if (updatedCircuit.openUntil && Date.parse(updatedCircuit.openUntil) > Date.parse(this.now())) break;
        } finally {
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
    usage: UsageSnapshot | null,
    error: string | null,
  ): void {
    this.events?.append({
      method, runId: context.runId, caseId: context.caseId, workId: context.workId ?? null,
      turnId: context.snapshotId, role: context.role,
      params: { item: { type: "modelCall", id, routeId, attempt, status, reservedTokens, usage, error } },
    });
  }
}

export function registerModelExecutionRoutes(app: FastifyInstance, store: SqliteModelExecutionStore): void {
  app.get("/api/scenarios/runs/:runId/model-calls", async (request) => {
    const { runId } = z.object({ runId: z.string().min(1) }).parse(request.params);
    return store.list(runId);
  });
  app.get("/api/scenarios/runs/:runId/model-usage", async (request) => {
    const { runId } = z.object({ runId: z.string().min(1) }).parse(request.params);
    const { role } = z.object({ role: z.enum(["planner", "observer", "worker"]).optional() }).parse(request.query);
    return store.usage(runId, role);
  });
}
