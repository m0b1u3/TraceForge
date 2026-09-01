import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  ModelBudgetExceededError,
  ModelExecutionRuntime,
  type CognitiveModelRole,
  type ModelCallContext,
  type ModelCallRecord,
  type ModelExecutionStore,
  type ModelUsageSnapshot,
} from "@traceforge/model-runtime";

export {
  DEFAULT_MODEL_ROLE_POLICIES,
  ModelBudgetExceededError,
  ModelExecutionRuntime,
} from "@traceforge/model-runtime";
export type {
  CognitiveModelRole,
  ModelCallContext,
  ModelCallRecord,
  ModelJsonProviderPort,
  ModelJsonRequest,
  ModelRolePolicy,
  ModelUsageSnapshot,
} from "@traceforge/model-runtime";

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

export class SqliteModelExecutionStore implements ModelExecutionStore {
  constructor(private readonly sqlite: Database.Database) {}

  recoverInterrupted(at: string): number {
    return this.sqlite.prepare(`
      UPDATE scenario_model_calls
      SET status = 'failed', termination_kind = 'interrupted', error = 'runtime restarted before model call completed', completed_at = ?
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

  finish(id: string, status: "completed" | "failed" | "timed_out", usage: ModelUsageSnapshot, error: string | null, at: string, terminationKind?: "cancelled"): void {
    if (terminationKind && status!=="failed") throw new Error("Incompatible model termination status");
    const updated = this.sqlite.prepare(`
      UPDATE scenario_model_calls SET status = ?, prompt_tokens = ?, completion_tokens = ?, total_tokens = ?,
        error = ?, completed_at = ?, termination_kind = ? WHERE id = ? AND status = 'running'
    `).run(status, usage.promptTokens, usage.completionTokens, usage.totalTokens, error, at, terminationKind ?? null, id);
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
