import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createExecutionToolRegistry, PolicyExecutionToolGateway, type WorkerAssignment } from "@traceforge/worker-runtime";
import { database, controls, uncertain, initialize, evidence, signEvidence, at } from "./test-fixtures/execution-recovery.js";
import { executionStorageStatus, reserveToolReceipt, settleNoEffectReceiptReservation, type ExecutionStorageKind } from "./db/execution-storage.js";
import { SqliteToolReceiptStore } from "./worker-execution-adapters.js";
import { recoveryEvidenceHash } from "./tool-recovery-evidence.js";
import { registerToolExecutionRecoveryRoutes } from "./tool-execution-recovery.js";
import { registerToolInvocationReconciliationRoutes } from "./tool-invocation-reconciliation.js";

const databases: Database.Database[] = [], directories: string[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function open(path?: string) { const db = database(path); databases.push(db); return db; }
const result = { status: "succeeded" as const, summary: "confirmed", raw: "preserved result", refs: [], retryable: false };
function usage(db: Database.Database, kind: ExecutionStorageKind) {
  return db.prepare("SELECT records, bytes FROM execution_storage_usage WHERE kind = ?").get(kind) as { records: number; bytes: number };
}
function entry(db: Database.Database, key: string) {
  return db.prepare("SELECT state, bytes FROM execution_storage_entries WHERE kind = 'receipt' AND entry_key = ?").get(key) as { state: string; bytes: number } | undefined;
}
function setBytes(db: Database.Database, kind: ExecutionStorageKind, bytes: number) {
  db.prepare("UPDATE execution_storage_policies SET maximum_bytes = ? WHERE kind = ?").run(bytes, kind);
}
function insert(db: Database.Database, kind: ExecutionStorageKind, key: string) {
  if (kind === "receipt") return db.prepare("INSERT INTO worker_tool_receipts VALUES (?, ?, ?)").run(key, JSON.stringify(result), at);
  if (kind === "process") return db.prepare("INSERT INTO execution_process_journal (idempotency_key, observation_json, digest, budget_bytes) VALUES (?, '{}', 'test', 100)").run(key);
  if (kind === "evidence") return db.prepare("INSERT INTO tool_recovery_evidence VALUES (?, '{}', ?)").run(key, at);
  if (kind === "command") return db.prepare("INSERT INTO tool_recovery_commands VALUES (?, 'fingerprint', 'call', '{}', ?)").run(key, at);
  if (kind === "retry") return db.prepare("INSERT INTO scenario_work_retry_audits VALUES (?, 'fingerprint', '{}')").run(key);
  return db.prepare(`INSERT INTO tool_invocation_reconciliation_audits
    VALUES (?, 'hash', 'call', 'actor', 'confirmed_no_effect', 'reason', 'hash', NULL, 'denied', 'reason', 'denied', NULL, ?)`)
    .run(key, at);
}
function command(c: ReturnType<typeof controls>) {
  return { commandId: "recover", actor: "operator", reason: "verified independently", idempotencyKey: "call",
    resolution: "confirmed_no_effect", evidence: signEvidence(evidence(c)), retry: { expectedRevision: 4 } };
}
const kinds: ExecutionStorageKind[] = ["receipt", "process", "evidence", "command", "reconciliation", "retry"];

async function crashHost(path: string, phase: string) {
  return new Promise<{ usage: { records: number; bytes: number }; entry: { state: string; bytes: number }; receipt: boolean; integrity: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../test-fixtures/execution-storage-crash-host.mjs", import.meta.url)), path, phase],
      { stdio: ["ignore", "pipe", "pipe"] });
    let output = "", errors = "", failure: Error | undefined;
    const fail = (message: string) => { failure = new Error(message); child.kill("SIGKILL"); };
    const timer = setTimeout(() => fail("Storage host deadline exceeded"), 10_000);
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
      if (output.length > 16_384) fail("Storage host output limit");
      if (phase !== "inspect" && output.includes("\n")) child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk) => { errors += String(chunk); if (errors.length > 16_384) fail("Storage host error limit"); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      if (phase === "inspect" ? code !== 0 : signal !== "SIGKILL") return reject(new Error(`Storage host failed: ${code}/${signal}: ${errors}`));
      try { resolve(JSON.parse(output)); } catch { reject(new Error("Invalid storage host output")); }
    });
  });
}

