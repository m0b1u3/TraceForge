import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import type Database from "better-sqlite3";
import type { ProcessOperationJournal, ProcessOperationObservation } from "@traceforge/execution-node";
import { canonicalJson } from "@traceforge/orchestration-core";

export interface ProcessOperationJournalLimits {
  maximumActiveRecords: number;
  maximumRecords: number;
  maximumBytes: number;
  maximumRecordBytes: number;
  completedRetentionMs: number;
  compactionBatchSize: number;
}

export const DEFAULT_PROCESS_OPERATION_JOURNAL_LIMITS: Readonly<ProcessOperationJournalLimits> = Object.freeze({
  maximumActiveRecords: 100_000,
  maximumRecords: 1_000_000,
  maximumBytes: 512 * 1024 * 1024,
  maximumRecordBytes: 512 * 1024,
  completedRetentionMs: 24 * 60 * 60 * 1000,
  compactionBatchSize: 64,
});

export interface ProcessOperationJournalUsage {
  records: number;
  activeRecords: number;
  archivedRecords: number;
  uncertainRecords: number;
  reservedBytes: number;
  limits: Readonly<ProcessOperationJournalLimits>;
}

/** Node-local exactly-once ledger for stdin, PTY, signal, termination and adoption effects. */
export class SqliteProcessOperationJournal implements ProcessOperationJournal {
  readonly limits: Readonly<ProcessOperationJournalLimits>;

  constructor(
    private readonly sqlite: Database.Database,
    limits: Partial<ProcessOperationJournalLimits> = {},
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.limits = Object.freeze({ ...DEFAULT_PROCESS_OPERATION_JOURNAL_LIMITS, ...limits });
    for (const value of Object.values(this.limits)) {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid process operation journal limit");
    }
    if (this.limits.maximumActiveRecords < 1 || this.limits.maximumRecords < this.limits.maximumActiveRecords
      || this.limits.maximumBytes < 1 || this.limits.maximumRecordBytes < 1
      || this.limits.maximumRecordBytes > this.limits.maximumBytes || this.limits.compactionBatchSize < 1
      || this.limits.compactionBatchSize > 1_000) throw new Error("Invalid process operation journal limit");
    this.initialize();
    this.compactCompletedHistory();
  }

  claim(observation: ProcessOperationObservation): void {
    validate(observation);
    if (observation.state !== "claimed" || observation.response !== null) throw new Error("Invalid process operation claim");
    const identity = canonicalJson(observation.identity);
    const serialized = canonicalJson(observation);
    this.assertSize(serialized);
    // Reclamation commits independently. A later admission failure must not undo safe compaction.
    this.compactCompletedHistory();
    const usage = this.usage();
    if (usage.records >= this.limits.maximumRecords || usage.activeRecords >= this.limits.maximumActiveRecords
      || usage.reservedBytes + this.limits.maximumRecordBytes > this.limits.maximumBytes) {
      throw new Error("Process operation journal capacity exhausted; new controls are blocked");
    }
    this.sqlite.prepare(`INSERT INTO execution_process_operations
      (operation_id,identity_json,node_id,state,response_json,digest,budget_bytes,updated_at)
      VALUES (?, ?, ?, 'claimed', NULL, ?, ?, ?)`).run(
      observation.identity.operationId, identity, observation.nodeId, digest(serialized), this.limits.maximumRecordBytes, observation.updatedAt,
    );
  }

  complete(observation: ProcessOperationObservation): void {
    validate(observation);
    if (observation.state !== "completed" || observation.response === null) throw new Error("Invalid process operation completion");
    const serialized = canonicalJson(observation);
    const response = canonicalJson(observation.response);
    this.assertSize(serialized);
    this.sqlite.transaction(() => {
      const prior = this.get(observation.identity.operationId);
      if (!prior || prior.state !== "claimed" || canonicalJson(prior.identity) !== canonicalJson(observation.identity)
        || prior.nodeId !== observation.nodeId) throw new Error("Process operation cannot replace its claim");
      const changed = this.sqlite.prepare(`UPDATE execution_process_operations SET state='completed',response_json=?,digest=?,budget_bytes=?,updated_at=?
        WHERE operation_id=? AND state='claimed'`).run(
        response, digest(serialized), Buffer.byteLength(serialized), observation.updatedAt, observation.identity.operationId,
      );
      if (changed.changes !== 1) throw new Error("Process operation completion was not persisted");
    })();
  }

