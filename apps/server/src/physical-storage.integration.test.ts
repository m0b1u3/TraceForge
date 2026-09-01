import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { database, initialize, at } from "./test-fixtures/execution-recovery.js";
import { physicalStorageStatus, registerPhysicalStorageFunctions, type PhysicalSample } from "./db/physical-storage.js";
import { reserveToolReceipt } from "./db/execution-storage.js";
import { SqliteToolReceiptStore } from "./worker-execution-adapters.js";
import { SqliteWorkerCheckpointStore } from "./worker-checkpoint-store.js";

const MiB = 1024 * 1024;
const roots: string[] = [], databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) if (db.open) db.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function open(disk = false) {
  const root = disk ? realpathSync(mkdtempSync(join(tmpdir(), "traceforge-physical-"))) : undefined;
  if (root) roots.push(root);
  const db = database(root ? join(root, "state.db") : undefined); databases.push(db); return db;
}
const normal: PhysicalSample = { databaseBytes: MiB, walBytes: 0, shmBytes: 0, availableBytes: 1024 * MiB };
const result = { status: "succeeded" as const, summary: "preserved", raw: "confirmed", refs: [], retryable: false };
const document = { version: 2 as const, caseId: "case", workKey: "effect", workerId: "worker", runId: "run", workId: "work", leaseId: "lease",
  turn: 0, transcript: [], steering: [], completedInvocationIds: [], consecutiveFailures: 0, pendingInvocation: null, savedAt: at };

