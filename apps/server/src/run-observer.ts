import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parseRunObserverDecision, type RunObserverDecision, type RunObserverStorePort } from "@traceforge/cognitive-runtime";

interface EvaluationRow { id: string; decision_json: string; applied: number; resulting_run_revision: number | null }

export interface ObserverEvaluationRecord {
  id: string; runId: string; caseId: string; observedRunRevision: number; observedGraphRevision: number;
  decision: RunObserverDecision; applied: boolean; resultingRunRevision: number | null; createdAt: string; appliedAt: string | null;
}

/** SQLite persistence adapter; observation policy and supervision live in cognitive-runtime. */
export class SqliteRunObserverStore implements RunObserverStorePort {
  constructor(private readonly sqlite: Database.Database) {
    sqlite.exec(`CREATE TABLE IF NOT EXISTS scenario_observer_context_evaluations (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, case_id TEXT NOT NULL, observed_run_revision INTEGER NOT NULL,
      observed_graph_revision INTEGER NOT NULL, context_fingerprint TEXT NOT NULL, decision_json TEXT NOT NULL,
      applied INTEGER NOT NULL DEFAULT 0, resulting_run_revision INTEGER, created_at TEXT NOT NULL, applied_at TEXT,
      UNIQUE(run_id,observed_run_revision,observed_graph_revision,context_fingerprint));
      CREATE TRIGGER IF NOT EXISTS observer_context_bounded BEFORE INSERT ON scenario_observer_context_evaluations BEGIN
        SELECT CASE WHEN (SELECT count(*) FROM scenario_observer_context_evaluations)>=4096 OR length(CAST(NEW.decision_json AS BLOB))>65536
          THEN RAISE(ABORT,'Observer context evaluation budget exceeded') END;
        SELECT execution_physical_admit(execution_floor, maximum_database_bytes, maximum_wal_bytes,
          length(CAST(NEW.decision_json AS BLOB))+2048,'execution') FROM execution_physical_policy WHERE id=1;
      END;`);
  }

  cursor(runId: string): { runRevision: number; graphRevision: number } | undefined {
    const row = this.sqlite.prepare("SELECT run_revision, graph_revision FROM scenario_observer_cursors WHERE run_id = ?")
      .get(runId) as { run_revision: number; graph_revision: number } | undefined;
    return row ? { runRevision: row.run_revision, graphRevision: row.graph_revision } : undefined;
  }

  find(runId: string, runRevision: number, graphRevision: number, contextFingerprint?: string) {
    const row = this.sqlite.prepare(`
      SELECT id, decision_json, applied, resulting_run_revision FROM ${contextFingerprint ? "scenario_observer_context_evaluations" : "scenario_observer_evaluations"}
      WHERE run_id = ? AND observed_run_revision = ? AND observed_graph_revision = ? ${contextFingerprint ? "AND context_fingerprint=?" : ""}
    `).get(...[runId, runRevision, graphRevision, ...(contextFingerprint ? [contextFingerprint] : [])]) as EvaluationRow | undefined;
    return row ? { id: row.id, decision: parseRunObserverDecision(JSON.parse(row.decision_json)), applied: row.applied === 1,
      resultingRunRevision: row.resulting_run_revision } : undefined;
  }

  record(input: { id: string; runId: string; caseId: string; runRevision: number; graphRevision: number;
    decision: RunObserverDecision; at: string; contextFingerprint?: string }): void {
    this.sqlite.prepare(`
      INSERT INTO ${input.contextFingerprint ? "scenario_observer_context_evaluations" : "scenario_observer_evaluations"}
        (id, run_id, case_id, observed_run_revision, observed_graph_revision, decision_json, applied, created_at${input.contextFingerprint ? ",context_fingerprint" : ""})
      VALUES (?, ?, ?, ?, ?, ?, 0, ?${input.contextFingerprint ? ",?" : ""})
    `).run(...[input.id, input.runId, input.caseId, input.runRevision, input.graphRevision, JSON.stringify(input.decision), input.at,
      ...(input.contextFingerprint ? [input.contextFingerprint] : [])]);
  }

  complete(evaluationId: string, runId: string, runRevision: number, graphRevision: number, at: string): void {
    this.sqlite.transaction(() => {
      let updated = this.sqlite.prepare(`
        UPDATE scenario_observer_evaluations SET applied = 1, resulting_run_revision = ?, applied_at = ? WHERE id = ?
      `).run(runRevision, at, evaluationId);
      if (!updated.changes) updated = this.sqlite.prepare(
        "UPDATE scenario_observer_context_evaluations SET applied=1,resulting_run_revision=?,applied_at=? WHERE id=?",
      ).run(runRevision, at, evaluationId);
      if (updated.changes !== 1) throw new Error(`Unknown Observer evaluation ${evaluationId}`);
      this.sqlite.prepare(`
        INSERT INTO scenario_observer_cursors (run_id, run_revision, graph_revision, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET run_revision = excluded.run_revision,
          graph_revision = excluded.graph_revision, updated_at = excluded.updated_at
      `).run(runId, runRevision, graphRevision, at);
    })();
  }

  list(runId: string): ObserverEvaluationRecord[] {
    const rows = this.sqlite.prepare(`
      SELECT id, run_id, case_id, observed_run_revision, observed_graph_revision, decision_json,
             applied, resulting_run_revision, created_at, applied_at FROM scenario_observer_evaluations WHERE run_id = ?
      UNION ALL SELECT id, run_id, case_id, observed_run_revision, observed_graph_revision, decision_json,
        applied, resulting_run_revision, created_at, applied_at FROM scenario_observer_context_evaluations WHERE run_id=? ORDER BY created_at ASC
    `).all(runId, runId) as Array<{
      id: string; run_id: string; case_id: string; observed_run_revision: number; observed_graph_revision: number;
      decision_json: string; applied: number; resulting_run_revision: number | null; created_at: string; applied_at: string | null;
    }>;
    return rows.map((row) => ({ id: row.id, runId: row.run_id, caseId: row.case_id,
      observedRunRevision: row.observed_run_revision, observedGraphRevision: row.observed_graph_revision,
      decision: parseRunObserverDecision(JSON.parse(row.decision_json)), applied: row.applied === 1,
      resultingRunRevision: row.resulting_run_revision, createdAt: row.created_at, appliedAt: row.applied_at }));
  }
}

export function registerRunObserverRoutes(app: FastifyInstance, store: SqliteRunObserverStore): void {
  app.get("/api/scenarios/runs/:runId/observer/evaluations", async (request) => {
    const { runId } = z.object({ runId: z.string().min(1) }).parse(request.params);
    return store.list(runId);
  });
}
