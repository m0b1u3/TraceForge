import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { database, initialize, at } from "./test-fixtures/execution-recovery.js";
import { StorageMaintenanceControl, registerStorageMaintenanceRoutes, type StorageMaintenanceAuthorizer } from "./storage-maintenance.js";
import { SqliteWorkerCheckpointStore } from "./worker-checkpoint-store.js";
import { registerPhysicalStorageFunctions } from "./db/physical-storage.js";

const roots: string[] = [], databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) if (db.open) db.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const grant: StorageMaintenanceAuthorizer = { async authorize() { return { decision: "allowed", authorizationRef: "test-only", expiresAt: "2099-01-01T00:00:00.000Z" }; } };
const now = () => "2026-09-02T00:00:00.000Z";
function setup(active = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "traceforge-maintenance-"))); roots.push(root);
  const db = database(join(root, "state.db")); databases.push(db);
  const c = initialize(db);
  if (!active) c.runtime.execute({ runId: "run", commandId: "close", expectedRevision: c.runtime.load("run")!.revision,
    command: { type: "cancel_run", reason: "finished", at } });
  const files = join(root, "checkpoints"); mkdirSync(files);
  const document = { version: 2, caseId: "case", workKey: "effect", workerId: "worker", runId: "run", workId: "work", leaseId: "lease",
    turn: 0, transcript: [], steering: [], completedInvocationIds: [], consecutiveFailures: 0, pendingInvocation: null, savedAt: at };
  const body = JSON.stringify(document), digest = createHash("sha256").update(body).digest("hex"), name = `sha256-${digest}.json`, path = join(files, name);
  writeFileSync(path, body); utimesSync(path, new Date(at), new Date(at));
  const input = { action: "migrate_checkpoint" as const, commandId: "migrate", actor: "operator", reason: "Consolidate storage", name, digest, retireSource: true };
  return { root, files, db, document, body, path, name, input, control: new StorageMaintenanceControl(db, files, grant, now) };
}
const wal = { action: "checkpoint_wal" as const, commandId: "checkpoint", actor: "operator", reason: "Release WAL", mode: "TRUNCATE" as const };

