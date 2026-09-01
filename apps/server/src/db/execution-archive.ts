import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import type Database from "better-sqlite3";

export const archiveStores = {
  receipt: { table: "worker_tool_receipts", key: "idempotency_key", fields: ["result_json"] },
  process: { table: "execution_process_journal", key: "idempotency_key", fields: ["observation_json"] },
  command: { table: "tool_recovery_commands", key: "command_id", fields: ["request_json"] },
  evidence: { table: "tool_recovery_evidence", key: "evidence_ref", fields: ["envelope_json"] },
  reconciliation: { table: "tool_invocation_reconciliation_audits", key: "command_id", fields: ["request_fingerprint", "verified_assertion_json"] },
  retry: { table: "scenario_work_retry_audits", key: "command_id", fields: ["fingerprint", "audit_json"] },
  checkpoint: { table: "worker_checkpoints", key: "ref", fields: ["document_json"] },
  managedCleanup: { table: "managed_execution_cleanup_audits", key: "command_id", fields: ["audit_json"] },
  processCleanup: { table: "process_cleanup_commands", key: "command_id", fields: ["proof_json", "audit_json"] },
} as const;
export type ArchiveKind = keyof typeof archiveStores;
type Row = Record<string, string | number | null>;
const maximumPayloadBytes = 16 * 1024 * 1024;
const scopes = new WeakMap<Database.Database, string>();
const hash = (body: string) => createHash("sha256").update(body).digest("hex");

export function registerExecutionArchiveFunctions(sqlite: Database.Database): void {
  sqlite.function("execution_archive_writing", (kind, key) => scopes.get(sqlite) === JSON.stringify([kind, key]) ? 1 : 0);
}

export function initializeExecutionArchive(sqlite: Database.Database): void {
  registerExecutionArchiveFunctions(sqlite);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS execution_archive_policy (id INTEGER PRIMARY KEY CHECK(id=1), maximum_bytes INTEGER NOT NULL CHECK(maximum_bytes>0),
      maximum_records INTEGER NOT NULL CHECK(maximum_records>0));
    INSERT OR IGNORE INTO execution_archive_policy VALUES (1, 1073741824, 200000);
    CREATE TABLE IF NOT EXISTS execution_archive_usage (id INTEGER PRIMARY KEY CHECK(id=1), bytes INTEGER NOT NULL, records INTEGER NOT NULL);
    INSERT OR IGNORE INTO execution_archive_usage VALUES (1, 0, 0);
    CREATE TABLE IF NOT EXISTS execution_archives (
      kind TEXT NOT NULL, entry_key TEXT NOT NULL, digest TEXT NOT NULL, payload BLOB NOT NULL,
      original_bytes INTEGER NOT NULL CHECK(original_bytes BETWEEN 1 AND 16777216), created_at TEXT NOT NULL,
      PRIMARY KEY(kind, entry_key));
    CREATE TABLE IF NOT EXISTS execution_archive_commands (
      command_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, audit_json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS execution_archive_commands_scope ON execution_archive_commands
      (json_extract(audit_json, '$.caseId'), json_extract(audit_json, '$.runId'), command_id);
  `);
  for (const [table, size] of [["execution_archives", "length(NEW.payload) + length(CAST(NEW.entry_key AS BLOB)) + length(NEW.kind) + length(NEW.digest) + length(NEW.created_at)"],
    ["execution_archive_commands", "length(CAST(NEW.command_id AS BLOB)) + length(NEW.fingerprint) + length(CAST(NEW.audit_json AS BLOB))"]]) {
    const duplicate = table === "execution_archives" ? "kind = NEW.kind AND entry_key = NEW.entry_key" : "command_id = NEW.command_id";
    sqlite.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_admit BEFORE INSERT ON ${table} BEGIN
      SELECT CASE WHEN EXISTS (SELECT 1 FROM ${table} WHERE ${duplicate}) THEN RAISE(ABORT, 'Execution archive replacement is forbidden') END;
      SELECT CASE WHEN EXISTS (SELECT 1 FROM execution_archive_usage u JOIN execution_archive_policy p USING(id)
        WHERE u.records + 1 > p.maximum_records OR u.bytes + ${size} > p.maximum_bytes)
        THEN RAISE(ABORT, 'Execution storage capacity exhausted: archive') END;
    END;
    CREATE TRIGGER IF NOT EXISTS ${table}_account AFTER INSERT ON ${table} BEGIN
      UPDATE execution_archive_usage SET records = records + 1, bytes = bytes + ${size} WHERE id = 1;
    END;
    CREATE TRIGGER IF NOT EXISTS ${table}_immutable_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, 'Execution archive is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS ${table}_immutable_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, 'Execution archive is immutable'); END;`);
  }
  // Persisted trigger changes are installed on each connection; only the host's transaction-local scope can authorize them.
  const oldTriggers = { evidence: "immutable_tool_recovery_evidence_update", command: "immutable_tool_recovery_commands_update",
    reconciliation: "immutable_tool_invocation_reconciliation_update", retry: "immutable_work_retry_update", checkpoint: "immutable_worker_checkpoint_update" };
  for (const [kind, trigger] of Object.entries(oldTriggers)) {
    const store = archiveStores[kind as ArchiveKind];
    sqlite.exec(`DROP TRIGGER IF EXISTS ${trigger}; CREATE TRIGGER ${trigger} BEFORE UPDATE ON ${store.table}
      WHEN execution_archive_writing('${kind}', OLD.${store.key}) = 0 BEGIN SELECT RAISE(ABORT, 'Execution history is immutable'); END;`);
  }
  for (const [kind, store] of Object.entries(archiveStores)) {
    // Capacity stores are installed by the composition root, after createDb.
    if (!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(store.table)) continue;
    sqlite.exec(`
    CREATE TRIGGER IF NOT EXISTS execution_archive_${kind}_fenced BEFORE UPDATE ON ${store.table}
      WHEN execution_archive_writing('${kind}', OLD.${store.key}) = 0
        AND EXISTS (SELECT 1 FROM execution_archives WHERE kind = '${kind}' AND entry_key = OLD.${store.key})
      BEGIN SELECT RAISE(ABORT, 'Archived execution identity is immutable'); END;
  `);
  }
}

