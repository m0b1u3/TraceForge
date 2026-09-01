import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { database, initialize, at } from "../src/test-fixtures/execution-recovery.ts";
import { StorageMaintenanceControl } from "../src/storage-maintenance.ts";
import { SqliteWorkerCheckpointStore } from "../src/worker-checkpoint-store.ts";

const [directory, mode, phase] = process.argv.slice(2), root = realpathSync(directory);
const db = database(join(root, "state.db")), files = join(root, "checkpoints");
const document = { version: 2, caseId: "case", workKey: "effect", workerId: "worker", runId: "run", workId: "work", leaseId: "lease",
  turn: 0, transcript: [], steering: [], completedInvocationIds: [], consecutiveFailures: 0, pendingInvocation: null, savedAt: at };
const body = JSON.stringify(document), digest = createHash("sha256").update(body).digest("hex"), name = `sha256-${digest}.json`;
if (mode === "crash") {
  const c = initialize(db);
  c.runtime.execute({ runId: "run", commandId: "close", expectedRevision: c.runtime.load("run").revision, command: { type: "cancel_run", reason: "Closed", at } });
  mkdirSync(files); writeFileSync(join(files, name), body); utimesSync(join(files, name), new Date(at), new Date(at));
}
const control = new StorageMaintenanceControl(db, files, { async authorize() { return { decision: "allowed", authorizationRef: "test-only", expiresAt: "2099-01-01T00:00:00.000Z" }; } }, () => "2026-09-02T00:00:00.000Z");
function stop() { writeSync(1, JSON.stringify({ boundary: phase }) + "\n"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); }
if (mode === "crash" && phase !== "completed") {
  db.function("crash_maintenance", () => { stop(); return 0; });
  db.exec(phase === "import-uncommitted"
    ? "CREATE TEMP TRIGGER stop_import AFTER INSERT ON worker_checkpoints BEGIN SELECT crash_maintenance(); END"
    : "CREATE TEMP TRIGGER stop_retire BEFORE UPDATE ON storage_maintenance_commands WHEN NEW.phase='completed' BEGIN SELECT crash_maintenance(); END");
}
const before = { file: existsSync(join(files, name)), checkpoints: db.prepare("SELECT count(*) AS n FROM worker_checkpoints").get().n,
  phase: db.prepare("SELECT phase FROM storage_maintenance_commands WHERE command_id='migrate'").get()?.phase ?? null };
const response = await control.execute({ action: "migrate_checkpoint", commandId: "migrate", actor: "operator", reason: "Consolidate", name, digest, retireSource: true });
if (mode === "crash") stop();
const restored = await new SqliteWorkerCheckpointStore(db).load(`checkpoint://${name}`);
process.stdout.write(JSON.stringify({ before, replayed: response.replayed, phase: response.phase, matches: JSON.stringify(restored) === body,
  file: existsSync(join(files, name)), usage: db.prepare("SELECT records, bytes FROM execution_storage_usage WHERE kind='checkpoint'").get(),
  integrity: db.pragma("integrity_check", { simple: true }) }) + "\n"); db.close();
