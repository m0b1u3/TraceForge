import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { ProcessExecutionJournal, ProcessExecutionObservation } from "@traceforge/execution-node";
import { canonicalJson } from "@traceforge/orchestration-core";
import { validateToolProviderResult } from "@traceforge/worker-runtime";

export interface ProcessJournalLimits {
  maximumRecords: number;
  maximumBytes: number;
  maximumObservationBytes: number;
  completedHistoryRetentionMs: number;
}

export const DEFAULT_PROCESS_JOURNAL_LIMITS: Readonly<ProcessJournalLimits> = {
  maximumRecords: 10_000, maximumBytes: 512 * 1024 * 1024,
  maximumObservationBytes: 8 * 1024 * 1024, completedHistoryRetentionMs: 24 * 60 * 60 * 1000,
};

/** Durable observations, not cleanup attestations. Unknown records remain fenced after host restart. */
export class SqliteProcessExecutionJournal implements ProcessExecutionJournal {
  readonly limits: Readonly<ProcessJournalLimits>;
  constructor(
    private readonly sqlite: Database.Database, limits: Partial<ProcessJournalLimits> = {},
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.limits = Object.freeze({ ...DEFAULT_PROCESS_JOURNAL_LIMITS, ...limits });
    for (const [name, value] of Object.entries(this.limits)) {
      if (!Number.isSafeInteger(value) || value < (name === "completedHistoryRetentionMs" ? 0 : 1)) throw new Error("Invalid process journal limit");
    }
    if (this.limits.maximumObservationBytes > this.limits.maximumBytes) throw new Error("Observation reservation exceeds journal capacity");
  }

  claim(observation: ProcessExecutionObservation): void {
    if (observation.status !== "claimed" || observation.process !== null || observation.events.length || observation.historyRetention) throw new Error("Invalid execution claim");
    validate(observation);
    const json = JSON.stringify(observation);
    this.assertSize(json);
    // Maintenance commits independently: admission refusal must not undo safe reclamation.
    this.compactCompletedHistory();
    this.sqlite.transaction(() => {
      if (this.get(observation.identity.idempotencyKey)) throw new Error("Process execution key already claimed; reconciliation required");
      const usage = this.usage();
      if (usage.records >= this.limits.maximumRecords
        || usage.reservedBytes + this.limits.maximumObservationBytes > this.limits.maximumBytes) {
        throw new Error("Process journal capacity is exhausted; new execution is blocked");
      }
      this.sqlite.prepare(`INSERT INTO execution_process_journal
        (idempotency_key, observation_json, digest, budget_bytes) VALUES (?, ?, ?, ?)`)
        .run(observation.identity.idempotencyKey, json, digest(json), this.limits.maximumObservationBytes);
    })();
  }

  settle(observation: ProcessExecutionObservation): void {
    validate(observation);
    if (observation.historyRetention) throw new Error("Execution settlement cannot purge history");
    this.sqlite.transaction(() => {
      const previous = this.get(observation.identity.idempotencyKey);
      if (!previous || previous.status !== "claimed" || observation.status === "claimed" || !observation.process
        || canonicalJson(previous.identity) !== canonicalJson(observation.identity)
        || previous.schemaVersion !== observation.schemaVersion || canonicalJson(previous.launch ?? null) !== canonicalJson(observation.launch ?? null)
        || previous.nodeId !== observation.nodeId || previous.requestFingerprint !== observation.requestFingerprint) {
        throw new Error("Execution observation cannot replace its claim");
      }
      const json = JSON.stringify(observation);
      this.assertSize(json);
      const reservation = this.sqlite.prepare("SELECT budget_bytes FROM execution_process_journal WHERE idempotency_key = ?")
        .get(observation.identity.idempotencyKey) as { budget_bytes: number };
      if (Buffer.byteLength(json) > reservation.budget_bytes) throw new Error("Execution observation exceeds its reserved capacity");
      this.sqlite.prepare("UPDATE execution_process_journal SET observation_json = ?, digest = ?, budget_bytes = ? WHERE idempotency_key = ?")
        .run(json, digest(json), Buffer.byteLength(json), observation.identity.idempotencyKey);
    })();
  }

  get(idempotencyKey: string): ProcessExecutionObservation | undefined {
    const row = readExecutionRow<{ observation_json: string; digest: string }>(this.sqlite, "process", idempotencyKey);
    if (!row) return undefined;
    if (digest(row.observation_json) !== row.digest) throw new Error("Execution observation is corrupt");
    const observation = JSON.parse(row.observation_json) as ProcessExecutionObservation;
    validate(observation);
    if (observation.identity.idempotencyKey !== idempotencyKey) throw new Error("Execution observation key mismatch");
    return observation;
  }

  usage(): { records: number; reservedBytes: number; limits: Readonly<ProcessJournalLimits> } {
    const row = this.sqlite.prepare("SELECT count(*) AS records, coalesce(sum(budget_bytes), 0) AS reservedBytes FROM execution_process_journal")
      .get() as { records: number; reservedBytes: number };
    return { ...row, limits: this.limits };
  }

