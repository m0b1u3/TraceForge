import { readFileSync, writeSync } from "node:fs";
import { createDb, getSqliteClient } from "../src/db/client.js";
import { SqliteProcessOperationJournal } from "../src/execution-process-operation-journal.js";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const sqlite = getSqliteClient(createDb(config.databasePath));
const checkpoint = (phase) => {
  writeSync(1, `${JSON.stringify({ checkpoint: phase })}\n`);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
};

if (config.fault === "before-commit") {
  sqlite.function("archive_checkpoint", () => checkpoint("before-commit"));
  sqlite.exec(`CREATE TEMP TRIGGER execution_process_operation_archive_fault
    BEFORE UPDATE OF archived_at ON execution_process_operations
    WHEN OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL
    BEGIN SELECT archive_checkpoint(); END;`);
}

new SqliteProcessOperationJournal(sqlite, { completedRetentionMs: 1_000, compactionBatchSize: 8 },
  () => "2026-09-02T01:00:03.000Z");
checkpoint("after-commit");
