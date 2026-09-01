import type Database from "better-sqlite3";
import { initializeExecutionArchive } from "./execution-archive.js";

const MiB = 1024 * 1024;
const stores = [
  { kind: "receipt", table: "worker_tool_receipts", key: "idempotency_key", fields: ["idempotency_key", "result_json", "created_at"], pool: "execution", records: 100_000, bytes: 512 * MiB, entry: 8 * MiB },
  { kind: "process", table: "execution_process_journal", key: "idempotency_key", fields: [], pool: "execution", records: 10_000, bytes: 512 * MiB, entry: 8 * MiB },
  { kind: "command", table: "tool_recovery_commands", key: "command_id", fields: ["command_id", "fingerprint", "idempotency_key", "request_json", "created_at"], pool: "recovery", records: 50_000, bytes: 128 * MiB, entry: 513 * 1024 },
  { kind: "evidence", table: "tool_recovery_evidence", key: "evidence_ref", fields: ["evidence_ref", "envelope_json", "created_at"], pool: "recovery", records: 50_000, bytes: 128 * MiB, entry: 65 * 1024 },
  { kind: "reconciliation", table: "tool_invocation_reconciliation_audits", key: "command_id", fields: ["command_id", "request_fingerprint", "idempotency_key", "actor", "requested_resolution", "requested_reason", "evidence_fingerprint", "verified_assertion_json", "authorization_decision", "authorization_reason", "outcome", "failure_reason", "created_at"], pool: "recovery", records: 50_000, bytes: 128 * MiB, entry: 64 * 1024 },
  { kind: "retry", table: "scenario_work_retry_audits", key: "command_id", fields: ["command_id", "fingerprint", "audit_json"], pool: "recovery", records: 50_000, bytes: 128 * MiB, entry: 64 * 1024 },
  { kind: "checkpoint", table: "worker_checkpoints", key: "ref", fields: ["ref", "case_id", "run_id", "work_id", "document_json", "created_at"], pool: "checkpoint", records: 100_000, bytes: 512 * MiB, entry: 1025 * 1024 },
] as const;

export type ExecutionStorageKind = typeof stores[number]["kind"];

function sizeExpression(store: typeof stores[number], prefix: string): string {
  return store.kind === "process" ? `${prefix}budget_bytes`
    : store.fields.map((field) => `coalesce(length(CAST(${prefix}${field} AS BLOB)), 0)`).join(" + ");
}

