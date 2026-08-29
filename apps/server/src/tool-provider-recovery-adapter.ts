import type Database from "better-sqlite3";
import {
  parseToolProviderRecoverySnapshot,
  type ToolProviderRecoveryIdentity,
  type ToolProviderRecoverySnapshot,
  type ToolProviderRecoveryStatePort,
} from "@traceforge/worker-runtime";

interface RecoveryStateRow {
  revision: number;
  snapshot_json: string;
}

/** Durable recovery state with strict parsing and monotonic revision writes. */
export class SqliteToolProviderRecoveryStateStore implements ToolProviderRecoveryStatePort {
  constructor(private readonly sqlite: Database.Database) {}

  async load(identity: ToolProviderRecoveryIdentity): Promise<ToolProviderRecoverySnapshot | undefined> {
    const row = this.sqlite.prepare(`
      SELECT revision, snapshot_json
      FROM tool_provider_recovery_states
      WHERE provider_id = ? AND version = ?
    `).get(identity.providerId, identity.version) as RecoveryStateRow | undefined;
    if (!row) return undefined;
    let value: unknown;
    try {
      value = JSON.parse(row.snapshot_json);
    } catch (error) {
      throw new Error(`Stored Tool Provider recovery state is not valid JSON: ${message(error)}`);
    }
    const snapshot = parseToolProviderRecoverySnapshot(value, identity);
    if (snapshot.revision !== row.revision) throw new Error("Stored Tool Provider recovery revision does not match its envelope");
    return snapshot;
  }

  async save(snapshot: ToolProviderRecoverySnapshot): Promise<void> {
    const verified = parseToolProviderRecoverySnapshot(snapshot, snapshot.identity);
    const result = this.sqlite.prepare(`
      INSERT INTO tool_provider_recovery_states
        (provider_id, version, revision, status, snapshot_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider_id, version) DO UPDATE SET
        revision = excluded.revision,
        status = excluded.status,
        snapshot_json = excluded.snapshot_json,
        updated_at = excluded.updated_at
      WHERE excluded.revision > tool_provider_recovery_states.revision
    `).run(
      verified.identity.providerId,
      verified.identity.version,
      verified.revision,
      verified.status,
      JSON.stringify(verified),
      verified.updatedAt,
    );
    if (result.changes > 0) return;
    const current = this.sqlite.prepare(`
      SELECT revision FROM tool_provider_recovery_states WHERE provider_id = ? AND version = ?
    `).get(verified.identity.providerId, verified.identity.version) as { revision: number } | undefined;
    if (current?.revision === verified.revision) return;
    throw new Error(`Stale Tool Provider recovery revision ${verified.revision} cannot replace ${current?.revision ?? "missing"}`);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown persistence error";
}