  get(operationId: string): ProcessOperationObservation | undefined {
    if (typeof operationId !== "string" || !operationId.trim() || Buffer.byteLength(operationId) > 256) {
      throw new Error("Process operation identity is invalid");
    }
    const row = this.sqlite.prepare("SELECT * FROM execution_process_operations WHERE operation_id=?").get(operationId) as OperationRow | undefined;
    if (!row) return undefined;
    let response: unknown = null;
    if (row.state === "completed") {
      if (row.response_json !== null && row.archived_response === null) response = parseJson(row.response_json, "response");
      else if (row.response_json === null && row.archived_response !== null) {
        if (!row.response_digest || !Number.isSafeInteger(row.response_original_bytes) || row.response_original_bytes! < 1
          || row.response_original_bytes! > this.limits.maximumRecordBytes || !Number.isSafeInteger(row.response_compressed_bytes)
          || row.response_compressed_bytes !== row.archived_response.length || !Number.isFinite(Date.parse(row.archived_at ?? ""))) {
          throw new Error("Archived process operation response is corrupt");
        }
        let inflated: Buffer;
        try { inflated = gunzipSync(row.archived_response, { maxOutputLength: this.limits.maximumRecordBytes }); }
        catch { throw new Error("Archived process operation response is corrupt"); }
        if (inflated.length !== row.response_original_bytes || digest(inflated) !== row.response_digest) {
          throw new Error("Archived process operation response is corrupt");
        }
        response = parseJson(inflated.toString("utf8"), "archived response");
      } else throw new Error("Completed process operation response is corrupt");
    } else if (row.response_json !== null || row.archived_response !== null || row.response_digest !== null
      || row.response_original_bytes !== null || row.response_compressed_bytes !== null || row.archived_at !== null) {
      throw new Error("Claimed process operation response is corrupt");
    }
    const observation: ProcessOperationObservation = {
      schemaVersion: 1,
      identity: parseJson(row.identity_json, "identity") as ProcessOperationObservation["identity"],
      nodeId: row.node_id,
      state: row.state,
      response: response as ProcessOperationObservation["response"],
      updatedAt: row.updated_at,
    };
    validate(observation);
    if (observation.identity.operationId !== operationId || digest(canonicalJson(observation)) !== row.digest) {
      throw new Error("Process operation observation is corrupt");
    }
    return observation;
  }

  usage(): ProcessOperationJournalUsage {
    const row = this.sqlite.prepare(`SELECT count(*) AS records,
      coalesce(sum(CASE WHEN archived_at IS NULL THEN 1 ELSE 0 END),0) AS activeRecords,
      coalesce(sum(CASE WHEN archived_at IS NOT NULL THEN 1 ELSE 0 END),0) AS archivedRecords,
      coalesce(sum(CASE WHEN state='claimed' THEN 1 ELSE 0 END),0) AS uncertainRecords,
      coalesce(sum(budget_bytes),0) AS reservedBytes FROM execution_process_operations`).get() as Omit<ProcessOperationJournalUsage, "limits">;
    return { ...row, limits: this.limits };
  }

  /**
   * Compresses only confirmed responses after retention. The immutable identity and full replay result remain available;
   * claim-only outcomes are never compacted because absence of a result is not evidence that the effect did not happen.
   */
  compactCompletedHistory(): number {
    return this.sqlite.transaction(() => {
      const now = this.now();
      const parsedNow = Date.parse(now);
      if (!Number.isFinite(parsedNow)) throw new Error("Process operation journal clock is invalid");
      const cutoff = new Date(parsedNow - this.limits.completedRetentionMs).toISOString();
      const rows = this.sqlite.prepare(`SELECT operation_id,response_json,budget_bytes
        FROM execution_process_operations WHERE state='completed' AND response_json IS NOT NULL
        AND archived_at IS NULL AND updated_at<=? ORDER BY updated_at,operation_id LIMIT ?`)
        .all(cutoff, this.limits.compactionBatchSize) as Array<Pick<OperationRow, "operation_id" | "response_json" | "budget_bytes">>;
      let compacted = 0;
      for (const row of rows) {
        // Reconstructing before mutation validates the full original digest and response schema.
        const observation = this.get(row.operation_id);
        if (!observation || observation.state !== "completed" || observation.response === null || row.response_json === null) continue;
        const response = Buffer.from(row.response_json, "utf8");
        const compressed = gzipSync(response, { level: 9 });
        const useCompression = compressed.length + 128 < response.length;
        const changed = useCompression
          ? this.sqlite.prepare(`UPDATE execution_process_operations SET response_json=NULL,archived_response=?,
              response_digest=?,response_original_bytes=?,response_compressed_bytes=?,archived_at=?,budget_bytes=?
              WHERE operation_id=? AND state='completed' AND response_json IS NOT NULL AND archived_at IS NULL`).run(
              compressed, digest(response), response.length, compressed.length, now,
              row.budget_bytes - response.length + compressed.length + 128, row.operation_id)
          : this.sqlite.prepare(`UPDATE execution_process_operations SET archived_at=?
              WHERE operation_id=? AND state='completed' AND response_json IS NOT NULL AND archived_at IS NULL`)
              .run(now, row.operation_id);
        if (changed.changes !== 1) throw new Error("Process operation compaction lost its completion record");
        compacted++;
      }
      return compacted;
    })();
  }

