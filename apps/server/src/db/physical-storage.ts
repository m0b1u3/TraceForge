import { lstatSync, statfsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type Database from "better-sqlite3";

export interface PhysicalSample { databaseBytes: number; walBytes: number; shmBytes: number; availableBytes: number }
export type PhysicalStorageProbe = () => PhysicalSample;
const probes = new WeakMap<Database.Database, PhysicalStorageProbe>();
const MiB = 1024 * 1024;
function fileBytes(path: string, optional = false): number {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe database storage file");
    return stat.size;
  } catch (error) { if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return 0; throw error; }
}
function nativeProbe(sqlite: Database.Database): PhysicalStorageProbe {
  const path = resolve(sqlite.name);
  return () => {
    const fs = statfsSync(dirname(path), { bigint: true });
    const free = fs.bavail * fs.bsize;
    return { databaseBytes: fileBytes(path), walBytes: fileBytes(`${path}-wal`, true), shmBytes: fileBytes(`${path}-shm`, true),
      availableBytes: Number(free > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : free) };
  };
}
function sample(sqlite: Database.Database): PhysicalSample {
  const value = probes.get(sqlite)!();
  if (![value.databaseBytes, value.walBytes, value.shmBytes, value.availableBytes].every((n) => Number.isSafeInteger(n) && n >= 0)) {
    throw new Error("Invalid physical storage observation");
  }
  return value;
}

/** Trusted host injection supports deterministic disk-pressure tests; no HTTP policy/probe override exists. */
export function registerPhysicalStorageFunctions(sqlite: Database.Database, probe?: PhysicalStorageProbe): void {
  if (probe || !probes.has(sqlite)) probes.set(sqlite, probe ?? nativeProbe(sqlite));
  sqlite.function("execution_physical_admit", (floor, maximum, walMaximum, pending, mode) => {
    if (sqlite.memory && !probe) return 1;
    let observed: PhysicalSample;
    try { observed = sample(sqlite); }
    catch { throw Object.assign(new Error("Execution physical storage observation unavailable"), { code: "SQLITE_IOERR" }); }
    if (observed.availableBytes < Number(floor) + Number(pending) * 2
      || observed.databaseBytes + observed.walBytes > Number(maximum)
      || (mode === "execution" && observed.walBytes > Number(walMaximum))) {
      throw new Error("Execution storage capacity exhausted: physical storage pressure");
    }
    return 1;
  });
}

