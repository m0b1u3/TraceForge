import type Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { ProcessExecutionObservation } from "@traceforge/execution-node";
import { JsonFileCheckpointStore, type WorkerCheckpointDocument } from "@traceforge/worker-runtime";
import { ExecutionArchiveControl, registerExecutionArchiveRoutes, type ExecutionArchiveAuthorizer } from "./execution-archive-control.js";
import { archiveExecutionRow, archiveStores, readExecutionRow, type ArchiveKind } from "./db/execution-archive.js";
import { SqliteWorkerCheckpointStore } from "./worker-checkpoint-store.js";
import { SqliteToolReceiptStore } from "./worker-execution-adapters.js";
import { SqliteProcessExecutionJournal } from "./execution-process-journal.js";
import { recoveryEvidenceHash } from "./tool-recovery-evidence.js";
import { at, controls, database, evidence, signEvidence, uncertain } from "./test-fixtures/execution-recovery.js";

const dbs: Database.Database[] = []; const roots: string[] = [];
afterEach(async () => { dbs.splice(0).forEach((db) => { if (db.open) db.close(); }); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const archiveAt = "2026-08-31T01:00:00.000Z";
const allow: ExecutionArchiveAuthorizer = { async authorize() { return { decision: "allowed", authorizationRef: "test-grant", expiresAt: "2099-01-01T00:00:00.000Z" }; } };
async function fixture(path = ":memory:", includeProcess = true) {
  const db = database(path); dbs.push(db); const c = await uncertain(db);
  const result = { status: "succeeded" as const, summary: "Confirmed result", raw: "neutral observation ".repeat(2000), refs: ["evidence:first"], retryable: false };
  const payload = evidence(c); payload.assertion.outcome = "result_confirmed"; payload.assertion.cleanup.status = "not_applicable";
  payload.assertion.resultFingerprint = recoveryEvidenceHash(result);
  const proof = signEvidence(payload);
  const request = { commandId: "recover", actor: "operator", reason: "Confirm outcome", idempotencyKey: "call",
    resolution: "confirmed_result", evidence: proof, result };
  await c.recovery.recover(request);
  const retryRequest = { commandId: "retry", runId: "run", workId: "work", actor: "operator", reason: "Cannot repeat results", expectedRevision: 4 };
  await c.retry.retry(retryRequest);
  const document: WorkerCheckpointDocument = { version: 2, workerId: "worker", runId: "run", workId: "work", caseId: "case", workKey: "effect",
    leaseId: "lease", turn: 1, transcript: [{ turn: 1, kind: "tool", summary: "Observed ".repeat(500), refs: ["evidence:first"] }], steering: [],
    completedInvocationIds: ["first"], consecutiveFailures: 0, pendingInvocation: null, savedAt: at };
  const checkpoints = new SqliteWorkerCheckpointStore(db); const ref = await checkpoints.save(document);
  const observation: ProcessExecutionObservation = { schemaVersion: 1, nodeId: "node", requestFingerprint: "a".repeat(64),
    identity: { idempotencyKey: "call", requestId: "request", caseId: "case", runId: "run", workId: "work", leaseId: "lease" },
    status: "failure_observed", process: null, events: [], lostEvents: true, cleanup: "unverified", updatedAt: at };
  const body = JSON.stringify(observation);
  if (includeProcess) db.prepare("INSERT INTO execution_process_journal(idempotency_key,observation_json,digest,budget_bytes) VALUES (?, ?, ?, ?)")
    .run("call", body, createHash("sha256").update(body).digest("hex"), Buffer.byteLength(body));
  const entries: Array<{ kind: ArchiveKind; key: string }> = [
    { kind: "receipt", key: "call" }, { kind: "process", key: "call" }, { kind: "command", key: "recover" },
    { kind: "evidence", key: `recovery-evidence:${recoveryEvidenceHash(proof)}` },
    { kind: "reconciliation", key: `recovery:${recoveryEvidenceHash("recover")}:reconcile` }, { kind: "retry", key: "retry" }, { kind: "checkpoint", key: ref },
  ];
  if (!includeProcess) entries.splice(entries.findIndex((entry) => entry.kind === "process"), 1);
  const close = () => c.runtime.execute({ runId: "run", commandId: "cancel", expectedRevision: c.runtime.load("run")!.revision,
    command: { type: "cancel_run", reason: "Closed", at } });
  const input = () => ({ commandId: "archive", actor: "operator", reason: "Archive completed records", caseId: "case", runId: "run",
    expectedRevision: c.runtime.load("run")!.revision, entries });
  const control = (auth = allow) => new ExecutionArchiveControl(db, auth, () => archiveAt);
  return { ...c, db, result, proof, payload, request, retryRequest, document, checkpoints, ref, observation, entries, close, input, control };
}

describe("Controlled execution archive", () => {
  it("atomically archives all seven stores, restores original references and replays recovery without rerunning Work", async () => {
    const c = await fixture(); c.close();
    const originals = c.entries.map((entry) => readExecutionRow(c.db, entry.kind, entry.key));
    const before = c.db.prepare("SELECT sum(bytes) AS bytes FROM execution_storage_usage").get() as { bytes: number };
    const request = c.input(); expect((await c.control().archive(request)).audit.outcome).toBe("archived");
    expect((await c.control().archive(request)).replayed).toBe(true);
    expect(c.db.prepare("SELECT count(*) AS n FROM execution_archives").get()).toEqual({ n: 7 });
    expect(c.entries.map((entry) => readExecutionRow(c.db, entry.kind, entry.key))).toEqual(originals);
    expect((c.db.prepare("SELECT sum(bytes) AS bytes FROM execution_storage_usage").get() as { bytes: number }).bytes).toBeLessThan(before.bytes);
    expect(await new SqliteToolReceiptStore(c.db).get("call")).toEqual(c.result);
    expect(new SqliteProcessExecutionJournal(c.db).get("call")).toEqual(c.observation);
    expect(await c.checkpoints.load(c.ref)).toEqual(c.document);
    expect(await c.checkpoints.save(c.document)).toBe(c.ref);
    expect((await c.recovery.resume("recover", "operator")).reconciliation.replayed).toBe(true);
    expect((await c.retry.retry(c.retryRequest)).replayed).toBe(true);
    expect(c.reconciliation.listAudits()).toHaveLength(1);
    expect(c.recovery.commandHistory({ caseId: "case", runId: "run" }).entries[0]!.reconciliation).toBe("resolved");
    expect(c.runtime.load("run")!.workItems).toHaveLength(1);
    await expect(c.bindings.beginExecution("call", "lease", "worker")).rejects.toThrow("not prepared");
    expect(c.db.pragma("integrity_check", { simple: true })).toBe("ok");
  });

  it("revalidates trust rather than treating an archived evidence reference as permanent authorization", async () => {
    const c = await fixture(":memory:", false); c.close(); await c.control().archive(c.input());
    const input = { evidence: { evidenceRef: c.entries.find((entry) => entry.kind === "evidence")!.key }, resolution: "confirmed_result" as const,
      result: c.result, expectedIdentity: c.payload.assertion.identity, expectedExecutionOwnership: c.payload.assertion.executionOwnership };
    expect((await c.verifier.verify(input)).outcome).toBe("result_confirmed");
    const expired = controls(c.db, { now: () => archiveAt });
    await expect(expired.verifier.verify(input)).rejects.toThrow();
  });

  it.each(["receipt", "process", "command", "evidence", "reconciliation", "retry", "checkpoint"] as ArchiveKind[])("fences archived %s updates, replacement and key deletion", async (kind) => {
    const c = await fixture(); c.close(); const entry = c.entries.find((entry) => entry.kind === kind)!;
    await c.control().archive({ ...c.input(), entries: [entry] }); const store = archiveStores[kind];
    expect(() => c.db.prepare(`UPDATE ${store.table} SET ${store.fields[0]} = 'changed' WHERE ${store.key} = ?`).run(entry.key)).toThrow("immutable");
    expect(() => c.db.prepare(`DELETE FROM ${store.table} WHERE ${store.key} = ?`).run(entry.key)).toThrow();
    expect(() => c.db.prepare("DELETE FROM execution_storage_entries WHERE kind = ? AND entry_key = ?").run(kind, entry.key)).toThrow("cannot be deleted");
    expect(() => c.db.exec("INSERT OR REPLACE INTO execution_archives SELECT * FROM execution_archives")).toThrow("replacement");
  });

  it.each(["active", "uncertain", "missing-ledger", "retention", "wrong-case", "stale-revision", "pending-command"])("refuses %s archive without moving sources", async (mode) => {
    const c = await fixture(); if (mode !== "active") c.close();
    if (mode === "uncertain") c.db.exec("UPDATE tool_invocation_executions SET status = 'uncertain'");
    if (mode === "missing-ledger") c.db.exec("DELETE FROM tool_invocation_executions");
    const request = c.input();
    if (mode === "wrong-case") request.caseId = "other";
    if (mode === "stale-revision") request.expectedRevision = 0;
    if (mode === "pending-command") {
      const pending = { ...c.request, commandId: "pending" };
      c.db.prepare("INSERT INTO tool_recovery_commands VALUES (?, ?, ?, ?, ?)").run("pending", recoveryEvidenceHash(pending), "call", JSON.stringify(pending), at);
      request.entries = [{ kind: "command", key: "pending" }];
    }
    const control = mode === "retention" ? new ExecutionArchiveControl(c.db, allow, () => at) : c.control();
    if (mode === "wrong-case") await expect(control.archive(request)).rejects.toThrow("mismatch");
    else expect((await control.archive(request)).audit.outcome).toBe("rejected");
    expect(c.db.prepare("SELECT count(*) AS n FROM execution_archives").get()).toEqual({ n: 0 });
    expect(await new SqliteToolReceiptStore(c.db).get("call")).toEqual(c.result);
  });

  it.each(["payload", "projection", "missing"])("fails closed for %s corruption, including after restart", async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "traceforge-archive-corrupt-")); roots.push(root);
    const path = join(root, "state.db"); const c = await fixture(path); c.close(); await c.control().archive(c.input());
    // Trusted-admin test injection, not a production repair API.
    if (mode === "payload") { c.db.exec("DROP TRIGGER execution_archives_immutable_update"); c.db.exec("UPDATE execution_archives SET payload = x'00' WHERE kind = 'receipt'"); }
    if (mode === "projection") { c.db.exec("DROP TRIGGER execution_archive_receipt_fenced"); c.db.exec("UPDATE worker_tool_receipts SET created_at = 'changed'"); }
    if (mode === "missing") { c.db.exec("DROP TRIGGER execution_archives_immutable_delete"); c.db.exec("DELETE FROM execution_archives WHERE kind = 'receipt'"); }
    c.db.close(); const fresh = database(path); dbs.push(fresh);
    await expect(new SqliteToolReceiptStore(fresh).get("call")).rejects.toThrow();
  });

  it("rolls back the complete batch when the final audit cannot be written", async () => {
    const c = await fixture(); c.close(); const original = c.db.prepare("SELECT * FROM execution_storage_usage ORDER BY kind").all();
    c.db.exec(`CREATE TEMP TRIGGER fail_archive_audit BEFORE INSERT ON execution_archive_commands
      WHEN json_extract(NEW.audit_json,'$.outcome') = 'archived' BEGIN SELECT RAISE(ABORT,'injected audit failure'); END`);
    expect((await c.control().archive(c.input())).audit.outcome).toBe("rejected");
    expect(c.db.prepare("SELECT * FROM execution_storage_usage ORDER BY kind").all()).toEqual(original);
    expect(c.db.prepare("SELECT count(*) AS n FROM execution_archives").get()).toEqual({ n: 0 });
    expect(await c.checkpoints.load(c.ref)).toEqual(c.document);
  });

  it("refuses cold capacity overflow without a permanent rejection and resumes the same command", async () => {
    const c = await fixture(); c.close(); const request = c.input();
    c.db.exec("UPDATE execution_archive_policy SET maximum_bytes = 1");
    await expect(c.control().archive(request)).rejects.toThrow("capacity exhausted");
    expect(c.db.prepare("SELECT * FROM execution_archives").all()).toHaveLength(0);
    expect(c.db.prepare("SELECT * FROM execution_archive_commands").all()).toHaveLength(0);
    c.db.exec("UPDATE execution_archive_policy SET maximum_bytes = 1073741824");
    expect((await c.control().archive(request)).audit.outcome).toBe("archived");
    expect((await c.control().archive({ ...request, commandId: "again" })).audit.results.every((entry) => entry.replayed)).toBe(true);
  });

  it("keeps counters, references and fences across two database restarts", async () => {
    const root = await mkdtemp(join(tmpdir(), "traceforge-archive-restart-")); roots.push(root);
    const path = join(root, "state.db"); const c = await fixture(path); c.close(); const request = c.input(); await c.control().archive(request);
    const usage = c.db.prepare("SELECT * FROM execution_archive_usage").get(); c.db.close();
    for (let i = 0; i < 2; i++) {
      const db = database(path); dbs.push(db);
      expect(db.prepare("SELECT * FROM execution_archive_usage").get()).toEqual(usage);
      expect(await new SqliteToolReceiptStore(db).get("call")).toEqual(c.result);
      expect(await new SqliteWorkerCheckpointStore(db).load(c.ref)).toEqual(c.document);
      expect((await new ExecutionArchiveControl(db).archive(request)).replayed).toBe(true); db.close();
    }
  });

  it("bounds new checkpoint storage without writing files; old file references remain readable", async () => {
    const c = await fixture(); const root = await mkdtemp(join(tmpdir(), "traceforge-checkpoint-legacy-")); roots.push(root);
    const files = new JsonFileCheckpointStore(root); const old = { ...c.document, steering: ["legacy file"] }; const ref = await files.save(old);
    const store = new SqliteWorkerCheckpointStore(c.db, files); expect(await store.load(ref)).toEqual(old);
    c.db.exec("UPDATE execution_storage_policies SET maximum_records = 1 WHERE kind = 'checkpoint'");
    await expect(store.save({ ...c.document, steering: ["new"] })).rejects.toThrow("capacity exhausted");
    expect(await store.save(c.document)).toBe(c.ref);
    expect(c.db.prepare("SELECT count(*) AS n FROM worker_checkpoints").get()).toEqual({ n: 1 });
  });

  it("has default-denied HTTP admission and bounded redacted candidates/history", async () => {
    const c = await fixture(); c.close(); const app = Fastify(); registerExecutionArchiveRoutes(app, new ExecutionArchiveControl(c.db, undefined, () => archiveAt));
    try {
      expect((await app.inject({ method: "POST", url: "/api/security-tools/storage/archive", payload: c.input() })).statusCode).toBe(403);
      const candidates = await app.inject({ method: "GET", url: "/api/security-tools/storage/archive-candidates?caseId=case&runId=run&kind=receipt&limit=1" });
      expect(candidates.statusCode).toBe(200); expect(candidates.json().entries).toEqual([{ kind: "receipt", key: "call" }]);
      const history = await app.inject({ method: "GET", url: "/api/security-tools/storage/archives?caseId=case&runId=run&limit=1" });
      expect(history.json().entries[0].outcome).toBe("denied"); expect(history.body).not.toContain("neutral observation");
      expect((await app.inject({ method: "GET", url: "/api/security-tools/storage/archives?caseId=case&runId=run&limit=101" })).statusCode).toBe(400);
    } finally { await app.close(); }
  });

  it("requires a transaction for the host archive primitive", async () => {
    const c = await fixture(); expect(() => archiveExecutionRow(c.db, "receipt", "call", archiveAt)).toThrow("atomic");
  });
});