/** Installed by createDb, before any Worker/control is admitted. SQL triggers cover every writer. */
export function initializeExecutionStorage(sqlite: Database.Database): void {
  sqlite.transaction(() => {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS worker_checkpoints (ref TEXT PRIMARY KEY, case_id TEXT NOT NULL, run_id TEXT NOT NULL,
        work_id TEXT NOT NULL, document_json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS worker_checkpoints_run ON worker_checkpoints(run_id, ref);
      CREATE TABLE IF NOT EXISTS execution_storage_pools (id TEXT PRIMARY KEY, maximum_bytes INTEGER NOT NULL CHECK(maximum_bytes > 0));
      CREATE TABLE IF NOT EXISTS execution_storage_policies (
        kind TEXT PRIMARY KEY, pool TEXT NOT NULL REFERENCES execution_storage_pools(id),
        maximum_records INTEGER NOT NULL CHECK(maximum_records > 0), maximum_bytes INTEGER NOT NULL CHECK(maximum_bytes > 0),
        maximum_entry_bytes INTEGER NOT NULL CHECK(maximum_entry_bytes > 0));
      CREATE TABLE IF NOT EXISTS execution_storage_entries (
        kind TEXT NOT NULL REFERENCES execution_storage_policies(kind), entry_key TEXT NOT NULL,
        bytes INTEGER NOT NULL CHECK(bytes >= 0), state TEXT NOT NULL CHECK(state IN ('reserved', 'stored', 'released')),
        PRIMARY KEY(kind, entry_key));
      CREATE TABLE IF NOT EXISTS execution_storage_usage (
        kind TEXT PRIMARY KEY REFERENCES execution_storage_policies(kind), records INTEGER NOT NULL, bytes INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS execution_storage_migrations (version INTEGER PRIMARY KEY);
      INSERT OR IGNORE INTO execution_storage_pools VALUES ('execution', 1073741824), ('recovery', 536870912);
      INSERT OR IGNORE INTO execution_storage_pools VALUES ('checkpoint', 536870912);
    `);
    for (const store of stores) {
      sqlite.prepare("INSERT OR IGNORE INTO execution_storage_policies VALUES (?, ?, ?, ?, ?)")
        .run(store.kind, store.pool, store.records, store.bytes, store.entry);
      sqlite.prepare("INSERT OR IGNORE INTO execution_storage_usage VALUES (?, 0, 0)").run(store.kind);
    }
    initializeExecutionArchive(sqlite);
    if (!sqlite.prepare("SELECT 1 FROM execution_storage_migrations WHERE version = 1").get()) {
      // Existing oversized records are preserved, not discarded to satisfy new limits.
      for (const store of stores) sqlite.exec(`INSERT INTO execution_storage_entries (kind, entry_key, bytes, state)
        SELECT '${store.kind}', ${store.key}, ${sizeExpression(store, "")}, 'stored' FROM ${store.table}`);
      sqlite.exec(`INSERT OR IGNORE INTO execution_storage_entries (kind, entry_key, bytes, state)
        SELECT 'receipt', b.idempotency_key, p.maximum_entry_bytes, 'reserved'
        FROM tool_invocation_bindings b LEFT JOIN tool_invocation_executions e USING (idempotency_key)
        JOIN execution_storage_policies p ON p.kind = 'receipt'
        WHERE e.status IN ('executing', 'uncertain', 'completed') OR e.idempotency_key IS NULL;
        UPDATE execution_storage_entries SET bytes = 0, state = 'released'
          WHERE kind = 'receipt' AND state = 'reserved' AND EXISTS (
            SELECT 1 FROM tool_invocation_reconciliation_audits a
            JOIN tool_invocation_executions e USING(idempotency_key) JOIN tool_invocation_bindings b USING(idempotency_key)
            WHERE a.idempotency_key = execution_storage_entries.entry_key AND a.outcome = 'resolved'
              AND a.requested_resolution = 'confirmed_no_effect' AND e.status = 'completed' AND b.status = 'released');
        UPDATE execution_storage_usage SET
          records = (SELECT count(*) FROM execution_storage_entries e WHERE e.kind = execution_storage_usage.kind),
          bytes = (SELECT coalesce(sum(bytes), 0) FROM execution_storage_entries e WHERE e.kind = execution_storage_usage.kind);
        INSERT INTO execution_storage_migrations VALUES (1);`);
    }
    sqlite.exec(`
      CREATE TRIGGER IF NOT EXISTS execution_storage_entry_admit BEFORE INSERT ON execution_storage_entries BEGIN
        SELECT CASE WHEN length(CAST(NEW.entry_key AS BLOB)) NOT BETWEEN 1 AND 1024
          THEN RAISE(ABORT, 'Execution storage key exceeds its size limit') END;
        SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM execution_storage_entries WHERE kind = NEW.kind AND entry_key = NEW.entry_key)
          AND EXISTS (SELECT 1 FROM execution_storage_policies p JOIN execution_storage_usage u USING(kind)
            JOIN execution_storage_pools pool ON pool.id = p.pool WHERE p.kind = NEW.kind AND (
              NEW.bytes > p.maximum_entry_bytes OR u.records + 1 > p.maximum_records OR u.bytes + NEW.bytes > p.maximum_bytes
              OR (SELECT coalesce(sum(other.bytes), 0) FROM execution_storage_usage other
                JOIN execution_storage_policies op USING(kind) WHERE op.pool = p.pool) + NEW.bytes > pool.maximum_bytes))
          THEN RAISE(ABORT, 'Execution storage capacity exhausted') END;
      END;
      CREATE TRIGGER IF NOT EXISTS execution_storage_entry_resize BEFORE UPDATE ON execution_storage_entries BEGIN
        SELECT CASE WHEN NEW.kind != OLD.kind OR NEW.entry_key != OLD.entry_key
          OR (OLD.state = 'released' AND NEW.state != 'released') THEN RAISE(ABORT, 'Execution storage identity is fenced') END;
        SELECT CASE WHEN NEW.bytes > OLD.bytes AND EXISTS (
          SELECT 1 FROM execution_storage_policies p JOIN execution_storage_usage u USING(kind)
          JOIN execution_storage_pools pool ON pool.id = p.pool WHERE p.kind = NEW.kind AND (
            NEW.bytes > p.maximum_entry_bytes OR u.bytes + NEW.bytes - OLD.bytes > p.maximum_bytes
            OR (SELECT coalesce(sum(other.bytes), 0) FROM execution_storage_usage other
              JOIN execution_storage_policies op USING(kind) WHERE op.pool = p.pool) + NEW.bytes - OLD.bytes > pool.maximum_bytes))
          THEN RAISE(ABORT, 'Execution storage capacity exhausted') END;
      END;
      CREATE TRIGGER IF NOT EXISTS execution_storage_entry_added AFTER INSERT ON execution_storage_entries BEGIN
        UPDATE execution_storage_usage SET records = records + 1, bytes = bytes + NEW.bytes WHERE kind = NEW.kind;
      END;
      CREATE TRIGGER IF NOT EXISTS execution_storage_entry_resized AFTER UPDATE ON execution_storage_entries BEGIN
        UPDATE execution_storage_usage SET bytes = bytes + NEW.bytes - OLD.bytes WHERE kind = NEW.kind;
      END;
      CREATE TRIGGER IF NOT EXISTS execution_storage_entry_deleted BEFORE DELETE ON execution_storage_entries BEGIN
        SELECT RAISE(ABORT, 'Execution storage deduplication keys cannot be deleted');
      END;
    `);
    for (const store of stores) sqlite.exec(`
      CREATE TRIGGER IF NOT EXISTS execution_storage_${store.kind}_insert AFTER INSERT ON ${store.table} BEGIN
        SELECT CASE WHEN EXISTS (SELECT 1 FROM execution_storage_entries
          WHERE kind = '${store.kind}' AND entry_key = NEW.${store.key} AND state = 'stored')
          THEN RAISE(ABORT, 'Execution storage history is immutable; replacement is forbidden') END;
        INSERT INTO execution_storage_entries (kind, entry_key, bytes, state)
          VALUES ('${store.kind}', NEW.${store.key}, ${sizeExpression(store, "NEW.")}, 'stored')
          ON CONFLICT(kind, entry_key) DO UPDATE SET bytes = excluded.bytes, state = 'stored';
      END;
      CREATE TRIGGER IF NOT EXISTS execution_storage_${store.kind}_update AFTER UPDATE ON ${store.table} BEGIN
        SELECT CASE WHEN NEW.${store.key} != OLD.${store.key} THEN RAISE(ABORT, 'Execution storage identity is immutable') END;
        UPDATE execution_storage_entries SET bytes = ${sizeExpression(store, "NEW.")}
          WHERE kind = '${store.kind}' AND entry_key = NEW.${store.key};
      END;
      CREATE TRIGGER IF NOT EXISTS execution_storage_${store.kind}_delete BEFORE DELETE ON ${store.table} BEGIN
        SELECT RAISE(ABORT, 'Execution storage history is immutable; a controlled archive is required');
      END;
    `);
  })();
}

export function reserveToolReceipt(sqlite: Database.Database, idempotencyKey: string): void {
  const existing = sqlite.prepare("SELECT state FROM execution_storage_entries WHERE kind = 'receipt' AND entry_key = ?")
    .get(idempotencyKey) as { state: string } | undefined;
  if (existing?.state === "reserved") return;
  if (existing) throw new Error("Tool receipt storage key is already settled");
  sqlite.prepare(`INSERT INTO execution_storage_entries (kind, entry_key, bytes, state)
    SELECT 'receipt', ?, maximum_entry_bytes, 'reserved' FROM execution_storage_policies WHERE kind = 'receipt'`).run(idempotencyKey);
}

/** Invoke only inside the same transaction that committed independently verified no-effect evidence. */
export function settleNoEffectReceiptReservation(sqlite: Database.Database, idempotencyKey: string): void {
  const proof = sqlite.prepare(`SELECT 1 FROM tool_invocation_reconciliation_audits a
    JOIN tool_invocation_executions e USING(idempotency_key) JOIN tool_invocation_bindings b USING(idempotency_key)
    WHERE a.idempotency_key = ? AND a.outcome = 'resolved' AND a.requested_resolution = 'confirmed_no_effect'
      AND e.status = 'completed' AND b.status = 'released'
      AND NOT EXISTS (SELECT 1 FROM worker_tool_receipts r WHERE r.idempotency_key = a.idempotency_key)`).get(idempotencyKey);
  if (!proof) throw new Error("Receipt reservation requires committed no-effect reconciliation");
  sqlite.prepare(`INSERT INTO execution_storage_entries (kind, entry_key, bytes, state) VALUES ('receipt', ?, 0, 'released')
    ON CONFLICT(kind, entry_key) DO UPDATE SET bytes = 0, state = 'released'`).run(idempotencyKey);
}

export function executionStorageStatus(sqlite: Database.Database) {
  return {
    archive: sqlite.prepare(`SELECT u.records, u.bytes, p.maximum_records AS maximumRecords, p.maximum_bytes AS maximumBytes
      FROM execution_archive_usage u JOIN execution_archive_policy p USING(id)`).get(),
    stores: sqlite.prepare(`SELECT p.kind, p.pool, p.maximum_records AS maximumRecords, p.maximum_bytes AS maximumBytes,
      p.maximum_entry_bytes AS maximumEntryBytes, u.records, u.bytes,
      (SELECT count(*) FROM execution_storage_entries e WHERE e.kind = p.kind AND e.state = 'reserved') AS reservations
      FROM execution_storage_policies p JOIN execution_storage_usage u USING(kind) ORDER BY p.kind`).all(),
    pools: sqlite.prepare(`SELECT pool.id, pool.maximum_bytes AS maximumBytes, coalesce(sum(u.bytes), 0) AS bytes
      FROM execution_storage_pools pool JOIN execution_storage_policies p ON p.pool = pool.id
      JOIN execution_storage_usage u USING(kind) GROUP BY pool.id ORDER BY pool.id`).all(),
  };
}

export function isExecutionStorageCapacityError(error: unknown): boolean {
  return error instanceof Error && (error.message.includes("Execution storage capacity exhausted")
    || ("code" in error && error.code === "SQLITE_FULL"));
}

export class ExecutionStorageWriteError extends Error {
  constructor(readonly cause: unknown) { super("Execution recovery storage write failed"); this.name = "ExecutionStorageWriteError"; }
}

export function isExecutionStorageWriteError(error: unknown): boolean {
  if (error instanceof ExecutionStorageWriteError) return true;
  return error instanceof Error && "code" in error && typeof error.code === "string"
    && /^(SQLITE_IOERR|SQLITE_BUSY|SQLITE_LOCKED|SQLITE_READONLY)(_|$)/.test(error.code);
}