export function initializePhysicalStorage(sqlite: Database.Database): void {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS execution_physical_policy (
    id INTEGER PRIMARY KEY CHECK(id=1), execution_floor INTEGER NOT NULL CHECK(execution_floor>=0),
    recovery_floor INTEGER NOT NULL CHECK(recovery_floor>=0 AND recovery_floor<=execution_floor),
    maximum_database_bytes INTEGER NOT NULL CHECK(maximum_database_bytes>0), maximum_wal_bytes INTEGER NOT NULL CHECK(maximum_wal_bytes>0));
    INSERT OR IGNORE INTO execution_physical_policy VALUES (1, 268435456, 33554432, 8589934592, 268435456);
    CREATE INDEX IF NOT EXISTS execution_storage_reserved ON execution_storage_entries(state, kind);
  `);
  const admission = (mode: string, bytes: string) => `SELECT execution_physical_admit(
    ${mode === "execution" ? "execution_floor" : "recovery_floor"}, maximum_database_bytes, maximum_wal_bytes,
    ${mode === "execution" ? `(SELECT coalesce(sum(bytes),0) FROM execution_storage_entries WHERE state='reserved') + ${bytes}` : bytes},
    '${mode}') FROM execution_physical_policy WHERE id=1;`;
  sqlite.exec(`CREATE TRIGGER IF NOT EXISTS execution_physical_reserve BEFORE INSERT ON execution_storage_entries
    WHEN NEW.state='reserved' AND NOT EXISTS(SELECT 1 FROM execution_storage_entries WHERE kind=NEW.kind AND entry_key=NEW.entry_key)
    BEGIN ${admission("execution", "NEW.bytes")} END;`);
  for (const [table, key, mode, bytes] of [
    ["worker_checkpoints", "ref", "execution", "length(CAST(NEW.document_json AS BLOB))"],
    ["execution_process_journal", "idempotency_key", "execution", "NEW.budget_bytes"],
    ["tool_recovery_commands", "command_id", "recovery", "length(CAST(NEW.request_json AS BLOB))"],
    ["tool_recovery_evidence", "evidence_ref", "recovery", "length(CAST(NEW.envelope_json AS BLOB))"],
    ["tool_invocation_reconciliation_audits", "command_id", "recovery", String(64 * 1024)],
    ["scenario_work_retry_audits", "command_id", "recovery", String(64 * 1024)],
    ["execution_archives", "entry_key", "recovery", "length(NEW.payload)"],
    ["execution_archive_commands", "command_id", "recovery", "length(CAST(NEW.audit_json AS BLOB))"],
  ]) {
    const duplicate = table === "execution_archives" ? "AND kind=NEW.kind" : "";
    sqlite.exec(`CREATE TRIGGER IF NOT EXISTS execution_physical_${table} BEFORE INSERT ON ${table}
      WHEN NOT EXISTS(SELECT 1 FROM ${table} WHERE ${key}=NEW.${key} ${duplicate}) BEGIN ${admission(mode!, bytes!)} END;`);
  }
  // A reserved result must remain writable under admission pressure. This is best effort, not preallocated disk space.
  sqlite.exec(`CREATE TRIGGER IF NOT EXISTS execution_physical_unreserved_receipt BEFORE INSERT ON worker_tool_receipts
    WHEN NOT EXISTS(SELECT 1 FROM execution_storage_entries WHERE kind='receipt' AND entry_key=NEW.idempotency_key)
    BEGIN ${admission("recovery", "length(CAST(NEW.result_json AS BLOB))")} END;`);
}

export function physicalStorageStatus(sqlite: Database.Database) {
  const policy = sqlite.prepare(`SELECT execution_floor AS executionFloorBytes, recovery_floor AS recoveryFloorBytes,
    maximum_database_bytes AS maximumDatabaseBytes, maximum_wal_bytes AS maximumWalBytes FROM execution_physical_policy WHERE id=1`).get() as {
    executionFloorBytes: number; recoveryFloorBytes: number; maximumDatabaseBytes: number; maximumWalBytes: number };
  if (sqlite.memory) return { mode: "memory" as const, observation: null, policy, admission: "unmetered" as const };
  try {
    const observation = sample(sqlite);
    const pageSize = Number(sqlite.pragma("page_size", { simple: true }));
    const pages = Number(sqlite.pragma("page_count", { simple: true }));
    const freePages = Number(sqlite.pragma("freelist_count", { simple: true }));
    const pending = (sqlite.prepare("SELECT coalesce(sum(bytes),0) AS bytes FROM execution_storage_entries WHERE state='reserved'").get() as { bytes: number }).bytes;
    const reason = observation.availableBytes < policy.executionFloorBytes + pending * 2 ? "free_space"
      : observation.databaseBytes + observation.walBytes > policy.maximumDatabaseBytes ? "database_size"
      : observation.walBytes > policy.maximumWalBytes ? "wal_pressure" : null;
    return { mode: "disk" as const, observation: { ...observation, pageSize, pages, reusableBytes: freePages * pageSize, pendingBytes: pending },
      policy, admission: reason ? "blocked" as const : "available" as const, reason };
  } catch { return { mode: "disk" as const, observation: null, policy, admission: "blocked" as const, reason: "observation_unavailable" }; }
}

export const physicalStorageDefaults = { executionFloorBytes: 256 * MiB, recoveryFloorBytes: 32 * MiB };
