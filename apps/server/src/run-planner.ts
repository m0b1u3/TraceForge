import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ScenarioRunState } from "@traceforge/orchestration-core";
import { parseRunPlannerDecision, type RunPlannerDecision, type RunPlannerStorePort } from "@traceforge/cognitive-runtime";

interface EvaluationRow {
  id: string; decision_json: string; applied: number; resulting_run_revision: number | null; observed_phase_id: string;
}

export interface PlannerEvaluationRecord {
  id: string; runId: string; caseId: string; inputFingerprint: string; observedRunRevision: number;
  observedGraphRevision: number; observedPhaseId: string; decision: RunPlannerDecision; applied: boolean;
  resultingRunRevision: number | null; createdAt: string; appliedAt: string | null;
}

/** SQLite persistence adapter; planning policy and supervision live in cognitive-runtime. */
export class SqliteRunPlannerStore implements RunPlannerStorePort {
  constructor(private readonly sqlite: Database.Database) {}

  cursor(runId: string): string | undefined {
    return (this.sqlite.prepare("SELECT input_fingerprint FROM scenario_planner_cursors WHERE run_id = ?")
      .get(runId) as { input_fingerprint: string } | undefined)?.input_fingerprint;
  }

  find(runId: string, fingerprint: string) {
    const row = this.sqlite.prepare(`
      SELECT id, decision_json, applied, resulting_run_revision, observed_phase_id
      FROM scenario_planner_evaluations WHERE run_id = ? AND input_fingerprint = ?
    `).get(runId, fingerprint) as EvaluationRow | undefined;
    return row ? { id: row.id, decision: parseRunPlannerDecision(JSON.parse(row.decision_json)), applied: row.applied === 1,
      resultingRunRevision: row.resulting_run_revision, observedPhaseId: row.observed_phase_id } : undefined;
  }

  record(input: { id: string; run: ScenarioRunState; graphRevision: number; fingerprint: string; decision: RunPlannerDecision; at: string }): void {
    this.sqlite.prepare(`
      INSERT INTO scenario_planner_evaluations
        (id, run_id, case_id, input_fingerprint, observed_run_revision, observed_graph_revision,
         observed_phase_id, decision_json, applied, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(input.id, input.run.id, input.run.caseId, input.fingerprint, input.run.revision, input.graphRevision,
      input.run.activePhaseId, JSON.stringify(input.decision), input.at);
  }

  complete(input: { evaluationId: string; runId: string; fingerprint: string; runRevision: number; graphRevision: number; at: string }): void {
    this.sqlite.transaction(() => {
      const update = this.sqlite.prepare(`
        UPDATE scenario_planner_evaluations SET applied = 1, resulting_run_revision = ?, applied_at = ? WHERE id = ?
      `).run(input.runRevision, input.at, input.evaluationId);
      if (update.changes !== 1) throw new Error(`Unknown Planner evaluation ${input.evaluationId}`);
      this.sqlite.prepare(`
        INSERT INTO scenario_planner_cursors (run_id, input_fingerprint, run_revision, graph_revision, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET input_fingerprint = excluded.input_fingerprint,
          run_revision = excluded.run_revision, graph_revision = excluded.graph_revision, updated_at = excluded.updated_at
      `).run(input.runId, input.fingerprint, input.runRevision, input.graphRevision, input.at);
    })();
  }

  list(runId: string): PlannerEvaluationRecord[] {
    const rows = this.sqlite.prepare(`
      SELECT id, run_id, case_id, input_fingerprint, observed_run_revision, observed_graph_revision,
             observed_phase_id, decision_json, applied, resulting_run_revision, created_at, applied_at
      FROM scenario_planner_evaluations WHERE run_id = ? ORDER BY created_at ASC
    `).all(runId) as Array<{
      id: string; run_id: string; case_id: string; input_fingerprint: string; observed_run_revision: number;
      observed_graph_revision: number; observed_phase_id: string; decision_json: string; applied: number;
      resulting_run_revision: number | null; created_at: string; applied_at: string | null;
    }>;
    return rows.map((row) => ({ id: row.id, runId: row.run_id, caseId: row.case_id, inputFingerprint: row.input_fingerprint,
      observedRunRevision: row.observed_run_revision, observedGraphRevision: row.observed_graph_revision,
      observedPhaseId: row.observed_phase_id, decision: parseRunPlannerDecision(JSON.parse(row.decision_json)),
      applied: row.applied === 1, resultingRunRevision: row.resulting_run_revision,
      createdAt: row.created_at, appliedAt: row.applied_at }));
  }
}

export function registerRunPlannerRoutes(app: FastifyInstance, store: SqliteRunPlannerStore): void {
  app.get("/api/scenarios/runs/:runId/planner/evaluations", async (request) => {
    const { runId } = z.object({ runId: z.string().min(1) }).parse(request.params);
    return store.list(runId);
  });
}