describe("Physical storage admission", () => {
  it("observes actual database/WAL/free pages without exposing host paths", () => {
    const db = open(true); db.exec("CREATE TABLE physical_fixture (data TEXT); INSERT INTO physical_fixture VALUES ('saved')");
    const status = physicalStorageStatus(db);
    expect(status.mode).toBe("disk"); expect(status.admission).toBe("available");
    expect(status.observation?.databaseBytes).toBeGreaterThan(0);
    expect(status.observation?.walBytes).toBeGreaterThan(0);
    expect(status.observation?.availableBytes).toBeGreaterThan(0);
    expect(JSON.stringify(status)).not.toContain(roots[0]);
  });
  it("explicitly labels memory databases unmetered", () => { expect(physicalStorageStatus(open()).mode).toBe("memory"); });
  it.each([
    ["free space", { availableBytes: 200 * MiB }], ["WAL", { walBytes: 300 * MiB }], ["database", { databaseBytes: 9 * 1024 * MiB }],
  ])("blocks new execution reservations on %s pressure without charging keys", (_name, overrides) => {
    const db = open(); registerPhysicalStorageFunctions(db, () => ({ ...normal, ...overrides }));
    expect(() => reserveToolReceipt(db, "new")).toThrow("physical storage pressure");
    expect(db.prepare("SELECT 1 FROM execution_storage_entries WHERE entry_key='new'").get()).toBeUndefined();
  });
  it("includes outstanding reservations and a write-amplification margin", () => {
    const db = open(); registerPhysicalStorageFunctions(db, () => ({ ...normal, availableBytes: 256 * MiB + 24 * MiB }));
    reserveToolReceipt(db, "first");
    expect(() => reserveToolReceipt(db, "second")).toThrow("physical storage pressure");
    expect(() => reserveToolReceipt(db, "first")).not.toThrow();
  });
  it("preserves already-reserved results when new execution is blocked", async () => {
    const db = open(); registerPhysicalStorageFunctions(db, () => normal); reserveToolReceipt(db, "first");
    registerPhysicalStorageFunctions(db, () => ({ ...normal, availableBytes: 0 }));
    await new SqliteToolReceiptStore(db).put("first", result);
    expect(await new SqliteToolReceiptStore(db).get("first")).toEqual(result);
    expect(() => reserveToolReceipt(db, "second")).toThrow("physical storage pressure");
  });
  it("leaves execution prepared when physical admission fails and resumes the same key after recovery", async () => {
    const db = open(), c = initialize(db);
    await c.bindings.prepare({ idempotencyKey: "call", invocationId: "first", tool: { name: "observe", source: "neutral", version: "1", contractFingerprint: "a".repeat(64) },
      inputFingerprint: "b".repeat(64), attribution: { caseId: "case", runId: "run", workId: "work" } });
    registerPhysicalStorageFunctions(db, () => ({ ...normal, availableBytes: 0 }));
    await expect(c.bindings.beginExecution("call", "lease", "worker")).rejects.toThrow("physical storage pressure");
    expect(c.bindings.execution("call")?.status).toBe("prepared");
    registerPhysicalStorageFunctions(db, () => normal);
    await c.bindings.beginExecution("call", "lease", "worker");
    expect(c.bindings.execution("call")?.status).toBe("executing");
  });
  it("keeps recovery headroom independent of new execution and WAL pressure", () => {
    const db = open(); registerPhysicalStorageFunctions(db, () => ({ ...normal, availableBytes: 64 * MiB, walBytes: 300 * MiB }));
    db.prepare("INSERT INTO tool_recovery_commands VALUES ('recovery', 'hash', 'call', '{}', ?)").run(at);
    expect(() => reserveToolReceipt(db, "new")).toThrow("physical storage pressure");
    registerPhysicalStorageFunctions(db, () => ({ ...normal, availableBytes: MiB }));
    expect(() => db.prepare("INSERT INTO tool_recovery_commands VALUES ('second', 'hash', 'call', '{}', ?)").run(at)).toThrow("physical storage pressure");
  });
  it("bounds new checkpoints while duplicate saves remain available", async () => {
    const db = open(), store = new SqliteWorkerCheckpointStore(db); registerPhysicalStorageFunctions(db, () => normal);
    const ref = await store.save(document);
    registerPhysicalStorageFunctions(db, () => ({ ...normal, availableBytes: 0 }));
    expect(await store.save(document)).toBe(ref);
    await expect(store.save({ ...document, turn: 1 })).rejects.toThrow("physical storage pressure");
    expect(await store.load(ref)).toEqual(document);
  });
  it.each(["throw", "negative", "nan"])("fails closed on %s probe failure", (failure) => {
    const db = open(); registerPhysicalStorageFunctions(db, () => {
      if (failure === "throw") throw new Error("host path secret");
      return { ...normal, availableBytes: failure === "nan" ? NaN : -1 };
    });
    expect(() => reserveToolReceipt(db, "new")).toThrow("observation unavailable");
  });
  it("reports a redacted unavailable state when a disk probe fails", () => {
    const db = open(true); registerPhysicalStorageFunctions(db, () => { throw new Error("private path"); });
    expect(physicalStorageStatus(db)).toMatchObject({ admission: "blocked", reason: "observation_unavailable", observation: null });
  });
  it("persists policies across two database reopens and rejects a raw SQL admission bypass", () => {
    const db = open(true), path = db.name;
    db.exec("UPDATE execution_physical_policy SET execution_floor=9000000000000000"); db.close();
    for (let i = 0; i < 2; i++) {
      const next = database(path); databases.push(next);
      expect(() => next.prepare("INSERT INTO execution_storage_entries VALUES ('receipt','raw',1,'reserved')").run()).toThrow("physical storage pressure");
      expect(physicalStorageStatus(next).admission).toBe("blocked"); next.close();
    }
  });
  it("recovers a real SQLITE_FULL result write without losing its reservation or duplicating its key", async () => {
    const db = open(true); reserveToolReceipt(db, "first");
    const pages = Number(db.pragma("page_count", { simple: true }));
    db.pragma(`max_page_count=${pages + 1}`);
    const large = { ...result, raw: "bounded output ".repeat(20000) };
    await expect(new SqliteToolReceiptStore(db).put("first", large)).rejects.toMatchObject({ code: "SQLITE_FULL" });
    expect(db.prepare("SELECT state FROM execution_storage_entries WHERE entry_key='first'").get()).toEqual({ state: "reserved" });
    expect(await new SqliteToolReceiptStore(db).get("first")).toBeUndefined();
    db.pragma(`max_page_count=${pages + 1000}`);
    await new SqliteToolReceiptStore(db).put("first", large);
    expect(await new SqliteToolReceiptStore(db).get("first")).toEqual(large);
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
  });
});
