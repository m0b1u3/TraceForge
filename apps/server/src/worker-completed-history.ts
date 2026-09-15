import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { WorkerCheckpointDocument, CurrentWorkerCheckpointDocument } from "@traceforge/worker-runtime";

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
type Segment = { caseId: string; runId: string; workId: string; workKey: string;
  previous: WorkerCheckpointDocument["completedHistory"] | null; ids: string[] };

/** Immutable checkpoint membership, not an alternative tool execution ledger.
 * Receipt/binding reconciliation still proves that each recorded action ended. */
export class WorkerCompletedHistory {
  constructor(private readonly sqlite: Database.Database) {
    sqlite.exec(`CREATE TABLE IF NOT EXISTS worker_completed_segments (
      id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS worker_completed_segments_bound BEFORE INSERT ON worker_completed_segments
      WHEN NOT EXISTS (SELECT 1 FROM worker_completed_segments WHERE id=NEW.id) BEGIN
        SELECT CASE WHEN length(CAST(NEW.body AS BLOB))>1048576 OR (SELECT count(*) FROM worker_completed_segments)>=10000
          THEN RAISE(ABORT,'Completed history capacity exceeded') END;
        SELECT execution_physical_admit(execution_floor,maximum_database_bytes,maximum_wal_bytes,length(CAST(NEW.body AS BLOB))+2048,'execution')
          FROM execution_physical_policy WHERE id=1;
      END;
      CREATE TRIGGER IF NOT EXISTS worker_completed_segments_keep BEFORE DELETE ON worker_completed_segments
        BEGIN SELECT RAISE(ABORT,'Completed history is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS worker_completed_segments_immutable BEFORE UPDATE ON worker_completed_segments
        BEGIN SELECT RAISE(ABORT,'Completed history is immutable'); END;`);
  }

  *segments(document: WorkerCheckpointDocument): Generator<Segment> {
    let link = document.completedHistory, pages = 0;
    while (link) {
      if (++pages > 10000) throw new Error("Completed history chain exceeds capacity");
      const row = this.sqlite.prepare("SELECT body FROM worker_completed_segments WHERE id=?").get(link.head) as { body: string } | undefined;
      if (!row || digest(row.body) !== link.head) throw new Error("Completed history unavailable or corrupt");
      const value = JSON.parse(row.body) as Segment;
      if (value.caseId !== document.caseId || value.runId !== document.runId || value.workId !== document.workId || value.workKey !== document.workKey
        || !Array.isArray(value.ids) || !value.ids.length || value.ids.length > 128
        || value.ids.some(id => typeof id !== "string" || !id || Buffer.byteLength(id) > 8192)
        || new Set(value.ids).size !== value.ids.length
        || value.previous && (!/^[a-f0-9]{64}$/.test(value.previous.head) || !Number.isSafeInteger(value.previous.entries) || value.previous.entries < 1)
        || link.entries !== value.ids.length + (value.previous?.entries ?? 0)) throw new Error("Invalid completed history ownership or count");
      yield value;
      link = value.previous ?? undefined;
    }
  }

  has(document: WorkerCheckpointDocument, id: string): boolean {
    for (const segment of this.segments(document)) if (segment.ids.includes(id)) return true;
    return false;
  }

  verify(document: WorkerCheckpointDocument): void {
    for (const segment of this.segments(document)) {
      if (document.journal?.completedIntentIds.some(id => segment.ids.includes(id))
        || document.pendingInvocation && segment.ids.includes(document.pendingInvocation.invocation.id)) throw new Error("Completed history overlaps active invocation");
    }
  }

  compact(document: CurrentWorkerCheckpointDocument): void {
    if (document.journal.completedIntentIds.length <= 256) return;
    this.verify(document);
    while (document.journal.completedIntentIds.length > 128) {
      const ids = document.journal.completedIntentIds.slice(0, 128);
      if (ids.some(id => this.has(document, id))) throw new Error("Duplicate completed invocation history");
      const body = JSON.stringify({ caseId: document.caseId, runId: document.runId, workId: document.workId, workKey: document.workKey,
        previous: document.completedHistory ?? null, ids } satisfies Segment);
      const head = digest(body);
      this.sqlite.prepare("INSERT OR IGNORE INTO worker_completed_segments VALUES (?,?)").run(head, body);
      document.completedHistory = { head, entries: (document.completedHistory?.entries ?? 0) + ids.length };
      document.journal.completedIntentIds.splice(0, ids.length);
    }
  }
}