  private initialize(): void {
    this.sqlite.exec(`CREATE TABLE IF NOT EXISTS execution_process_operations (
      operation_id TEXT PRIMARY KEY, identity_json TEXT NOT NULL, node_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('claimed','completed')), response_json TEXT,
      digest TEXT NOT NULL, budget_bytes INTEGER NOT NULL CHECK(budget_bytes>0), updated_at TEXT NOT NULL,
      archived_response BLOB, response_digest TEXT, response_original_bytes INTEGER,
      response_compressed_bytes INTEGER, archived_at TEXT);`);
    const columns = new Set((this.sqlite.prepare("PRAGMA table_info(execution_process_operations)").all() as Array<{ name: string }>).map(row => row.name));
    for (const [name, type] of [
      ["archived_response", "BLOB"], ["response_digest", "TEXT"], ["response_original_bytes", "INTEGER"],
      ["response_compressed_bytes", "INTEGER"], ["archived_at", "TEXT"],
    ] as const) if (!columns.has(name)) this.sqlite.exec(`ALTER TABLE execution_process_operations ADD COLUMN ${name} ${type}`);
    this.sqlite.exec(`DROP TRIGGER IF EXISTS execution_process_operation_identity_immutable;
      DROP TRIGGER IF EXISTS execution_process_operation_capacity;
      CREATE TRIGGER execution_process_operation_identity_immutable BEFORE UPDATE ON execution_process_operations
        WHEN OLD.operation_id!=NEW.operation_id OR OLD.identity_json!=NEW.identity_json OR OLD.node_id!=NEW.node_id
          OR (OLD.state='completed' AND NOT (NEW.state='completed' AND OLD.response_json IS NOT NULL
            AND OLD.archived_response IS NULL AND OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL
            AND NEW.digest=OLD.digest AND NEW.updated_at=OLD.updated_at
            AND ((NEW.response_json=OLD.response_json AND NEW.archived_response IS NULL
                  AND NEW.response_digest IS NULL AND NEW.response_original_bytes IS NULL AND NEW.response_compressed_bytes IS NULL
                  AND NEW.budget_bytes=OLD.budget_bytes)
              OR (NEW.response_json IS NULL AND NEW.archived_response IS NOT NULL AND NEW.response_digest IS NOT NULL
                  AND NEW.response_original_bytes IS NOT NULL AND NEW.response_compressed_bytes IS NOT NULL
                  AND NEW.budget_bytes<=OLD.budget_bytes))))
        BEGIN SELECT RAISE(ABORT,'Process operation identity or completion is immutable'); END;
      CREATE INDEX IF NOT EXISTS execution_process_operation_compaction
        ON execution_process_operations(state,archived_at,updated_at,operation_id);
      CREATE TRIGGER IF NOT EXISTS execution_process_operation_delete BEFORE DELETE ON execution_process_operations
        BEGIN SELECT RAISE(ABORT,'Process operation records cannot be deleted'); END;
      CREATE TRIGGER execution_process_operation_capacity BEFORE INSERT ON execution_process_operations BEGIN
        SELECT CASE WHEN (SELECT count(*) FROM execution_process_operations)>=${this.limits.maximumRecords}
          OR (SELECT count(*) FROM execution_process_operations WHERE archived_at IS NULL)>=${this.limits.maximumActiveRecords}
          OR (SELECT coalesce(sum(budget_bytes),0) FROM execution_process_operations)+NEW.budget_bytes>${this.limits.maximumBytes}
          THEN RAISE(ABORT,'Process operation journal capacity exhausted') END;
        SELECT execution_physical_admit(execution_floor,maximum_database_bytes,maximum_wal_bytes,NEW.budget_bytes,'execution')
          FROM execution_physical_policy WHERE id=1;
      END;`);
  }

  private assertSize(value: string): void {
    if (Buffer.byteLength(value) > this.limits.maximumRecordBytes) throw new Error("Process operation observation exceeds its size limit");
  }
}

interface OperationRow {
  operation_id: string;
  identity_json: string;
  node_id: string;
  state: "claimed" | "completed";
  response_json: string | null;
  digest: string;
  budget_bytes: number;
  updated_at: string;
  archived_response: Buffer | null;
  response_digest: string | null;
  response_original_bytes: number | null;
  response_compressed_bytes: number | null;
  archived_at: string | null;
}

function parseJson(value: string, name: string): unknown {
  try { return JSON.parse(value); }
  catch { throw new Error(`Process operation ${name} is corrupt`); }
}
function digest(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function validate(value: ProcessOperationObservation): void {
  if (value.schemaVersion !== 1 || !value.nodeId.trim() || !Number.isFinite(Date.parse(value.updatedAt))
    || !value.identity.operationId.trim() || Buffer.byteLength(value.identity.operationId) > 256
    || !value.identity.processId.trim() || !/^[a-f0-9]{64}$/.test(value.identity.requestFingerprint)
    || !["process.writeInput", "process.resizeTerminal", "process.signal", "process.terminate", "process.adopt"].includes(value.identity.operation)
    || (value.state === "claimed") !== (value.response === null)) throw new Error("Invalid process operation observation");
}
