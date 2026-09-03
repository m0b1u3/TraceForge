import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProcessOperationObservation } from "@traceforge/execution-node";
import { canonicalJson } from "@traceforge/orchestration-core";
import { database } from "./test-fixtures/execution-recovery.js";
import { SqliteProcessOperationJournal } from "./execution-process-operation-journal.js";
import { processOperationJournalHealth } from "./execution-node-service.js";

const archiveCrashFixture = join(import.meta.dirname, "../test-fixtures/execution-process-operation-archive-crash-host.mjs");
const children = new Set<ChildProcessWithoutNullStreams>();

const roots: string[] = [];
afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await new Promise<void>((resolve) => child.once("close", () => resolve()));
    }
  }
  children.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const claim: ProcessOperationObservation = {
  schemaVersion: 1,
  identity: { operationId: "operation-1", operation: "process.writeInput", processId: "process-1", requestFingerprint: "a".repeat(64) },
  nodeId: "node-1", state: "claimed", response: null, updatedAt: "2026-09-02T01:00:00.000Z",
};

describe("durable Execution Node process operation journal", () => {
  it("does not create retired remote Execution Node tables in a new database", () => {
    const sqlite = database();
    const tables = sqlite.prepare(`SELECT name FROM sqlite_master
      WHERE type='table' AND name LIKE 'remote_execution_%' ORDER BY name`).all();
    expect(tables).toEqual([]);
    sqlite.close();
  });

  it("persists claims and completed replay results across a full database reopen", () => {
    const root = mkdtempSync(join(tmpdir(), "traceforge-operation-journal-")); roots.push(root);
    const path = join(root, "state.db"); let sqlite = database(path); let journal = new SqliteProcessOperationJournal(sqlite);
    journal.claim(claim); sqlite.close();
    sqlite = database(path); journal = new SqliteProcessOperationJournal(sqlite);
    expect(journal.get("operation-1")).toEqual(claim);
    const completed: ProcessOperationObservation = { ...claim, state: "completed", updatedAt: "2026-09-02T01:00:01.000Z",
      response: { id: "process-1", marker: "saved-response" } as never };
    journal.complete(completed); sqlite.close();
    sqlite = database(path); journal = new SqliteProcessOperationJournal(sqlite);
    expect(journal.get("operation-1")).toEqual(completed);
    expect(() => journal.claim({ ...claim, identity: { ...claim.identity, requestFingerprint: "b".repeat(64) } })).toThrow();
    sqlite.close();
  });

  it("leaves an interrupted claim uncertain instead of authorizing redispatch", () => {
    const sqlite = database(); const journal = new SqliteProcessOperationJournal(sqlite);
    journal.claim(claim);
    expect(journal.get("operation-1")).toMatchObject({ state: "claimed", response: null });
    expect(() => journal.complete({ ...claim, identity: { ...claim.identity, processId: "other" }, state: "completed",
      response: { id: "other" } as never })).toThrow(/cannot replace/);
    sqlite.close();
  });

  it("compresses retained completions, replays the exact response after reopen, and never compacts uncertain claims", () => {
    const root = mkdtempSync(join(tmpdir(), "traceforge-operation-archive-")); roots.push(root);
    const path = join(root, "state.db"); let sqlite = database(path);
    const limits = { completedRetentionMs: 1_000, compactionBatchSize: 8 };
    let journal = new SqliteProcessOperationJournal(sqlite, limits, () => "2026-09-02T01:00:00.000Z");
    journal.claim(claim);
    const completed: ProcessOperationObservation = { ...claim, state: "completed", updatedAt: "2026-09-02T01:00:01.000Z",
      response: { id: "process-1", marker: "saved-response", padding: "x".repeat(8_192) } as never };
    journal.complete(completed);
    journal.claim({ ...claim, identity: { ...claim.identity, operationId: "operation-uncertain" }, updatedAt: "2026-09-02T01:00:01.000Z" });
    expect(journal.compactCompletedHistory()).toBe(0);
    sqlite.close();

    sqlite = database(path);
    journal = new SqliteProcessOperationJournal(sqlite, limits, () => "2026-09-02T01:00:03.000Z");
    const stored = sqlite.prepare(`SELECT response_json,archived_response,response_original_bytes,response_compressed_bytes
      FROM execution_process_operations WHERE operation_id='operation-1'`).get() as {
        response_json: string | null; archived_response: Buffer; response_original_bytes: number; response_compressed_bytes: number;
      };
    expect(stored.response_json).toBeNull();
    expect(Buffer.isBuffer(stored.archived_response)).toBe(true);
    expect(stored.response_compressed_bytes).toBe(stored.archived_response.length);
    expect(stored.response_compressed_bytes).toBeLessThan(stored.response_original_bytes);
    expect(journal.get("operation-1")).toEqual(completed);
    expect(journal.get("operation-uncertain")).toMatchObject({ state: "claimed", response: null });
    expect(journal.usage()).toMatchObject({ records: 2, activeRecords: 1, archivedRecords: 1, uncertainRecords: 1 });
    expect(journal.compactCompletedHistory()).toBe(0);
    sqlite.close();
  });

  it("reclaims active capacity with transparent archives but keeps total and uncertain fences bounded", () => {
    const sqlite = database();
    const journal = new SqliteProcessOperationJournal(sqlite, {
      maximumActiveRecords: 1, maximumRecords: 3, maximumBytes: 1024 * 1024, maximumRecordBytes: 64 * 1024,
      completedRetentionMs: 0, compactionBatchSize: 8,
    }, () => "2026-09-02T01:00:02.000Z");
    journal.claim(claim);
    journal.complete({ ...claim, state: "completed", updatedAt: "2026-09-02T01:00:01.000Z",
      response: { id: "process-1", marker: "saved-response" } as never });
    const second = { ...claim, identity: { ...claim.identity, operationId: "operation-2" }, updatedAt: "2026-09-02T01:00:02.000Z" };
    journal.claim(second);
    expect(journal.usage()).toMatchObject({ records: 2, activeRecords: 1, archivedRecords: 1, uncertainRecords: 1 });
    expect(() => journal.claim({ ...second, identity: { ...second.identity, operationId: "operation-3" } })).toThrow(/capacity exhausted/);
    expect(journal.get("operation-1")).toMatchObject({ state: "completed", response: { marker: "saved-response" } });
    expect(processOperationJournalHealth(journal.usage())).toMatchObject({ state: "capacity_exhausted", activeRecords: 1,
      archivedRecords: 1, uncertainRecords: 1 });
    sqlite.close();
  });

  it.each(["before-commit", "after-commit"] as const)("survives SIGKILL %s while archiving a completed response", async (fault) => {
    const root = mkdtempSync(join(tmpdir(), "traceforge-operation-archive-crash-")); roots.push(root);
    const path = join(root, "state.db"); const configPath = join(root, "config.json");
    let sqlite = database(path);
    let journal = new SqliteProcessOperationJournal(sqlite, { completedRetentionMs: 1_000 }, () => "2026-09-02T01:00:00.000Z");
    journal.claim(claim);
    const completed: ProcessOperationObservation = { ...claim, state: "completed", updatedAt: "2026-09-02T01:00:01.000Z",
      response: { id: "process-1", marker: "saved-response", padding: "x".repeat(8_192) } as never };
    journal.complete(completed); sqlite.close();
    writeFileSync(configPath, JSON.stringify({ databasePath: path, fault }));

    const child = spawn(process.execPath, ["--import", "tsx", archiveCrashFixture, configPath], { stdio: ["pipe", "pipe", "pipe"] });
    children.add(child);
    const checkpoint = await new Promise<string>((resolve, reject) => {
      let stdout = "", stderr = "";
      child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.stdout.setEncoding("utf8"); child.stdout.on("data", (chunk) => {
        stdout += chunk;
        const newline = stdout.indexOf("\n");
        if (newline >= 0) resolve((JSON.parse(stdout.slice(0, newline)) as { checkpoint: string }).checkpoint);
      });
      child.once("close", () => reject(new Error(`Archive crash fixture exited early: ${stderr}`)));
      setTimeout(() => reject(new Error(`Archive crash fixture timed out: ${stderr}`)), 10_000).unref();
    });
    expect(checkpoint).toBe(fault);
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("close", () => resolve()));

    sqlite = database(path);
    const row = sqlite.prepare("SELECT response_json,archived_response,archived_at FROM execution_process_operations WHERE operation_id=?")
      .get(claim.identity.operationId) as { response_json: string | null; archived_response: Buffer | null; archived_at: string | null };
    if (fault === "before-commit") {
      expect(row.response_json).not.toBeNull(); expect(row.archived_response).toBeNull(); expect(row.archived_at).toBeNull();
    } else {
      expect(row.response_json).toBeNull(); expect(Buffer.isBuffer(row.archived_response)).toBe(true); expect(row.archived_at).not.toBeNull();
    }
    journal = new SqliteProcessOperationJournal(sqlite, { completedRetentionMs: 1_000 }, () => "2026-09-02T01:00:01.000Z");
    expect(journal.get(claim.identity.operationId)).toEqual(completed);
    expect(sqlite.pragma("integrity_check", { simple: true })).toBe("ok");
    sqlite.close();
  });

  it("migrates legacy rows without changing their identity and rejects a damaged compressed response", () => {
    const sqlite = database();
    sqlite.exec(`CREATE TABLE execution_process_operations (
      operation_id TEXT PRIMARY KEY, identity_json TEXT NOT NULL, node_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('claimed','completed')), response_json TEXT,
      digest TEXT NOT NULL, budget_bytes INTEGER NOT NULL CHECK(budget_bytes>0), updated_at TEXT NOT NULL)`);
    const serialized = canonicalJson(claim);
    sqlite.prepare(`INSERT INTO execution_process_operations
      (operation_id,identity_json,node_id,state,response_json,digest,budget_bytes,updated_at) VALUES (?,?,?,'claimed',NULL,?,?,?)`)
      .run(claim.identity.operationId, canonicalJson(claim.identity), claim.nodeId,
        createHash("sha256").update(serialized).digest("hex"), 512 * 1024, claim.updatedAt);
    const journal = new SqliteProcessOperationJournal(sqlite, { completedRetentionMs: 0 }, () => "2026-09-02T01:00:02.000Z");
    expect(journal.get("operation-1")).toEqual(claim);
    const completed: ProcessOperationObservation = { ...claim, state: "completed", updatedAt: "2026-09-02T01:00:01.000Z",
      response: { id: "process-1", marker: "saved-response" } as never };
    journal.complete(completed);
    expect(journal.compactCompletedHistory()).toBe(1);
    sqlite.exec("DROP TRIGGER execution_process_operation_identity_immutable");
    sqlite.prepare("UPDATE execution_process_operations SET archived_response=? WHERE operation_id=?")
      .run(Buffer.from("damaged"), claim.identity.operationId);
    expect(() => journal.get("operation-1")).toThrow(/response.*corrupt/i);
    sqlite.close();
  });
});
