import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  LocalExecutionNode, NodeSpawnProcessLauncher, ExecutionRpcDispatcher,
  permissionProfileFingerprint, resourceLimitsFingerprint, type StartProcessRequest, type LocalExecutionNodeOptions, type ProcessLaunchIdentity,
} from "@traceforge/execution-node";
import { createDb, getSqliteClient } from "./db/client.js";
import { SqliteProcessExecutionJournal } from "./execution-process-journal.js";
import { SqliteToolInvocationBindingStore, SqliteToolReceiptStore } from "./worker-execution-adapters.js";

const databases = new Set<Database.Database>();
const directories: string[] = [];
afterEach(() => {
  for (const db of databases) if (db.open) db.close();
  databases.clear();
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});
function setup(maximumRetainedEventsPerProcess = 4096) {
  const root = mkdtempSync(join(tmpdir(), "traceforge-exec-journal-")); directories.push(root);
  const path = join(root, "journal.sqlite");
  const sqlite = getSqliteClient(createDb(path)); databases.add(sqlite);
  const platform = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
  const request: StartProcessRequest = {
    requestId: "request", attribution: { caseId: "case", runId: "run", workId: "work", workerId: "worker", scopeRef: "scope",
      leaseId: "lease", leaseExpiresAt: "2099-01-01T00:00:00.000Z", actionId: "action", idempotencyKey: "effect" },
    executable: process.execPath, arguments: ["--version"], workingDirectory: root,
    environment: { PRIVATE_TEST_VALUE: "not-stored-in-journal" }, stdin: "closed", timeoutMs: 5000, outputLimitBytes: 1024,
    resources: { cpuTimeMs: 5000, memoryBytes: 134217728, maximumProcesses: 1, writeBytes: 1048576 },
    permissions: { version: 1, platform, filesystem: { read: [{ path: dirname(process.execPath), scope: "tree" }, { path: root, scope: "tree" }], write: [], deny: [] },
      network: "deny", process: { access: "sandboxed", interactive: false, background: false }, secrets: "deny", sources: ["test"] },
  };
  // Test-only launcher: this validates real subprocess bookkeeping, NOT native sandbox isolation.
  let launches = 0;
  const launcher = new NodeSpawnProcessLauncher((input) => {
    launches++;
    return { executable: input.executable, arguments: input.arguments, workingDirectory: input.workingDirectory,
      environment: input.environment, detached: false, windowsHide: true,
      enforcement: { sandboxBackend: "test", sandboxed: true, filesystemPolicyApplied: true,
        permissionProfileFingerprint: permissionProfileFingerprint(input.permissions), resourceLimitsApplied: true,
        resourceLimitsFingerprint: resourceLimitsFingerprint(input.resources), network: "deny" } };
  });
  const journal = new SqliteProcessExecutionJournal(sqlite);
  const options: LocalExecutionNodeOptions = { platform, sandboxBackends: ["test"], processJournal: journal, maximumRetainedEventsPerProcess,
    capabilities: { process: { spawn: true, stdio: true, tty: false, adoption: true, resourceLimits: true, signals: ["kill" as const] } } };
  const node = new LocalExecutionNode(launcher, options);
  const query = { requestId: "request", idempotencyKey: "effect", caseId: "case", runId: "run", workId: "work", leaseId: "lease" };
  const complete = async (target = node, input = request) => {
    const started = await target.startProcess(input);
    for (let i = 0; i < 20; i++) {
      const batch = await target.waitProcessEvents({ processId: started.process.id, adoptionToken: started.adoptionToken,
        afterSequence: (await target.describeProcess(startedAccess(started))).lastEventSequence, maximumEvents: 256 }, 500);
      if (batch.process.state === "exited") return started;
    }
    throw new Error("Test process did not exit");
  };
  return { sqlite, journal, path, node, launcher, options, query, request, complete, launches: () => launches };
}
function startedAccess(started: { process: { id: string }; adoptionToken: string }) {
  return { processId: started.process.id, adoptionToken: started.adoptionToken };
}

