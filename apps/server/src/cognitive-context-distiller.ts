import type Database from "better-sqlite3";
import type { CognitiveContextCursorAdvance, CognitiveContextCursorPort } from "@traceforge/cognitive-runtime";

export {
  CognitiveContextDistiller,
  type CognitiveContextBudget,
  type DistilledRunContext,
  type DistilledWorkerContext,
} from "@traceforge/cognitive-runtime";

export class SqliteCognitiveContextCursorStore implements CognitiveContextCursorPort {
  constructor(private readonly sqlite: Database.Database) {}

  cursor(consumer: string, runId: string): string | undefined {
    return (this.sqlite.prepare(`
      SELECT semantic_fingerprint FROM scenario_cognitive_context_cursors
      WHERE consumer = ? AND run_id = ?
    `).get(consumer, runId) as { semantic_fingerprint: string } | undefined)?.semantic_fingerprint;
  }

  advance(input: CognitiveContextCursorAdvance): void {
    this.sqlite.prepare(`
      INSERT INTO scenario_cognitive_context_cursors
        (consumer, run_id, semantic_fingerprint, source_run_revision, source_graph_revision, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(consumer, run_id) DO UPDATE SET
        semantic_fingerprint = excluded.semantic_fingerprint,
        source_run_revision = excluded.source_run_revision,
        source_graph_revision = excluded.source_graph_revision,
        updated_at = excluded.updated_at
    `).run(
      input.consumer,
      input.runId,
      input.semanticFingerprint,
      input.sourceRunRevision,
      input.sourceGraphRevision,
      input.at,
    );
  }
}
