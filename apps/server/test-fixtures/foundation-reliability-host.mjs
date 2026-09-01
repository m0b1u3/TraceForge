// Local neutral workload only. No model, remote target, credentials, or concrete security scenario.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createExecutionToolRegistry, executionToolContractFingerprint, PolicyExecutionToolGateway } from "@traceforge/worker-runtime";
import { database, controls, at } from "../src/test-fixtures/execution-recovery.ts";
import { SqliteToolReceiptStore } from "../src/worker-execution-adapters.ts";
import { SqliteWorkerCheckpointStore } from "../src/worker-checkpoint-store.ts";
import { ExecutionArchiveControl } from "../src/execution-archive-control.ts";
import { StorageMaintenanceControl } from "../src/storage-maintenance.ts";
import { physicalStorageStatus, registerPhysicalStorageFunctions } from "../src/db/physical-storage.ts";
import { executionStorageStatus } from "../src/db/execution-storage.ts";

export async function runReliabilityCycle(directory, cycleValue, mode, phase, emit = true) {
const cycle = Number(cycleValue);
assert(Number.isSafeInteger(cycle) && cycle >= 0 && cycle < 30000);
const root = realpathSync(directory), db = database(join(root, "state.db")), c = controls(db);
const id = `run-${String(cycle).padStart(5, "0")}`, key = `${id}:call`, leaseId = `${id}:lease`;
const effects = join(root, "effects"); mkdirSync(effects, { recursive: true });
const expected = { status: "succeeded", summary: "Observed", raw: "neutral bounded observation ".repeat(2000), refs: [], retryable: false };
const archiveAt = "2026-09-02T00:00:00.000Z";
const allow = { async authorize() { return { decision: "allowed", authorizationRef: "local-acceptance-only", expiresAt: "2099-01-01T00:00:00.000Z" }; } };
const adapter = { name: "observe", source: "neutral", version: "1", description: "Local observation", inputSchema: { type: "object" },
  providedCapabilities: ["observe"], dependencyCapabilities: [], permissionRequirements: {}, risk: "read_only", timeoutMs: 1000, priority: 1,
  async execute() {
    // Exclusive marker makes a second invocation an observable failed invariant, not a hidden duplicate.
    writeFileSync(join(effects, `${id}.json`), JSON.stringify({ id, effects: 1 }), { flag: "wx" });
    return expected;
  } };
if (!c.runtime.load(id)) {
  const apply = (commandId, command) => c.runtime.execute({ runId: id, commandId: `${id}:${commandId}`, expectedRevision: c.runtime.load(id)?.revision ?? 0,
    definitionKind: "neutral", definitionVersion: 1, command });
  apply("start", { type: "start_run", runId: id, caseId: "case", goal: "Observe", scopeRef: "scope", scenarioPackage: { id: "neutral", version: "1.0.0", schemaRevision: 1 }, availableCapabilities: ["observe"], at });
  apply("propose", { type: "propose_work", proposal: { id: "work", kind: "observe", title: "Observe", objective: "Observe", idempotencyKey: `${id}:effect` }, at });
  apply("claim", { type: "claim_work", workId: "work", leaseId, workerId: "worker", workerRoles: ["observer"], workerCapabilities: ["observe"],
    workerCurrentWork: 0, workerMaxConcurrentWork: 1, leaseExpiresAt: "2099-01-01T00:00:00.000Z", at });
}
const state = c.runtime.load(id), invocation = { id: "first", tool: "observe", input: {}, rationale: "Local acceptance" };
const assignment = { runId: id, leaseId, leaseExpiresAt: "2099-01-01T00:00:00.000Z", runRevision: state.revision,
  runContext: { caseId: "case", goal: "Observe", scopeRef: "scope", activePhaseId: "observe", directives: [] }, work: state.workItems[0] };
const request = { worker: { id: "worker", roles: ["observer"], capabilities: ["observe"], maxConcurrentWork: 1, status: "online", heartbeatAt: at },
  assignment, idempotencyKey: key, invocation };
const gateway = new PolicyExecutionToolGateway(createExecutionToolRegistry([adapter]), { async authorize() { return { decision: "approved" }; } }, new SqliteToolReceiptStore(db), {
  allowedRisks: ["read_only"], permissionLayers: () => [{ source: "local-acceptance", profile: { version: 1, platform: "darwin",
    filesystem: { read: [], write: [], deny: [] }, network: "deny", process: { access: "deny", interactive: false, background: false }, secrets: "deny" } }],
}, undefined, c.bindings);
const checkpoints = new SqliteWorkerCheckpointStore(db);
const pending = { version: 2, caseId: "case", workKey: `${id}:effect`, workerId: "worker", runId: id, workId: "work", leaseId, turn: 0,
  transcript: [], steering: [], completedInvocationIds: [], consecutiveFailures: 0,
  pendingInvocation: { invocation, turn: 1, risk: "read_only", contractFingerprint: executionToolContractFingerprint(adapter) }, savedAt: at };
const pendingRef = await checkpoints.save(pending);
if (mode === "crash") {
  // Physical pressure is injected without filling the user's disk. The SQLite_FULL test is separate and real.
  registerPhysicalStorageFunctions(db, () => ({ databaseBytes: 0, walBytes: 0, shmBytes: 0, availableBytes: 0 }));
  await assert.rejects(gateway.execute(request), /physical storage pressure/);
  assert(!existsSync(join(effects, `${id}.json`)));
  // A fresh connection restores the native probe, not a fabricated observation.
  db.close();
  // Restart at a new host even for the pre-dispatch gate.
  const report = { boundary: "admission-checked" };
  if (emit) process.stdout.write(JSON.stringify(report) + "\n");
  return report;
}
function stop() { writeSync(1, JSON.stringify({ boundary: phase }) + "\n"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); }
const result = await gateway.execute(request); assert.equal(result.raw, expected.raw);
if (mode === "kill" && phase === "receipt") stop();
const complete = { ...pending, turn: 1, pendingInvocation: null, completedInvocationIds: ["first"], transcript: [{ turn: 1, kind: "tool", summary: result.summary, refs: [] }] };
if (mode === "kill") {
  db.exec("CREATE TEMP TRIGGER fail_result_checkpoint BEFORE INSERT ON worker_checkpoints BEGIN SELECT RAISE(ABORT,'injected checkpoint failure'); END");
  await assert.rejects(checkpoints.save(complete), /injected checkpoint failure/);
  db.exec("DROP TRIGGER fail_result_checkpoint");
  assert.equal((await checkpoints.load(pendingRef)).pendingInvocation.invocation.id, "first");
  assert.equal((await gateway.execute(request)).raw, result.raw);
}
const completeRef = await checkpoints.save(complete);
if (c.runtime.load(id).status !== "cancelled") c.runtime.execute({ runId: id, commandId: `${id}:close`, expectedRevision: c.runtime.load(id).revision,
  command: { type: "cancel_run", reason: "Completed local workload", at } });
const archive = new ExecutionArchiveControl(db, allow, () => archiveAt);
const archiveInput = { commandId: `${id}:archive`, actor: "acceptance", reason: "Closed records", caseId: "case", runId: id,
  expectedRevision: c.runtime.load(id).revision, entries: [{ kind: "receipt", key }, { kind: "checkpoint", key: pendingRef }, { kind: "checkpoint", key: completeRef }] };
if (mode === "kill") {
  db.exec("UPDATE execution_archive_policy SET maximum_bytes=1");
  await assert.rejects(archive.archive(archiveInput), /capacity exhausted/);
  assert.equal(db.prepare("SELECT count(*) AS n FROM execution_archive_commands WHERE command_id=?").get(archiveInput.commandId).n, 0);
  assert.equal((await gateway.execute(request)).raw, result.raw);
  db.exec("UPDATE execution_archive_policy SET maximum_bytes=1073741824");
  if (phase === "archive-uncommitted") {
    db.function("stop_soak_archive", () => { stop(); return 0; });
    db.exec("CREATE TEMP TRIGGER crash_soak_archive AFTER INSERT ON execution_archives BEGIN SELECT stop_soak_archive(); END");
  }
}
assert.equal((await archive.archive(archiveInput)).audit.outcome, "archived");
if (mode === "kill") stop();
assert.equal((await archive.archive(archiveInput)).replayed, true);
assert.equal((await gateway.execute(request)).raw, expected.raw);
assert.equal((await checkpoints.load(completeRef)).completedInvocationIds[0], "first");
assert.deepEqual(JSON.parse(readFileSync(join(effects, `${id}.json`), "utf8")), { id, effects: 1 });
if (cycle > 0) {
  const previous = `run-${String(cycle - 1).padStart(5, "0")}:call`;
  assert.equal((await new SqliteToolReceiptStore(db).get(previous)).raw, expected.raw);
  await assert.rejects(c.bindings.beginExecution(previous, leaseId, "worker"));
}
const maintenance = new StorageMaintenanceControl(db, join(root, "legacy"), allow, () => archiveAt);
if (cycle % 20 === 0) await maintenance.execute({ action: "checkpoint_wal", commandId: `${id}:wal`, actor: "acceptance", reason: "Bound WAL", mode: "TRUNCATE" });
assert.equal(db.pragma("quick_check", { simple: true }), "ok");
const mismatches = db.prepare(`SELECT count(*) AS n FROM execution_storage_usage u WHERE records !=
  (SELECT count(*) FROM execution_storage_entries e WHERE e.kind=u.kind) OR bytes !=
  (SELECT coalesce(sum(bytes),0) FROM execution_storage_entries e WHERE e.kind=u.kind)`).get().n;
assert.equal(mismatches, 0);
const report = { cycle, phase, effects: 1, restored: true, integrity: "ok", physical: physicalStorageStatus(db),
  logical: executionStorageStatus(db), rssBytes: process.memoryUsage().rss };
if (emit) process.stdout.write(JSON.stringify(report) + "\n"); db.close(); return report;
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) await runReliabilityCycle(...process.argv.slice(2));
