import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { validateWorkerCheckpoint, type WorkerCheckpointDocument, type WorkerCheckpointStore, type CurrentWorkerCheckpointDocument } from "@traceforge/worker-runtime";
import { readExecutionRow } from "./db/execution-archive.js";
import { WorkerCompletedHistory } from "./worker-completed-history.js";

/** New snapshots use transactional, quota-managed storage. Old files remain read-only compatibility data. */
export class SqliteWorkerCheckpointStore implements WorkerCheckpointStore {
  private readonly completed: WorkerCompletedHistory;
  constructor(private readonly sqlite: Database.Database, private readonly legacy?: WorkerCheckpointStore) {
    this.completed = new WorkerCompletedHistory(sqlite);
    sqlite.exec(`CREATE TABLE IF NOT EXISTS worker_journal_segments (
      id TEXT PRIMARY KEY, case_id TEXT NOT NULL, run_id TEXT NOT NULL, work_id TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS worker_journal_segment_bound BEFORE INSERT ON worker_journal_segments
      WHEN NOT EXISTS(SELECT 1 FROM worker_journal_segments WHERE id=NEW.id) BEGIN
      SELECT CASE WHEN length(CAST(NEW.body AS BLOB))>1048576 OR (SELECT count(*) FROM worker_journal_segments)>=10000
      THEN RAISE(ABORT,'Journal archive capacity exceeded') END;
      SELECT execution_physical_admit(execution_floor,maximum_database_bytes,maximum_wal_bytes,length(CAST(NEW.body AS BLOB))+2048,'execution')
      FROM execution_physical_policy WHERE id=1; END;`);
  }
  async compact(document: CurrentWorkerCheckpointDocument): Promise<CurrentWorkerCheckpointDocument> {
    // Validate before removing entries, otherwise malformed old entries could
    // disappear from validation merely because they crossed the rolling window.
    validateWorkerCheckpoint(document);
    if (document.journal.entries.length <= 96 && document.journal.completedIntentIds.length <= 256) return document;
    const next = structuredClone(document);
    this.completed.compact(next);
    if (next.journal.entries.length <= 96) { validateWorkerCheckpoint(next); return next; }
    const entries = next.journal.entries.splice(0, next.journal.entries.length - 48);
    const body = JSON.stringify({ caseId: next.caseId, runId: next.runId, workId: next.workId, previous: next.history ?? null, entries });
    const id = createHash("sha256").update(body).digest("hex");
    next.history = { head: id, entries: (next.history?.entries ?? 0) + entries.length };
    validateWorkerCheckpoint(next);
    this.sqlite.prepare("INSERT OR IGNORE INTO worker_journal_segments VALUES (?,?,?,?,?)").run(id, next.caseId, next.runId, next.workId, body);
    return next;
  }
  async save(document: WorkerCheckpointDocument): Promise<string> {
    validateWorkerCheckpoint(document);
    this.completed.verify(document);
    const body = JSON.stringify(document);
    const ref = `checkpoint://sha256-${createHash("sha256").update(body).digest("hex")}.json`;
    this.sqlite.transaction(() => {
      const existing = readExecutionRow<{ document_json: string }>(this.sqlite, "checkpoint", ref);
      if (existing) { if (existing.document_json !== body) throw new Error("Checkpoint identity conflict"); return; }
      this.sqlite.prepare("INSERT INTO worker_checkpoints VALUES (?, ?, ?, ?, ?, ?)")
        .run(ref, document.caseId ?? "legacy", document.runId, document.workId, body, document.savedAt);
    })();
    return ref;
  }
  async load(ref: string): Promise<WorkerCheckpointDocument> {
    const row = readExecutionRow<{ document_json: string }>(this.sqlite, "checkpoint", ref);
    if (!row) {
      if (!this.legacy) throw new Error("Unknown checkpoint reference");
      return this.legacy.load(ref);
    }
    if (ref !== `checkpoint://sha256-${createHash("sha256").update(row.document_json).digest("hex")}.json`) throw new Error("Checkpoint integrity mismatch");
    const document = validateWorkerCheckpoint(JSON.parse(row.document_json));
    this.completed.verify(document);
    let history = document.history;
    let count = 0;
    while (history) {
      if (++count > 10000) throw new Error("Journal history chain exceeds limit");
      const segment = this.sqlite.prepare("SELECT body FROM worker_journal_segments WHERE id=? AND case_id=? AND run_id=? AND work_id=?")
        .get(history.head, document.caseId, document.runId, document.workId) as { body: string } | undefined;
      if (!segment || createHash("sha256").update(segment.body).digest("hex") !== history.head) throw new Error("Journal history unavailable or corrupt");
      const value = JSON.parse(segment.body);
      if (value.caseId !== document.caseId || value.runId !== document.runId || value.workId !== document.workId
        || !Array.isArray(value.entries) || !value.entries.length || history.entries !== value.entries.length + (value.previous?.entries ?? 0)) throw new Error("Journal history count or ownership mismatch");
      if (value.previous && (!/^[a-f0-9]{64}$/.test(value.previous.head) || !Number.isSafeInteger(value.previous.entries) || value.previous.entries < 1)) throw new Error("Invalid journal history link");
      validateWorkerCheckpoint({ ...document, history: undefined, journal: { ...document.journal!, entries: value.entries } });
      history = value.previous;
    }
    return document;
  }
  async hasCompleted(document: CurrentWorkerCheckpointDocument, id: string): Promise<boolean> {
    return document.journal.completedIntentIds.includes(id) || this.completed.has(document, id);
  }

  /** Read archived originals for current-context projection, never for replay. */
  async archivedEntries(ref: string, owner: { caseId: string; runId: string; workId: string }) {
    const document = await this.load(ref);
    if (document.runId !== owner.runId || document.workId !== owner.workId
      || (document.caseId !== undefined && document.caseId !== owner.caseId))
      throw new Error("Journal context owner mismatch");
    // Legacy checkpoints without Case metadata have no archive to contribute;
    // their normal restoration remains governed by the existing recovery path.
    if (!document.history) return [];
    if (document.caseId !== owner.caseId) throw new Error("Journal context owner mismatch");
    const segments: NonNullable<CurrentWorkerCheckpointDocument["journal"]>["entries"][] = [];
    let history = document.history, bytes = 0;
    while (history) {
      const row = this.sqlite.prepare("SELECT body FROM worker_journal_segments WHERE id=? AND case_id=? AND run_id=? AND work_id=?")
        .get(history.head, owner.caseId, owner.runId, owner.workId) as { body: string } | undefined;
      if (!row || createHash("sha256").update(row.body).digest("hex") !== history.head) throw new Error("Journal archive changed during context read");
      bytes += Buffer.byteLength(row.body);
      if (bytes > 16 * 1048576) throw new Error("Journal context source capacity exceeded");
      const value = JSON.parse(row.body);
      segments.push(value.entries);
      history = value.previous;
    }
    return segments.reverse().flat();
  }
}
