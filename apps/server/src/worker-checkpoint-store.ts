import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { validateWorkerCheckpoint, type WorkerCheckpointDocument, type WorkerCheckpointStore } from "@traceforge/worker-runtime";
import { readExecutionRow } from "./db/execution-archive.js";

/** New snapshots use transactional, quota-managed storage. Old files remain read-only compatibility data. */
export class SqliteWorkerCheckpointStore implements WorkerCheckpointStore {
  constructor(private readonly sqlite: Database.Database, private readonly legacy?: WorkerCheckpointStore) {}
  async save(document: WorkerCheckpointDocument): Promise<string> {
    validateWorkerCheckpoint(document);
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
    return validateWorkerCheckpoint(JSON.parse(row.document_json));
  }
}
