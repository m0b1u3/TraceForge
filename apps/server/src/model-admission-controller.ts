import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  ModelAdmissionController,
  type CognitiveModelRole,
  type ModelAdmissionOutcome,
  type ModelAdmissionRecord,
  type ModelAdmissionStatus,
  type ModelAdmissionStore,
  type ModelCallContext,
} from "@traceforge/model-runtime";

export {
  DEFAULT_MODEL_RESOURCE_POLICY,
  ModelAdmissionController,
  ModelAdmissionRejectedError,
} from "@traceforge/model-runtime";
export type {
  ModelAdmissionOutcome,
  ModelAdmissionPermit,
  ModelAdmissionRecord,
  ModelAdmissionStatus,
  ModelResourcePolicy,
  ModelResourcePolicyOverrides,
} from "@traceforge/model-runtime";

interface AdmissionRow {
  id: string; snapshot_id: string; run_id: string; case_id: string; work_id: string | null;
  role: CognitiveModelRole; priority: number; status: ModelAdmissionStatus; outcome: ModelAdmissionOutcome;
  queued_at: string; admitted_at: string | null; released_at: string | null; queue_wait_ms: number | null; reason: string | null;
}

function parseAdmission(row: AdmissionRow): ModelAdmissionRecord {
  return {
    id: row.id, snapshotId: row.snapshot_id, runId: row.run_id, caseId: row.case_id, workId: row.work_id,
    role: row.role, priority: row.priority, status: row.status, outcome: row.outcome, queuedAt: row.queued_at,
    admittedAt: row.admitted_at, releasedAt: row.released_at, queueWaitMs: row.queue_wait_ms, reason: row.reason,
  };
}

export class SqliteModelAdmissionStore implements ModelAdmissionStore {
  constructor(private readonly sqlite: Database.Database) {}

  recoverInterrupted(at: string): number {
    return this.sqlite.prepare(`
      UPDATE scenario_model_admissions
      SET status = 'interrupted', outcome = 'cancelled', released_at = ?, reason = 'runtime restarted before release'
      WHERE status IN ('queued', 'admitted')
    `).run(at).changes;
  }

  enqueue(id: string, context: ModelCallContext, priority: number, at: string): void {
    this.sqlite.prepare(`
      INSERT INTO scenario_model_admissions
        (id, snapshot_id, run_id, case_id, work_id, role, priority, status, queued_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)
    `).run(id, context.snapshotId, context.runId, context.caseId, context.workId ?? null, context.role, priority, at);
  }

  admit(id: string, waitMs: number, at: string): void {
    const result = this.sqlite.prepare(`
      UPDATE scenario_model_admissions SET status = 'admitted', admitted_at = ?, queue_wait_ms = ?
      WHERE id = ? AND status = 'queued'
    `).run(at, waitMs, id);
    if (result.changes !== 1) throw new Error(`Cannot admit model request ${id}`);
  }

  finish(id: string, status: Exclude<ModelAdmissionStatus, "queued" | "admitted" | "interrupted">, outcome: ModelAdmissionOutcome, reason: string | null, at: string): void {
    const result = this.sqlite.prepare(`
      UPDATE scenario_model_admissions SET status = ?, outcome = ?, released_at = ?, reason = ?
      WHERE id = ? AND status IN ('queued', 'admitted')
    `).run(status, outcome, at, reason, id);
    if (result.changes !== 1) throw new Error(`Cannot finish model admission ${id}`);
  }

  list(runId: string): ModelAdmissionRecord[] {
    return (this.sqlite.prepare(`
      SELECT id, snapshot_id, run_id, case_id, work_id, role, priority, status, outcome,
             queued_at, admitted_at, released_at, queue_wait_ms, reason
      FROM scenario_model_admissions WHERE run_id = ? ORDER BY queued_at ASC, id ASC
    `).all(runId) as AdmissionRow[]).map(parseAdmission);
  }
}

export function registerModelAdmissionRoutes(app: FastifyInstance, controller: ModelAdmissionController, store: SqliteModelAdmissionStore): void {
  app.get("/api/model-execution/capacity", async () => controller.snapshot());
  app.get("/api/scenarios/runs/:runId/model-admissions", async (request) => {
    const { runId } = z.object({ runId: z.string().min(1) }).parse(request.params);
    return store.list(runId);
  });
}