describe("Durable Execution Node observations", () => {
  it("migrates legacy journal accounting conservatively and idempotently", async () => {
    const c = setup(); await c.complete();
    const original = c.journal.get("effect")!;
    c.journal.claim({ ...original, identity: { ...original.identity, idempotencyKey: "pending" }, status: "claimed", process: null, events: [] });
    // Reconstruct the legacy schema, before the unified accounting and physical admission triggers existed.
    c.sqlite.exec("DROP TRIGGER execution_physical_execution_process_journal");
    c.sqlite.exec("DROP TRIGGER execution_storage_process_insert; DROP TRIGGER execution_storage_process_update; ALTER TABLE execution_process_journal DROP COLUMN budget_bytes");
    c.sqlite.close();
    for (let i = 0; i < 2; i++) {
      const db = getSqliteClient(createDb(c.path)); databases.add(db);
      const journal = new SqliteProcessExecutionJournal(db);
      expect(journal.usage().records).toBe(2);
      expect(journal.usage().reservedBytes).toBe(8 * 1024 * 1024 + Buffer.byteLength(JSON.stringify(original)));
      expect(journal.get("pending")?.status).toBe("claimed");
      db.close();
    }
  });

  async function confirmed(c: ReturnType<typeof setup>, key = "effect") {
    const bindings = new SqliteToolInvocationBindingStore(c.sqlite, () => "2026-01-01T00:00:00.000Z");
    await bindings.prepare({ idempotencyKey: key, invocationId: key,
      tool: { name: "neutral", source: "test", version: "1", contractFingerprint: "a".repeat(64) }, inputFingerprint: "b".repeat(64),
      attribution: { caseId: "case", runId: "run", workId: "work" } });
    await new SqliteToolReceiptStore(c.sqlite, () => "2026-01-01T00:00:00.000Z").put(key,
      { status: "succeeded", summary: "confirmed", raw: "receipt survives", refs: [], retryable: false });
    await bindings.complete(key);
  }

  it("bounds resident history over repeated real executions and retains durable replay fences after restarts", async () => {
    const c = setup();
    const node = new LocalExecutionNode(c.launcher, { ...c.options, maximumResidentProcesses: 1, terminalRetentionMs: 0 });
    const first = await c.complete(node);
    for (let i = 0; i < 6; i++) await c.complete(node, { ...c.request, attribution: { ...c.request.attribution, idempotencyKey: `later-${i}` } });
    await expect(node.describeProcess(startedAccess(first))).rejects.toThrow("Unknown execution process");
    expect(await node.lookupProcessExecution(c.query)).toMatchObject({ status: "exit_observed", cleanup: "unverified" });
    await expect(node.startProcess(c.request)).rejects.toThrow("already claimed");
    c.sqlite.close();
    for (let i = 0; i < 2; i++) {
      const db = getSqliteClient(createDb(c.path)); databases.add(db);
      const restarted = new LocalExecutionNode(c.launcher, { ...c.options, processJournal: new SqliteProcessExecutionJournal(db) });
      await expect(restarted.startProcess(c.request)).rejects.toThrow("already claimed");
      db.close();
    }
    expect(c.launches()).toBe(7);
  });

  it.each(["retention", "settle-failed"])("protects resident records when %s blocks safe eviction", async (mode) => {
    const c = setup();
    if (mode === "settle-failed") c.sqlite.exec("CREATE TEMP TRIGGER retention_failure BEFORE UPDATE ON execution_process_journal BEGIN SELECT RAISE(ABORT, 'disk unavailable'); END");
    const node = new LocalExecutionNode(c.launcher, { ...c.options, maximumResidentProcesses: 1, terminalRetentionMs: mode === "retention" ? 60_000 : 0 });
    const first = await c.complete(node);
    await expect(node.startProcess({ ...c.request, attribution: { ...c.request.attribution, idempotencyKey: "second" } }))
      .rejects.toThrow("history capacity");
    expect(await node.describeProcess(startedAccess(first))).toMatchObject({ state: "exited" });
    expect(c.launches()).toBe(1);
  });

  it.each(["records", "bytes"])("rejects new launch before side effects at the journal %s limit", async (limit) => {
    const c = setup();
    const journal = new SqliteProcessExecutionJournal(c.sqlite, { maximumRecords: limit === "records" ? 1 : 100,
      maximumObservationBytes: 8192, maximumBytes: limit === "bytes" ? 8192 : 16384 });
    const node = new LocalExecutionNode(c.launcher, { ...c.options, processJournal: journal });
    await c.complete(node);
    const usage = journal.usage();
    expect(usage.reservedBytes).toBeLessThan(8192);
    await expect(node.startProcess({ ...c.request, attribution: { ...c.request.attribution, idempotencyKey: "second" } }))
      .rejects.toThrow("journal capacity");
    expect(journal.usage()).toEqual(usage);
    expect(c.launches()).toBe(1);
  });

  it("only compacts confirmed history, preserves receipts, hashes and keyset pagination, and never reexecutes a purged key", async () => {
    const c = setup();
    c.request.arguments = ["-e", "process.stdout.write('x'.repeat(900))"];
    await c.complete();
    const original = c.journal.get("effect")!;
    expect(c.journal.compactCompletedHistory()).toBe(0);
    await confirmed(c);
    expect(c.journal.compactCompletedHistory()).toBe(1);
    const compacted = c.journal.get("effect")!;
    expect(compacted).toMatchObject({ identity: original.identity, launch: original.launch, cleanup: "unverified", events: [], lostEvents: true,
      historyRetention: { originalDigest: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    expect(c.journal.compactCompletedHistory()).toBe(0);
    expect(await new SqliteToolReceiptStore(c.sqlite).get("effect")).toMatchObject({ raw: "receipt survives" });
    await c.complete(c.node, { ...c.request, attribution: { ...c.request.attribution, idempotencyKey: "next" } });
    await confirmed(c, "next");
    const first = c.journal.history({ caseId: "case", runId: "run", limit: 1 });
    expect(first.entries).toHaveLength(1);
    expect(first.nextCursor).toBe("effect");
    expect(JSON.stringify(first)).not.toContain("repeat(900)");
    expect(c.journal.history({ caseId: "case", runId: "run", after: first.nextCursor!, limit: 1 }).entries[0].identity.idempotencyKey).toBe("next");
    expect(c.journal.history({ caseId: "other", runId: "run" }).entries).toEqual([]);
    expect(() => c.journal.history({ caseId: "case", runId: "run", limit: 101 })).toThrow("Invalid");
    c.sqlite.close();
    const reopened = getSqliteClient(createDb(c.path)); databases.add(reopened);
    const restoredJournal = new SqliteProcessExecutionJournal(reopened);
    expect(restoredJournal.get("effect")).toEqual(compacted);
    const restarted = new LocalExecutionNode(c.launcher, { ...c.options, processJournal: restoredJournal });
    await expect(restarted.startProcess(c.request)).rejects.toThrow("already claimed");
    expect(c.launches()).toBe(2);
  });

  it.each(["uncertain", "corrupt-receipt", "wrong-owner", "recent"])("does not purge history protected by %s", async (mode) => {
    const c = setup(); await c.complete(); await confirmed(c);
    if (mode === "uncertain") c.sqlite.exec("UPDATE tool_invocation_executions SET status = 'uncertain'");
    if (mode === "corrupt-receipt") c.sqlite.exec("UPDATE worker_tool_receipts SET result_json = '{}'");
    if (mode === "wrong-owner") c.sqlite.exec("UPDATE tool_invocation_bindings SET work_id = 'other'");
    if (mode === "recent") c.sqlite.prepare("UPDATE worker_tool_receipts SET created_at = ?").run(new Date().toISOString());
    const original = c.journal.get("effect");
    expect(c.journal.compactCompletedHistory()).toBe(0);
    expect(c.journal.get("effect")).toEqual(original);
  });

  it("rolls back failed compaction and leaves history plus accounting unchanged", async () => {
    const c = setup(); await c.complete(); await confirmed(c);
    const original = c.journal.get("effect"), usage = c.journal.usage();
    c.sqlite.exec("CREATE TEMP TRIGGER compact_failure BEFORE UPDATE ON execution_process_journal BEGIN SELECT RAISE(ABORT, 'compact failed'); END");
    expect(() => c.journal.compactCompletedHistory()).toThrow("compact failed");
    expect(c.journal.get("effect")).toEqual(original);
    expect(c.journal.usage()).toEqual(usage);
    await expect(c.node.startProcess({ ...c.request, attribution: { ...c.request.attribution, idempotencyKey: "new" } })).rejects.toThrow("compact failed");
    expect(c.launches()).toBe(1);
  });

  it("reserves terminal storage and refuses an oversized observation without releasing its claim", async () => {
    const c = setup(); await c.complete();
    const original = c.journal.get("effect")!;
    const journal = new SqliteProcessExecutionJournal(c.sqlite, { maximumObservationBytes: 4096 });
    const observation = { ...original, identity: { ...original.identity, idempotencyKey: "pending" },
      process: original.process ? { ...original.process, attribution: { ...original.process.attribution, idempotencyKey: "pending" } } : null };
    journal.claim({ ...observation, status: "claimed", process: null, events: [] });
    const usage = journal.usage();
    expect(() => journal.settle({ ...observation, events: [{ type: "process.failed", processId: "test", sequence: 1, at: original.updatedAt, error: "x".repeat(5000) }] }))
      .toThrow("size limit");
    expect(journal.usage()).toEqual(usage);
    expect(journal.get("pending")?.status).toBe("claimed");
  });

  it("claims a unique launch identity before dispatch and rotates generation even for the same node ID", async () => {
    const c = setup();
    const launch = c.launcher.launch.bind(c.launcher);
    const seen: unknown[] = [];
    c.launcher.launch = async (request, identity?: ProcessLaunchIdentity) => {
      expect(c.journal.get(request.attribution.idempotencyKey)?.launch).toEqual(identity);
      seen.push(identity);
      return launch(request);
    };
    await c.complete();
    const first = c.journal.get("effect")!;
    const restarted = new LocalExecutionNode(c.launcher, { ...c.options, id: first.nodeId });
    const request = { ...c.request, requestId: "second", attribution: { ...c.request.attribution, idempotencyKey: "second" } };
    const started = await restarted.startProcess(request);
    for (let i = 0; i < 20; i++) {
      const batch = await restarted.waitProcessEvents({ ...startedAccess(started), afterSequence: 0, maximumEvents: 256 }, 100);
      if (batch.process.state === "exited") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const second = c.journal.get("second")!;
    expect(second.launch?.nodeId).toBe(first.launch?.nodeId);
    expect(second.launch?.generationId).not.toBe(first.launch?.generationId);
    expect(second.launch?.launchId).not.toBe(first.launch?.launchId);
    expect(seen).toHaveLength(2);
  });

  it("cannot substitute a claim's launch identity or promote legacy observations", async () => {
    const c = setup(); await c.complete();
    const original = c.journal.get("effect")!;
    const copy = { ...original, identity: { ...original.identity, idempotencyKey: "other" },
      process: original.process ? { ...original.process, attribution: { ...original.process.attribution, idempotencyKey: "other" } } : null };
    c.journal.claim({ ...copy, status: "claimed", process: null, events: [] });
    expect(() => c.journal.settle({ ...copy, launch: { ...copy.launch!, generationId: "substitute" } })).toThrow("replace its claim");
    const legacy = { ...copy, schemaVersion: 1 as const, launch: undefined, identity: { ...copy.identity, idempotencyKey: "legacy" },
      status: "claimed" as const, process: null, events: [] };
    c.journal.claim(legacy);
    expect(c.journal.get("legacy")?.schemaVersion).toBe(1);
    expect(() => c.journal.claim({ ...legacy, launch: original.launch })).toThrow("Legacy");
  });

  it("persists watchdog failure as unverified and fences replay after database restart", async () => {
    const c = setup();
    c.request.arguments = ["-e", "setInterval(() => {}, 1000)"];
    c.request.timeoutMs = 150;
    const started = await c.node.startProcess(c.request);
    for (let i = 0; i < 10; i++) {
      const descriptor = await c.node.describeProcess(startedAccess(started));
      if (descriptor.state === "failed") break;
      await c.node.waitProcessEvents({ ...startedAccess(started), afterSequence: descriptor.lastEventSequence, maximumEvents: 256 }, 100);
    }
    const observation = await c.node.lookupProcessExecution(c.query);
    expect(observation).toMatchObject({ status: "failure_observed", cleanup: "unverified", process: { state: "failed" } });
    expect(observation?.events.at(-1)).toMatchObject({ type: "process.failed", error: "Process execution deadline exceeded" });
    c.sqlite.close();
    const reopened = getSqliteClient(createDb(c.path)); databases.add(reopened);
    const restarted = new LocalExecutionNode(c.launcher, { ...c.options, processJournal: new SqliteProcessExecutionJournal(reopened) });
    expect(await restarted.lookupProcessExecution(c.query)).toEqual(observation);
    await expect(restarted.startProcess(c.request)).rejects.toThrow();
    expect(c.launches()).toBe(1);
  });

  it("persists real process exit and output across node/database restart without claiming tree cleanup", async () => {
    const c = setup(); const started = await c.complete();
    const observed = await new ExecutionRpcDispatcher(c.node).dispatch("process.lookupExecution", c.query);
    expect(observed).toMatchObject({ status: "exit_observed", cleanup: "unverified", process: { id: started.process.id, exitCode: 0 }, lostEvents: false });
    expect(JSON.stringify(observed)).not.toContain(started.adoptionToken);
    expect(JSON.stringify(observed)).not.toContain("not-stored-in-journal");
    c.sqlite.close();
    const reopened = getSqliteClient(createDb(c.path)); databases.add(reopened);
    const restarted = new LocalExecutionNode(c.launcher, { ...c.options, processJournal: new SqliteProcessExecutionJournal(reopened) });
    expect(await restarted.lookupProcessExecution(c.query)).toEqual(observed);
    await expect(restarted.startProcess(c.request)).rejects.toThrow();
    expect(c.launches()).toBe(1);
  });

  it("rejects cross-lease lookups and returns unknown, not no-effect, for a missing request", async () => {
    const c = setup(); await c.complete();
    await expect(c.node.lookupProcessExecution({ ...c.query, leaseId: "other" })).rejects.toThrow("identity mismatch");
    expect(await c.node.lookupProcessExecution({ ...c.query, idempotencyKey: "missing" })).toBeUndefined();
  });

  it("prevents launch when the durable claim cannot be written", async () => {
    const c = setup();
    c.sqlite.exec("CREATE TEMP TRIGGER fail_claim BEFORE INSERT ON execution_process_journal BEGIN SELECT RAISE(ABORT, 'claim failed'); END");
    await expect(c.node.startProcess(c.request)).rejects.toThrow("claim failed");
    expect(c.launches()).toBe(0);
  });

  it("retains the uncertain claim when terminal persistence fails", async () => {
    const c = setup();
    c.sqlite.exec("CREATE TEMP TRIGGER fail_settle BEFORE UPDATE ON execution_process_journal BEGIN SELECT RAISE(ABORT, 'settle failed'); END");
    await c.complete();
    expect(await c.node.lookupProcessExecution(c.query)).toMatchObject({ status: "claimed", cleanup: "unverified", process: null });
    const restarted = new LocalExecutionNode(c.launcher, c.options);
    await expect(restarted.startProcess(c.request)).rejects.toThrow();
    expect(c.launches()).toBe(1);
  });

  it("reports event loss explicitly and never turns it into a complete proof", async () => {
    const c = setup(2); await c.complete();
    expect(await c.node.lookupProcessExecution(c.query)).toMatchObject({ status: "exit_observed", lostEvents: true, cleanup: "unverified" });
  });

  it("does not dispatch a second process for concurrent starts", async () => {
    const c = setup();
    const first = c.complete();
    await expect(c.node.startProcess(c.request)).rejects.toThrow("already being started");
    await first;
    expect(c.launches()).toBe(1);
  });

  it("preserves dispatch uncertainty after launcher failure and fences a new node", async () => {
    const c = setup();
    const failed = new LocalExecutionNode({ async launch() { throw new Error("dispatch response lost"); } }, c.options);
    await expect(failed.startProcess(c.request)).rejects.toThrow("response lost");
    await expect(c.node.startProcess(c.request)).rejects.toThrow();
    expect(c.launches()).toBe(0);
    expect(c.journal.get("effect")?.status).toBe("claimed");
  });

  it("fails closed on corrupted stored observations", async () => {
    const c = setup(); await c.complete();
    c.sqlite.exec("UPDATE execution_process_journal SET observation_json = '{}'");
    await expect(c.node.lookupProcessExecution(c.query)).rejects.toThrow("corrupt");
  });
});