describe("Authorized storage maintenance", () => {
  it("migrates and retires the exact legacy file while preserving original ref through two restarts", async () => {
    const f = setup(), ref = `checkpoint://${f.name}`;
    expect((await f.control.execute(f.input)).phase).toBe("completed");
    expect(existsSync(f.path)).toBe(false);
    expect(await new SqliteWorkerCheckpointStore(f.db).load(ref)).toEqual(f.document);
    expect((await f.control.execute(f.input)).replayed).toBe(true);
    const path = f.db.name; f.db.close();
    for (let i = 0; i < 2; i++) {
      const next = database(path); databases.push(next);
      expect(await new SqliteWorkerCheckpointStore(next).load(ref)).toEqual(f.document);
      expect((await new StorageMaintenanceControl(next, f.files).execute(f.input)).replayed).toBe(true); next.close();
    }
  });
  it("can import without removing a source and later explicitly retire it", async () => {
    const f = setup(true);
    await f.control.execute({ ...f.input, retireSource: false });
    expect(existsSync(f.path)).toBe(true);
    await expect(f.control.execute({ ...f.input, commandId: "retire" })).rejects.toThrow("Active Work leases");
  });
  it("imports a complete orphan temporary snapshot before retiring it, but retains incomplete temporary data", async () => {
    const f = setup(); const suffix = ".12345678-1234-1234-1234-123456789abc.tmp", name = f.name + suffix;
    const path = join(f.files, name); writeFileSync(path, f.body); utimesSync(path, new Date(at), new Date(at));
    expect((await f.control.execute({ ...f.input, name })).result).toMatchObject({ ref: `checkpoint://${f.name}`, sourceRetired: true });
    expect(existsSync(path)).toBe(false);
    const incomplete = f.name + ".12345678-1234-1234-1234-123456789abd.tmp";
    writeFileSync(join(f.files, incomplete), f.body.slice(0, 30)); utimesSync(join(f.files, incomplete), new Date(at), new Date(at));
    await expect(f.control.execute({ ...f.input, commandId: "incomplete", name: incomplete })).rejects.toThrow("digest mismatch");
    expect(existsSync(join(f.files, incomplete))).toBe(true);
  });
  it.each(["capacity", "physical", "audit"])("keeps the original file and rolls back import on %s failure", async (kind) => {
    const f = setup();
    if (kind === "capacity") f.db.exec("UPDATE execution_storage_policies SET maximum_bytes=1 WHERE kind='checkpoint'");
    if (kind === "physical") registerPhysicalStorageFunctions(f.db, () => ({ databaseBytes: 0, walBytes: 0, shmBytes: 0, availableBytes: 0 }));
    if (kind === "audit") f.db.exec("CREATE TEMP TRIGGER fail_import BEFORE UPDATE ON storage_maintenance_commands WHEN NEW.phase='imported' BEGIN SELECT RAISE(ABORT,'test write failure'); END");
    await expect(f.control.execute(f.input)).rejects.toThrow();
    expect(existsSync(f.path)).toBe(true);
    expect(f.db.prepare("SELECT count(*) AS n FROM worker_checkpoints").get()).toEqual({ n: 0 });
    expect(f.control.history({}).entries[0]?.phase).toBe("prepared");
    if (kind === "capacity") f.db.exec("UPDATE execution_storage_policies SET maximum_bytes=536870912 WHERE kind='checkpoint'");
    if (kind === "physical") registerPhysicalStorageFunctions(f.db, () => ({ databaseBytes: 0, walBytes: 0, shmBytes: 0, availableBytes: 1024 ** 3 }));
    if (kind === "audit") f.db.exec("DROP TRIGGER fail_import");
    expect((await f.control.execute(f.input)).phase).toBe("completed");
  });
  it("retains a durable imported phase when final audit fails after unlink and resumes safely", async () => {
    const f = setup();
    f.db.exec("CREATE TEMP TRIGGER fail_finish BEFORE UPDATE ON storage_maintenance_commands WHEN NEW.phase='completed' BEGIN SELECT RAISE(ABORT,'finish failed'); END");
    await expect(f.control.execute(f.input)).rejects.toThrow("finish failed");
    expect(existsSync(f.path)).toBe(false); expect(f.control.history({}).entries[0]?.phase).toBe("imported");
    expect(await new SqliteWorkerCheckpointStore(f.db).load(`checkpoint://${f.name}`)).toEqual(f.document);
    f.db.exec("DROP TRIGGER fail_finish"); expect((await f.control.execute(f.input)).phase).toBe("completed");
  });
  it("requires current authorization for pending commands and rejects conflicting requests", async () => {
    const f = setup(); f.db.exec("UPDATE execution_storage_policies SET maximum_bytes=1 WHERE kind='checkpoint'");
    await expect(f.control.execute(f.input)).rejects.toThrow("capacity");
    await expect(new StorageMaintenanceControl(f.db, f.files).execute(f.input)).rejects.toThrow("authorization");
    await expect(f.control.execute({ ...f.input, reason: "changed" })).rejects.toThrow("conflict");
    expect(existsSync(f.path)).toBe(true);
  });
  it.each(["default", "expired", "throw", "malformed"])("fails closed for %s authorization", async (kind) => {
    const f = setup();
    const authorizer = kind === "default" ? undefined : { async authorize() {
      if (kind === "throw") throw new Error("unavailable");
      return { decision: "allowed", authorizationRef: kind === "malformed" ? "" : "grant", expiresAt: "2020-01-01T00:00:00.000Z" };
    } } as StorageMaintenanceAuthorizer;
    await expect(new StorageMaintenanceControl(f.db, f.files, authorizer, now).execute(f.input)).rejects.toThrow("authorization");
    expect(f.control.history({}).entries).toEqual([]); expect(existsSync(f.path)).toBe(true);
  });
  it.each(["symlink", "hardlink", "digest", "recent", "root", "traversal"])("refuses %s source retirement", async (kind) => {
    const f = setup(); let control = f.control; let input = f.input;
    if (kind === "symlink") { const target = join(f.root, "outside.json"); writeFileSync(target, f.body); rmSync(f.path); symlinkSync(target, f.path); }
    if (kind === "hardlink") linkSync(f.path, join(f.root, "second-link"));
    if (kind === "digest") writeFileSync(f.path, "{}");
    if (kind === "recent") utimesSync(f.path, new Date(now()), new Date(now()));
    if (kind === "root") { const linked = join(f.root, "linked"); symlinkSync(f.files, linked); control = new StorageMaintenanceControl(f.db, linked, grant, now); }
    if (kind === "traversal") input = { ...input, name: `../${f.name}` };
    await expect(control.execute(input)).rejects.toThrow(); expect(existsSync(f.path)).toBe(true);
  });
  it("bounds inventory, flags unsupported files and never treats it as deletion authority", () => {
    const f = setup(); writeFileSync(join(f.files, "old.json.tmp"), "incomplete");
    mkdirSync(join(f.files, "worker")); writeFileSync(join(f.files, "worker", "legacy.json"), "{}");
    symlinkSync(f.root, join(f.files, "linked"));
    const inventory = f.control.inventory(); expect(inventory.complete).toBe(true);
    expect(inventory.entries.map((e) => e.kind)).toEqual(expect.arrayContaining(["immutable_checkpoint", "unverified_temporary", "legacy_or_unknown", "symlink_refused"]));
    for (let i = 0; i < 2010; i++) writeFileSync(join(f.files, `unknown-${i}`), "x");
    expect(f.control.inventory()).toMatchObject({ complete: false, scanned: 2000 });
  });
  it("bounds and fences maintenance audit identities", async () => {
    const f = setup(); await f.control.execute({ ...f.input, retireSource: false });
    expect(() => f.db.exec("DELETE FROM storage_maintenance_commands")).toThrow("cannot be deleted");
    expect(() => f.db.exec("UPDATE storage_maintenance_commands SET phase='prepared'")).toThrow("immutable");
    expect(() => f.db.exec("INSERT OR REPLACE INTO storage_maintenance_commands SELECT * FROM storage_maintenance_commands")).toThrow("replacement");
  });
  it("releases actual WAL pressure with bounded explicit maintenance, never VACUUM", async () => {
    const f = setup(); f.db.pragma("wal_autocheckpoint=0");
    f.db.exec("CREATE TABLE wal_fixture (data BLOB); INSERT INTO wal_fixture VALUES (randomblob(262144))");
    f.db.exec("UPDATE execution_physical_policy SET maximum_wal_bytes=1");
    expect(f.control.status().admission).toBe("blocked");
    const result = await f.control.execute(wal); expect(result.phase).toBe("completed");
    expect(result.result).toMatchObject({ busy: 0, log: 0 });
    expect((await f.control.execute(wal)).replayed).toBe(true);
    // The final audit itself appends a small WAL transaction; no zero-size promise is made.
    expect(f.control.status().observation?.walBytes).toBeLessThan(262144);
  });
  it("does not claim WAL maintenance succeeded while a reader pins the log; resumes the same intent", async () => {
    const f = setup(); await f.control.execute({ ...wal, commandId: "initial" });
    const reader = database(f.db.name); databases.push(reader);
    reader.exec("BEGIN"); reader.prepare("SELECT * FROM cases").all();
    f.db.exec("CREATE TABLE pinned_wal (data BLOB); INSERT INTO pinned_wal VALUES (randomblob(65536))");
    await expect(f.control.execute(wal)).rejects.toThrow("active readers");
    expect(f.control.history({}).entries.find((r) => r.commandId === "checkpoint")?.phase).toBe("prepared");
    reader.exec("ROLLBACK"); expect((await f.control.execute(wal)).phase).toBe("completed");
  });
  it("provides redacted status/history and default-denied HTTP controls", async () => {
    const f = setup(); const app = Fastify(); registerStorageMaintenanceRoutes(app, new StorageMaintenanceControl(f.db, f.files));
    try {
      expect((await app.inject({ method: "POST", url: "/api/security-tools/storage/maintenance", payload: f.input })).statusCode).toBe(403);
      const status = await app.inject("/api/security-tools/storage/physical"); expect(status.statusCode).toBe(200); expect(status.body).not.toContain(f.root);
      expect((await app.inject("/api/security-tools/storage/maintenance?limit=101")).statusCode).toBe(400);
      expect((await app.inject("/api/security-tools/storage/legacy-checkpoints")).json().entries[0].ref).toBe(`checkpoint://${f.name}`);
    } finally { await app.close(); }
  });
});
