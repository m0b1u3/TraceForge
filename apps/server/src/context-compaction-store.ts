import type Database from "better-sqlite3";
import type { ContextCompactionRecord, ContextCompactionStore, ContextTextEntry } from "@traceforge/cognitive-runtime";

export class SqliteContextCompactionStore implements ContextCompactionStore {
  constructor(private readonly sqlite: Database.Database) {
    sqlite.exec(`CREATE TABLE IF NOT EXISTS context_compactions (
      id TEXT PRIMARY KEY, identity_json TEXT NOT NULL, status TEXT NOT NULL, entries_json TEXT, error TEXT);
      CREATE TRIGGER IF NOT EXISTS context_compactions_bounded BEFORE INSERT ON context_compactions BEGIN
        SELECT CASE WHEN (SELECT count(*) FROM context_compactions)>=4096 OR length(CAST(NEW.identity_json AS BLOB))>65536
          THEN RAISE(ABORT,'Context compaction ledger capacity exceeded') END;
        SELECT execution_physical_admit(execution_floor, maximum_database_bytes, maximum_wal_bytes,
          length(CAST(NEW.identity_json AS BLOB))+131072,'execution') FROM execution_physical_policy WHERE id=1;
      END;
      CREATE TRIGGER IF NOT EXISTS context_compactions_identity BEFORE UPDATE ON context_compactions BEGIN
        SELECT CASE WHEN NEW.id!=OLD.id OR NEW.identity_json!=OLD.identity_json OR OLD.status!='prepared'
          OR NEW.status NOT IN ('completed','failed') OR length(CAST(coalesce(NEW.entries_json,'') AS BLOB))>131072
          OR length(coalesce(NEW.error,''))>512 THEN RAISE(ABORT,'Invalid compaction lifecycle transition') END;
      END;
      CREATE TRIGGER IF NOT EXISTS context_compactions_keep BEFORE DELETE ON context_compactions
        BEGIN SELECT RAISE(ABORT,'Compaction identity cannot be deleted'); END;`);
  }
  get(id: string): ContextCompactionRecord | undefined {
    const row = this.sqlite.prepare("SELECT identity_json,status,entries_json,error FROM context_compactions WHERE id=?").get(id) as
      { identity_json: string; status: ContextCompactionRecord["status"]; entries_json: string | null; error: string | null } | undefined;
    return row ? { ...JSON.parse(row.identity_json), status: row.status, entries: row.entries_json ? JSON.parse(row.entries_json) : null, error: row.error } : undefined;
  }
  prepare(record: ContextCompactionRecord): void {
    this.sqlite.prepare("INSERT INTO context_compactions VALUES (?,?,'prepared',NULL,NULL)").run(record.id, JSON.stringify(record));
  }
  finish(id: string, entries: ContextTextEntry[] | null, error: string | null): void {
    const result = this.sqlite.prepare("UPDATE context_compactions SET status=?,entries_json=?,error=? WHERE id=? AND status='prepared'")
      .run(error ? "failed" : "completed", entries ? JSON.stringify(entries) : null, error, id);
    if (result.changes !== 1) throw new Error("Compaction result lost execution ownership");
  }
  recoverPrepared(): number {
    return this.sqlite.prepare("UPDATE context_compactions SET status='failed',error='Host restarted before compaction completed' WHERE status='prepared'").run().changes;
  }
}
