import { writeSync } from "node:fs";
import { join } from "node:path";
import { database, initialize, controls, at } from "../src/test-fixtures/execution-recovery.ts";
import { SqliteToolReceiptStore } from "../src/worker-execution-adapters.ts";
import { ExecutionArchiveControl } from "../src/execution-archive-control.ts";
import { SqliteWorkerCheckpointStore } from "../src/worker-checkpoint-store.ts";

const [root, mode, phase] = process.argv.slice(2);
const db = database(join(root, "state.db"));
const c = mode === "crash" ? initialize(db) : controls(db);
const archiveAt = "2026-08-31T01:00:00.000Z";
const result = { status: "succeeded", summary: "Saved", raw: "neutral observation ".repeat(5000), refs: [], retryable: false };
if (mode === "crash") {
  await c.bindings.prepare({ idempotencyKey: "call", invocationId: "first", tool: { name: "observe", source: "neutral", version: "1", contractFingerprint: "a".repeat(64) },
    inputFingerprint: "b".repeat(64), attribution: { caseId: "case", runId: "run", workId: "work" } });
  await c.bindings.beginExecution("call", "lease", "worker");
  await new SqliteToolReceiptStore(db).put("call", result); await c.bindings.complete("call");
  await new SqliteWorkerCheckpointStore(db).save({ version: 2, caseId: "case", workKey: "effect", workerId: "worker", runId: "run", workId: "work",
    leaseId: "lease", turn: 1, transcript: [], steering: ["confirmed".repeat(300)], completedInvocationIds: ["first"], consecutiveFailures: 0, pendingInvocation: null, savedAt: at });
  c.runtime.execute({ runId: "run", commandId: "cancel", expectedRevision: c.runtime.load("run").revision,
    command: { type: "cancel_run", reason: "Closed", at } });
}
const ref = db.prepare("SELECT ref FROM worker_checkpoints").get().ref;
const input = { commandId: "archive", actor: "operator", reason: "Archive closed Run", caseId: "case", runId: "run", expectedRevision: c.runtime.load("run").revision,
  entries: [{ kind: "receipt", key: "call" }, { kind: "checkpoint", key: ref }] };
function stop() {
  writeSync(1, JSON.stringify({ boundary: phase }) + "\n");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
if (mode === "crash" && phase !== "committed") {
  db.function("crash_boundary", () => { stop(); return 0; });
  db.exec(phase === "cold-written"
    ? "CREATE TEMP TRIGGER stop_archive AFTER INSERT ON execution_archives BEGIN SELECT crash_boundary(); END"
    : "CREATE TEMP TRIGGER stop_archive AFTER UPDATE ON worker_tool_receipts BEGIN SELECT crash_boundary(); END");
}
const before = { archives: db.prepare("SELECT count(*) AS n FROM execution_archives").get().n,
  audits: db.prepare("SELECT count(*) AS n FROM execution_archive_commands").get().n };
const control = new ExecutionArchiveControl(db, { async authorize() { return { decision: "allowed", authorizationRef: "test-grant", expiresAt: "2099-01-01T00:00:00.000Z" }; } }, () => archiveAt);
const archived = await control.archive(input);
if (mode === "crash") stop();
const receipt = await new SqliteToolReceiptStore(db).get("call");
const checkpoint = await new SqliteWorkerCheckpointStore(db).load(ref);
process.stdout.write(JSON.stringify({ before, outcome: archived.audit.outcome, replayed: archived.replayed,
  archives: db.prepare("SELECT count(*) AS n FROM execution_archives").get().n,
  audits: db.prepare("SELECT count(*) AS n FROM execution_archive_commands").get().n,
  usage: db.prepare("SELECT * FROM execution_archive_usage").get(), receiptMatches: JSON.stringify(receipt) === JSON.stringify(result),
  checkpointMatches: checkpoint.completedInvocationIds[0] === "first", integrity: db.pragma("integrity_check", { simple: true }) }) + "\n");
db.close();