describe("Unified execution storage capacity", () => {
  it.each(["reservation", "receipt-uncommitted", "receipt-committed"])("retains exact accounting after SIGKILL at %s and two fresh-host restarts", async (phase) => {
    const root = mkdtempSync(join(tmpdir(), "traceforge-storage-kill-")); directories.push(root);
    const path = join(root, "state.sqlite");
    await crashHost(path, phase);
    const restored = await crashHost(path, "inspect");
    expect(restored.integrity).toBe("ok");
    expect(restored.usage.records).toBe(1);
    expect(restored.usage.bytes).toBe(restored.entry.bytes);
    expect(restored.receipt).toBe(phase === "receipt-committed");
    expect(restored.entry.state).toBe(phase === "receipt-committed" ? "stored" : "reserved");
    if (phase !== "receipt-committed") expect(restored.entry.bytes).toBe(8 * 1024 * 1024);
    expect(await crashHost(path, "inspect")).toEqual(restored);
  });

  it("enforces the shared execution pool across process and receipt stores and accounts for compaction", () => {
    const db = open(); insert(db, "receipt", "receipt"); const bytes = usage(db, "receipt").bytes;
    db.prepare("UPDATE execution_storage_pools SET maximum_bytes = ? WHERE id = 'execution'").run(bytes + 50);
    expect(() => insert(db, "process", "process")).toThrow("capacity exhausted");
    expect(usage(db, "process").records).toBe(0);
    db.prepare("UPDATE execution_storage_pools SET maximum_bytes = ? WHERE id = 'execution'").run(bytes + 100);
    insert(db, "process", "process");
    expect(usage(db, "process").bytes).toBe(100);
    db.exec("UPDATE execution_process_journal SET budget_bytes = 50 WHERE idempotency_key = 'process'");
    expect(usage(db, "process")).toEqual({ records: 1, bytes: 50 });
  });

  it.each(kinds)("enforces the %s byte limit at the database boundary without leaking accounting", (kind) => {
    const db = open(); setBytes(db, kind, 1);
    const before = executionStorageStatus(db);
    expect(() => insert(db, kind, "first")).toThrow("capacity exhausted");
    expect(executionStorageStatus(db)).toEqual(before);
  });

  it.each(kinds)("enforces the %s key limit and keeps the existing key", (kind) => {
    const db = open(); db.prepare("UPDATE execution_storage_policies SET maximum_records = 1 WHERE kind = ?").run(kind);
    insert(db, kind, "first");
    const before = executionStorageStatus(db);
    expect(() => insert(db, kind, "second")).toThrow("capacity exhausted");
    expect(executionStorageStatus(db)).toEqual(before);
    expect(usage(db, kind).records).toBe(1);
  });

  it("reserves receipt storage before Gateway dispatch and rolls back an unsuccessful admission", async () => {
    const db = open(), c = initialize(db); setBytes(db, "receipt", 1);
    let calls = 0;
    const registry = createExecutionToolRegistry([{ name: "observe", source: "neutral", version: "1", description: "Observe",
      inputSchema: { type: "object" }, providedCapabilities: ["observe"], dependencyCapabilities: [],
      permissionRequirements: {}, risk: "read_only", timeoutMs: 1000, priority: 1,
      async execute() { calls++; return result; } }]);
    const gateway = new PolicyExecutionToolGateway(registry, { async authorize() { return { decision: "approved" }; } }, new SqliteToolReceiptStore(db), {
      allowedRisks: ["read_only"], permissionLayers: () => [{ source: "test", profile: { version: 1, platform: "darwin",
        filesystem: { read: [], write: [], deny: [] }, network: "deny", process: { access: "deny", interactive: false, background: false }, secrets: "deny" } }],
    }, undefined, c.bindings);
    const state = c.runtime.load("run")!;
    const assignment: WorkerAssignment = { runId: "run", leaseId: "lease", leaseExpiresAt: "2099-01-01T00:00:00.000Z", runRevision: state.revision,
      runContext: { caseId: "case", goal: "Observe", scopeRef: "scope", activePhaseId: "observe", directives: [] }, work: state.workItems[0] };
    const request = { worker: { id: "worker", roles: ["observer"], capabilities: ["observe"], maxConcurrentWork: 1, status: "online" as const, heartbeatAt: at },
      assignment, idempotencyKey: "call", invocation: { id: "first", tool: "observe", input: {}, rationale: "test" } };
    await expect(gateway.execute(request)).rejects.toThrow("capacity exhausted");
    expect(calls).toBe(0);
    expect(c.bindings.execution("call")?.status).toBe("prepared");
    expect(entry(db, "call")).toBeUndefined();
    setBytes(db, "receipt", 16 * 1024 * 1024);
    const firstResult = await gateway.execute(request);
    expect(firstResult).toMatchObject(result);
    expect(await gateway.execute(request)).toEqual(firstResult);
    expect(calls).toBe(1);
    expect(entry(db, "call")?.state).toBe("stored");
  });

  it("uses a pre-existing reservation even when admission has subsequently become over capacity", async () => {
    const db = open(); reserveToolReceipt(db, "first");
    const reserved = entry(db, "first")!;
    setBytes(db, "receipt", 1);
    expect(() => reserveToolReceipt(db, "second")).toThrow("capacity exhausted");
    await new SqliteToolReceiptStore(db).put("first", result);
    expect(entry(db, "first")).toMatchObject({ state: "stored" });
    expect(entry(db, "first")!.bytes).toBeLessThan(reserved.bytes);
    expect(await new SqliteToolReceiptStore(db).get("first")).toEqual(result);
  });

  it("preserves a reservation across oversized results and storage write failures", async () => {
    const db = open(); reserveToolReceipt(db, "first"); const before = entry(db, "first");
    expect(() => reserveToolReceipt(db, "x".repeat(1025))).toThrow("key exceeds its size limit");
    await expect(new SqliteToolReceiptStore(db).put("first", { ...result, raw: "x".repeat(8 * 1024 * 1024) })).rejects.toThrow("capacity exhausted");
    db.exec("CREATE TEMP TRIGGER fail_receipt BEFORE INSERT ON worker_tool_receipts BEGIN SELECT RAISE(ABORT, 'write failed'); END");
    await expect(new SqliteToolReceiptStore(db).put("first", result)).rejects.toThrow("write failed");
    expect(entry(db, "first")).toEqual(before);
    expect(await new SqliteToolReceiptStore(db).get("first")).toBeUndefined();
    db.exec("DROP TRIGGER fail_receipt");
    await new SqliteToolReceiptStore(db).put("first", result);
    expect(usage(db, "receipt").records).toBe(1);
  });

  it.each(["command", "evidence", "reconciliation", "retry"] as const)("can resume the same recovery command after %s capacity is restored", async (kind) => {
    const db = open(), c = await uncertain(db); setBytes(db, kind, 1);
    const request = command(c);
    await expect(c.recovery.recover(request)).rejects.toThrow("capacity exhausted");
    expect(c.runtime.load("run")!.workItems).toHaveLength(1);
    expect(c.bindings.execution("call")?.status).toBe(kind === "retry" ? "completed" : "uncertain");
    setBytes(db, kind, 128 * 1024 * 1024);
    const recovered = kind === "command" ? await c.recovery.recover(request) : await c.recovery.resume("recover", "operator");
    expect(recovered.outcome).toBe("retry_queued");
    expect((await c.recovery.resume("recover", "operator")).outcome).toBe("retry_queued");
    expect(c.runtime.load("run")!.workItems).toHaveLength(2);
    expect(entry(db, "call")).toEqual({ state: "released", bytes: 0 });
    expect(c.reconciliation.listAudits("call")).toHaveLength(1);
  });

  it("does not misclassify a trusted evidence write failure as a permanent rejection", async () => {
    const db = open(), c = await uncertain(db);
    db.exec("CREATE TEMP TRIGGER fail_evidence BEFORE INSERT ON tool_recovery_evidence BEGIN SELECT RAISE(ABORT, 'disk unavailable'); END");
    await expect(c.recovery.recover(command(c))).rejects.toThrow("storage write failed");
    expect(c.reconciliation.listAudits("call")).toEqual([]);
    expect(c.bindings.execution("call")?.status).toBe("uncertain");
    expect(entry(db, "call")?.state).toBe("reserved");
    db.exec("DROP TRIGGER fail_evidence");
    expect((await c.recovery.resume("recover", "operator")).outcome).toBe("retry_queued");
  });

  it("keeps recovery capacity available when the execution pool is exhausted", async () => {
    const db = open(), c = await uncertain(db);
    db.exec("UPDATE execution_storage_pools SET maximum_bytes = 1 WHERE id = 'execution'");
    expect(() => reserveToolReceipt(db, "another")).toThrow("capacity exhausted");
    expect((await c.recovery.recover(command(c))).outcome).toBe("retry_queued");
    expect(entry(db, "call")).toEqual({ state: "released", bytes: 0 });
    expect(usage(db, "evidence").records).toBe(1);
  });

  it("rolls back receipt settlement with the reconciliation transaction if audit capacity is unavailable", async () => {
    const db = open(), c = await uncertain(db); setBytes(db, "reconciliation", 1);
    const payload = evidence(c); payload.assertion.outcome = "result_confirmed";
    payload.assertion.resultFingerprint = recoveryEvidenceHash(result); payload.assertion.cleanup.status = "not_applicable";
    const request = { ...command(c), resolution: "confirmed_result", evidence: signEvidence(payload), result, retry: undefined };
    await expect(c.recovery.recover(request)).rejects.toThrow("capacity exhausted");
    expect(await new SqliteToolReceiptStore(db).get("call")).toBeUndefined();
    expect(entry(db, "call")?.state).toBe("reserved");
    expect(c.bindings.execution("call")?.status).toBe("uncertain");
    setBytes(db, "reconciliation", 128 * 1024 * 1024);
    expect((await c.recovery.resume("recover", "operator")).outcome).toBe("reconciled");
    expect(await new SqliteToolReceiptStore(db).get("call")).toEqual(result);
    expect(c.runtime.load("run")!.workItems).toHaveLength(1);
  });

  it("does not release or delete uncertainty without the committed no-effect proof", async () => {
    const db = open(), c = await uncertain(db); const before = entry(db, "call");
    expect(() => settleNoEffectReceiptReservation(db, "call")).toThrow("committed no-effect");
    expect(() => db.exec("DELETE FROM execution_storage_entries")).toThrow("cannot be deleted");
    expect(entry(db, "call")).toEqual(before);
    await c.recovery.recover(command(c));
    await expect(new SqliteToolReceiptStore(db).put("call", result)).rejects.toThrow("fenced");
    expect(usage(db, "receipt").records).toBe(1);
  });

  it("keeps ignored duplicate evidence writes from changing accounting at full capacity", () => {
    const db = open(); insert(db, "evidence", "first"); const before = usage(db, "evidence");
    setBytes(db, "evidence", 1);
    db.prepare("INSERT OR IGNORE INTO tool_recovery_evidence VALUES ('first', ?, ?)").run("x".repeat(2000), at);
    expect(usage(db, "evidence")).toEqual(before);
    expect(() => db.exec("DELETE FROM tool_recovery_evidence")).toThrow("immutable");
  });

  it("rejects INSERT OR REPLACE without erasing the original history or its accounting", async () => {
    const db = open(); await new SqliteToolReceiptStore(db).put("first", result);
    insert(db, "evidence", "proof"); const before = executionStorageStatus(db);
    expect(() => db.prepare("INSERT OR REPLACE INTO worker_tool_receipts VALUES ('first', ?, ?)").run(JSON.stringify({ ...result, raw: "replacement" }), at)).toThrow("immutable");
    expect(() => db.prepare("INSERT OR REPLACE INTO tool_recovery_evidence VALUES ('proof', 'replacement', ?)").run(at)).toThrow("immutable");
    expect(await new SqliteToolReceiptStore(db).get("first")).toEqual(result);
    expect(executionStorageStatus(db)).toEqual(before);
  });

  it("persists reservations and capacity decisions across two complete database restarts", async () => {
    const root = mkdtempSync(join(tmpdir(), "traceforge-storage-")); directories.push(root);
    const path = join(root, "state.sqlite"); let db = open(path); await uncertain(db); setBytes(db, "receipt", 1);
    const before = executionStorageStatus(db); db.close();
    for (let i = 0; i < 2; i++) {
      db = open(path);
      expect(executionStorageStatus(db)).toEqual(before);
      expect(() => reserveToolReceipt(db, "another")).toThrow("capacity exhausted");
      expect(controls(db).bindings.execution("call")?.status).toBe("uncertain");
      db.close();
    }
  });

  it("backfills a legacy database without deleting oversized results or fabricating unused capacity", async () => {
    const root = mkdtempSync(join(tmpdir(), "traceforge-storage-migration-")); directories.push(root);
    const path = join(root, "state.sqlite"); const db = open(path); await uncertain(db);
    const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND (name LIKE 'execution_storage_%' OR name LIKE 'execution_physical_%')").all() as Array<{ name: string }>;
    for (const trigger of triggers) db.exec(`DROP TRIGGER ${trigger.name}`);
    db.exec("DROP TABLE execution_storage_entries; DROP TABLE execution_storage_usage; DROP TABLE execution_storage_policies; DROP TABLE execution_storage_pools; DROP TABLE execution_storage_migrations");
    db.prepare("INSERT INTO worker_tool_receipts VALUES ('legacy', ?, ?)").run(JSON.stringify({ ...result, raw: "x".repeat(9 * 1024 * 1024) }), at);
    db.close();
    const restored = open(path);
    expect(entry(restored, "legacy")?.state).toBe("stored");
    expect(entry(restored, "legacy")!.bytes).toBeGreaterThan(8 * 1024 * 1024);
    expect(entry(restored, "call")).toEqual({ state: "reserved", bytes: 8 * 1024 * 1024 });
    const before = executionStorageStatus(restored); restored.close();
    expect(executionStorageStatus(open(path))).toEqual(before);
  });

  it("exposes bounded, redacted command history and capacity responses", async () => {
    const db = open(), c = await uncertain(db); const app = Fastify();
    registerToolExecutionRecoveryRoutes(app, c.recovery); registerToolInvocationReconciliationRoutes(app, c.reconciliation);
    try {
      for (let i = 0; i < 3; i++) db.prepare("INSERT INTO tool_recovery_commands VALUES (?, 'hash', 'call', ?, ?)")
        .run(`command-${i}`, JSON.stringify({ secret: "not-visible-in-history" }), at);
      const page = await app.inject({ method: "GET", url: "/api/security-tools/recovery/commands?caseId=case&runId=run&limit=2" });
      expect(page.statusCode).toBe(200); expect(page.json().entries).toHaveLength(2); expect(page.json().nextCursor).toBe("command-1");
      expect(page.body).not.toContain("not-visible-in-history");
      const last = await app.inject({ method: "GET", url: "/api/security-tools/recovery/commands?caseId=case&runId=run&limit=2&after=command-1" });
      expect(last.json()).toMatchObject({ entries: [{ commandId: "command-2" }], nextCursor: null });
      expect(c.recovery.commandHistory({ caseId: "other", runId: "run" }).entries).toEqual([]);
      expect((await app.inject({ method: "GET", url: "/api/security-tools/recovery/commands?caseId=case&runId=run&limit=101" })).statusCode).toBe(400);
      expect((await app.inject({ method: "GET", url: "/api/security-tools/storage" })).json().stores).toHaveLength(7);
      for (const key of ["a", "b", "c"]) insert(db, "reconciliation", key);
      const audits = await app.inject({ method: "GET", url: "/api/security-tools/invocations/reconciliations?limit=2" });
      expect(audits.json().audits).toHaveLength(2); expect(audits.json().nextCursor).toBe("b");
      expect(c.reconciliation.auditHistory({ after: "b", limit: 2 }).audits.map((audit) => audit.commandId)).toEqual(["c"]);
      setBytes(db, "command", 1);
      const full = await app.inject({ method: "POST", url: "/api/security-tools/invocations/call/recover", payload: command(c) });
      expect(full.statusCode).toBe(507);
    } finally { await app.close(); }
  });
});
