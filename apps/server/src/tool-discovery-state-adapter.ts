import type Database from "better-sqlite3";
import {
  parseExecutionToolDiscoverySnapshot,
  type ExecutionToolDiscoverySnapshot,
  type ExecutionToolDiscoveryStatePort,
} from "@traceforge/worker-runtime";

interface DiscoveryStateRow {
  revision: number;
  state_json: string;
}

/** Durable discovery history. Restored catalogs are audit data and are never executable registrations. */
export class SqliteExecutionToolDiscoveryStateStore implements ExecutionToolDiscoveryStatePort {
  constructor(private readonly sqlite: Database.Database) {}

  async load(source: string): Promise<ExecutionToolDiscoverySnapshot | undefined> {
    const row = this.sqlite.prepare(`
      SELECT revision, state_json FROM tool_discovery_states WHERE source = ?
    `).get(source) as DiscoveryStateRow | undefined;
    if (!row) return undefined;
    let value: unknown;
    try {
      value = JSON.parse(row.state_json);
    } catch (error) {
      throw new Error(`Stored tool discovery state is not valid JSON: ${message(error)}`);
    }
    const snapshot = parseExecutionToolDiscoverySnapshot(value, source);
    if (snapshot.revision !== row.revision) throw new Error("Stored tool discovery revision does not match its envelope");
    return snapshot;
  }

  async save(snapshot: ExecutionToolDiscoverySnapshot): Promise<void> {
    const verified = parseExecutionToolDiscoverySnapshot(snapshot, snapshot.source);
    const result = this.sqlite.prepare(`
      INSERT INTO tool_discovery_states (source, revision, outcome, state_json, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(source) DO UPDATE SET
        revision = excluded.revision,
        outcome = excluded.outcome,
        state_json = excluded.state_json,
        updated_at = excluded.updated_at
      WHERE excluded.revision > tool_discovery_states.revision
    `).run(verified.source, verified.revision, verified.outcome, JSON.stringify(verified), verified.updatedAt);
    if (result.changes > 0) return;
    const current = this.sqlite.prepare("SELECT revision FROM tool_discovery_states WHERE source = ?")
      .get(verified.source) as { revision: number } | undefined;
    if (current?.revision === verified.revision) return;
    throw new Error(`Stale tool discovery revision ${verified.revision} cannot replace ${current?.revision ?? "missing"}`);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown persistence error";
}