  /** Keyset pagination; summaries never expose raw output, arguments, paths or credentials. */
  history(input: { caseId: string; runId: string; after?: string; limit?: number }) {
    const limit = input.limit ?? 50;
    if (!input.caseId?.trim() || !input.runId?.trim() || !Number.isSafeInteger(limit) || limit < 1 || limit > 100
      || (input.after !== undefined && (typeof input.after !== "string" || input.after.length > 1024))) throw new Error("Invalid process history query");
    const rows = this.sqlite.prepare(`SELECT j.idempotency_key FROM execution_process_journal j
      JOIN tool_invocation_bindings b ON b.idempotency_key = j.idempotency_key
      WHERE b.case_id = ? AND b.run_id = ? AND j.idempotency_key > ? ORDER BY j.idempotency_key LIMIT ?`)
      .all(input.caseId, input.runId, input.after ?? "", limit + 1) as Array<{ idempotency_key: string }>;
    return { entries: rows.slice(0, limit).map((row) => {
      const record = this.get(row.idempotency_key)!;
      if (record.identity.caseId !== input.caseId || record.identity.runId !== input.runId) throw new Error("Process history attribution mismatch");
      return { identity: record.identity, status: record.status, cleanup: record.cleanup, updatedAt: record.updatedAt,
        processId: record.process?.id ?? null, historyRetention: record.historyRetention ?? null };
    }), nextCursor: rows.length > limit ? rows[limit - 1]!.idempotency_key : null };
  }

  compactCompletedHistory(): number {
    return this.sqlite.transaction(() => {
      const cutoff = new Date(Date.parse(this.now()) - this.limits.completedHistoryRetentionMs).toISOString();
      const rows = this.sqlite.prepare(`SELECT j.idempotency_key, r.result_json, b.case_id, b.run_id, b.work_id
        FROM execution_process_journal j JOIN tool_invocation_bindings b USING (idempotency_key)
        JOIN tool_invocation_executions e USING (idempotency_key) JOIN worker_tool_receipts r USING (idempotency_key)
        WHERE j.history_purged = 0 AND b.status = 'completed' AND e.status = 'completed'
          AND b.updated_at <= ? AND r.created_at <= ? ORDER BY j.idempotency_key LIMIT 32`)
        .all(cutoff, cutoff) as Array<{ idempotency_key: string; result_json: string; case_id: string; run_id: string; work_id: string }>;
      let purged = 0;
      for (const row of rows) {
        const record = this.get(row.idempotency_key)!;
        if (record.status === "claimed" || record.historyRetention) continue;
        if (record.identity.caseId !== row.case_id || record.identity.runId !== row.run_id || record.identity.workId !== row.work_id) continue;
        try { validateToolProviderResult(JSON.parse(readExecutionRow<{ result_json: string }>(this.sqlite, "receipt", row.idempotency_key)!.result_json)); } catch { continue; }
        const original = JSON.stringify(record);
        const compacted = { ...record, events: [], lostEvents: true,
          historyRetention: { purgedAt: this.now(), originalDigest: digest(original) } };
        const json = JSON.stringify(compacted);
        if (Buffer.byteLength(json) >= Buffer.byteLength(original)) {
          // Terminal history that is already smaller than a tombstone needs no rewrite.
          this.sqlite.prepare("UPDATE execution_process_journal SET history_purged = 2 WHERE idempotency_key = ?").run(row.idempotency_key);
          continue;
        }
        this.sqlite.prepare(`UPDATE execution_process_journal SET observation_json = ?, digest = ?, budget_bytes = ?, history_purged = 1
          WHERE idempotency_key = ?`).run(json, digest(json), Buffer.byteLength(json), row.idempotency_key);
        purged++;
      }
      return purged;
    })();
  }

  private assertSize(json: string): void {
    if (Buffer.byteLength(json) > this.limits.maximumObservationBytes) throw new Error("Execution observation exceeds its size limit");
  }
}

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function validate(observation: ProcessExecutionObservation): void {
  if (observation.historyRetention && (observation.status === "claimed" || observation.events.length !== 0 || !observation.lostEvents
    || !Number.isFinite(Date.parse(observation.historyRetention.purgedAt))
    || !/^[a-f0-9]{64}$/.test(observation.historyRetention.originalDigest))) throw new Error("Invalid execution history retention");
  if (![1, 2].includes(observation.schemaVersion) || observation.cleanup !== "unverified"
    || !["claimed", "exit_observed", "failure_observed"].includes(observation.status)
    || !observation.nodeId || !/^[a-f0-9]{64}$/.test(observation.requestFingerprint)
    || !Number.isFinite(Date.parse(observation.updatedAt)) || !Array.isArray(observation.events)
    || typeof observation.lostEvents !== "boolean") throw new Error("Invalid execution observation");
  if (observation.schemaVersion === 2 && (!observation.launch || observation.launch.nodeId !== observation.nodeId
    || observation.launch.requestId !== observation.identity.requestId
    || observation.launch.requestFingerprint !== observation.requestFingerprint
    || !/^[a-f0-9]{64}$/.test(observation.launch.launchId) || !observation.launch.generationId?.trim())) {
    throw new Error("Invalid execution launch provenance");
  }
  if (observation.schemaVersion === 1 && observation.launch !== undefined) throw new Error("Legacy observation cannot assert launch provenance");
  for (const key of ["idempotencyKey", "requestId", "caseId", "runId", "workId", "leaseId"] as const) {
    if (typeof observation.identity?.[key] !== "string" || !observation.identity[key].trim()) throw new Error("Invalid observation identity");
  }
  if (observation.process && (observation.process.nodeId !== observation.nodeId
    || ["caseId", "runId", "workId", "leaseId", "idempotencyKey"].some((key) =>
      observation.process!.attribution[key as keyof typeof observation.process.attribution] !== observation.identity[key as keyof typeof observation.identity]))) {
    throw new Error("Process observation attribution mismatch");
  }
}
import { readExecutionRow } from "./db/execution-archive.js";