function projection(kind: ArchiveKind, original: Row, digest: string): Row {
  const row = { ...original }; const marker = `execution-archive:${digest}`;
  for (const field of archiveStores[kind].fields) if (row[field] !== null) row[field] = marker;
  if (kind === "process") { row.budget_bytes = Buffer.byteLength(marker); row.history_purged = 2; }
  return row;
}

/** Read through the permanent source identity. Missing/corrupt cold data never falls back to a fabricated result. */
export function readExecutionRow<T = Row>(sqlite: Database.Database, kind: ArchiveKind, key: string): T | undefined {
  const store = archiveStores[kind];
  const hot = sqlite.prepare(`SELECT * FROM ${store.table} WHERE ${store.key} = ?`).get(key) as Row | undefined;
  const archived = sqlite.prepare("SELECT digest, payload, original_bytes FROM execution_archives WHERE kind = ? AND entry_key = ?")
    .get(kind, key) as { digest: string; payload: Buffer; original_bytes: number } | undefined;
  if (!archived) {
    if (hot && store.fields.some((field) => typeof hot[field] === "string" && hot[field]!.toString().startsWith("execution-archive:"))) {
      throw new Error("Execution archive is missing");
    }
    return hot as T | undefined;
  }
  if (!hot || archived.original_bytes > maximumPayloadBytes || archived.payload.length > maximumPayloadBytes) throw new Error("Invalid execution archive bounds");
  const body = gunzipSync(archived.payload, { maxOutputLength: maximumPayloadBytes }).toString("utf8");
  if (Buffer.byteLength(body) !== archived.original_bytes || hash(body) !== archived.digest) throw new Error("Execution archive integrity mismatch");
  const envelope = JSON.parse(body) as { version: number; kind: string; key: string; row: Row };
  if (envelope.version !== 1 || envelope.kind !== kind || envelope.key !== key || envelope.row?.[store.key] !== key) throw new Error("Execution archive identity mismatch");
  const expected = projection(kind, envelope.row, archived.digest);
  if (Object.keys(hot).length !== Object.keys(expected).length || Object.entries(hot).some(([field, value]) => expected[field] !== value)) {
    throw new Error("Execution archive source projection mismatch");
  }
  return envelope.row as T;
}

/** Only call inside the independently authorized archive control's outer SQLite transaction. */
export function archiveExecutionRow(sqlite: Database.Database, kind: ArchiveKind, key: string, at: string): { originalBytes: number; compressedBytes: number; replayed: boolean } {
  if (!sqlite.inTransaction) throw new Error("Execution archive requires an atomic control transaction");
  const row = readExecutionRow(sqlite, kind, key);
  if (!row) throw new Error("Execution archive source is missing");
  const prior = sqlite.prepare("SELECT original_bytes, length(payload) AS bytes FROM execution_archives WHERE kind = ? AND entry_key = ?")
    .get(kind, key) as { original_bytes: number; bytes: number } | undefined;
  if (prior) return { originalBytes: prior.original_bytes, compressedBytes: prior.bytes, replayed: true };
  const body = JSON.stringify({ version: 1, kind, key, row }); const originalBytes = Buffer.byteLength(body);
  if (originalBytes > maximumPayloadBytes) throw new Error("Execution archive source exceeds its size limit");
  const payload = gzipSync(body); const digest = hash(body);
  if (gunzipSync(payload, { maxOutputLength: maximumPayloadBytes }).toString("utf8") !== body) throw new Error("Execution archive roundtrip failed");
  sqlite.prepare("INSERT INTO execution_archives VALUES (?, ?, ?, ?, ?, ?)").run(kind, key, digest, payload, originalBytes, at);
  const store = archiveStores[kind]; const projected = projection(kind, row, digest);
  const fields = [...store.fields, ...(kind === "process" ? ["budget_bytes", "history_purged"] : [])];
  scopes.set(sqlite, JSON.stringify([kind, key]));
  try {
    sqlite.prepare(`UPDATE ${store.table} SET ${fields.map((field) => `${field} = ?`).join(", ")} WHERE ${store.key} = ?`)
      .run(...fields.map((field) => projected[field]), key);
  } finally { scopes.delete(sqlite); }
  readExecutionRow(sqlite, kind, key);
  return { originalBytes, compressedBytes: payload.length, replayed: false };
}
