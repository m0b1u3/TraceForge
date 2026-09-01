import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Fastify from "fastify";
import Database from "better-sqlite3";
import { createDb, getSqliteClient } from "./db/client.js";
import { FoundationBackupControl, type FoundationBackupOptions, type FoundationBackupAuthorizer } from "./foundation-backup.js";
import { migrationFixture } from "./test-fixtures/run-migration.js";
import { ScenarioHistoryControl } from "./scenario-history-control.js";
import { readRunForensics } from "./scenario-run-disposal.js";
import { readFoundationRestoreFence } from "./db/foundation-restore-fence.js";
import { registerSecurityAgentFoundation } from "./security-agent-foundation.js";
import { foundationHostControl } from "./foundation-host-control.js";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { foundationHost } from "./test-fixtures/foundation-host.js";

const roots: string[] = [], dbs: Database.Database[] = [], apps: ReturnType<typeof Fastify>[] = [];
const grant: FoundationBackupAuthorizer = { async authorize() { return { decision: "allowed", authorizationRef: "explicit-host-review", expiresAt: "2099-01-01T00:00:00.000Z" }; } };
const request = (commandId = "backup1") => ({ commandId, operation: "backup" as const, actor: "operator", reason: "Disaster recovery rehearsal" });
const restore = (manifestDigest: string, commandId = "restore1") => ({ ...request(commandId), operation: "restore" as const, backupId: "backup1", manifestDigest });
const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
afterEach(async () => {
  vi.restoreAllMocks();
  for (const app of apps.splice(0)) await app.close();
  for (const db of dbs.splice(0)) if (db.open) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(options: Partial<FoundationBackupOptions> = {}) {
  const root = mkdtempSync("/private/tmp/traceforge-backup-"); roots.push(root);
  const sqlite = getSqliteClient(createDb(join(root, "source.sqlite"))); dbs.push(sqlite);
  const f = migrationFixture(sqlite);
  const config = { backupRoot: join(root, "backups"), restoreRoot: join(root, "restores"), authorizer: grant, ...options };
  const control = new FoundationBackupControl(sqlite, config);
  return { ...f, root, sqlite, control, config };
}
async function archivedFixture() {
  const f = fixture();
  const history = new ScenarioHistoryControl(f.sqlite, { authorize: () => grant.authorize(request()) });
  const input = { caseId: "case", runId: "run", expectedRevision: 4, throughRevision: 4 };
  await history.archive({ ...input, commandId: "archive", actor: "operator", reason: "cold history", planFingerprint: history.preview(input).planFingerprint });
  return f;
}

describe("Foundation consistent backups and permanently fenced isolated restore", () => {
  it("includes committed WAL and cold original history, but not keys or execution permission", async () => {
    const f = await archivedFixture(), before = readRunForensics(f.sqlite, "run");
    f.sqlite.pragma("wal_autocheckpoint=0");
    f.sqlite.prepare("INSERT INTO encrypted_secret_entries VALUES (?,?,?,?,?,?)").run("secret", Buffer.alloc(12), Buffer.from("opaque-ciphertext"), Buffer.alloc(16), "now", "now");
    const saved = await f.control.execute(request()), verified = f.control.verify("backup1", saved.manifestDigest);
    expect(verified.manifest.dependencies).toHaveLength(5); expect(verified.executionReady).toBe(false);
    expect(readdirSync(join(f.config.backupRoot, "backup1"))).toEqual(expect.arrayContaining(["database.sqlite", "manifest.json", "READY", "BACKUP_ONLY"]));
    const restored = await f.control.execute(restore(saved.manifestDigest));
    expect(restored.executionReady).toBe(false);
    const copy = getSqliteClient(createDb(join(f.config.restoreRoot, "restore1", "database.sqlite"))); dbs.push(copy);
    expect(copy.readonly).toBe(true); expect(readRunForensics(copy, "run")).toEqual(before);
    expect(copy.prepare("SELECT ciphertext FROM encrypted_secret_entries WHERE ref='secret'").get()).toEqual({ ciphertext: Buffer.from("opaque-ciphertext") });
    expect(readFoundationRestoreFence(copy)?.mode).toBe("inspection_only");
    expect(() => copy.prepare("UPDATE scenario_event_streams SET status='running'").run()).toThrow();
    expect(() => copy.exec("DELETE FROM foundation_restore_fence")).toThrow();
    expect(() => createDb(join(f.config.backupRoot, "backup1", "database.sqlite"))).toThrow("not a bootable host");
    expect(readRunForensics(f.sqlite, "run")).toEqual(before);
  });

  it("copies only explicitly host-selected immutable attachments and reports incomplete external coverage", async () => {
    const f = fixture(), path = join(f.root, "attachment"); writeFileSync(path, "reviewed neutral resource");
    const control = new FoundationBackupControl(f.sqlite, { ...f.config, assets: [{ id: "resource", path, sha256: sha(readFileSync(path)) }] });
    const saved = await control.execute(request());
    expect(control.verify("backup1", saved.manifestDigest).manifest.assets).toEqual([{ id: "resource", sha256: sha(readFileSync(path)), bytes: 25 }]);
    await control.execute(restore(saved.manifestDigest));
    expect(readFileSync(join(f.config.restoreRoot, "restore1", "asset-resource"), "utf8")).toBe("reviewed neutral resource");
  });

  it.each([undefined, { async authorize() { return { decision: "denied" as const }; } },
    { async authorize() { return { decision: "allowed" as const, authorizationRef: "expired", expiresAt: "2000-01-01T00:00:00Z" }; } }])("requires independent unexpired authorization", async authorizer => {
    const f = fixture({ authorizer }); await expect(f.control.execute(request())).rejects.toThrow("authorization");
    expect(readdirSync(f.config.backupRoot)).toEqual([]); expect(f.control.audit("backup1")).toEqual([]);
  });
  it.each([{ commandId: "../escape" }, { destination: "/tmp/other" }, { backupId: "unexpected" }, { manifestDigest: "a".repeat(64) }])("rejects path injection and ambiguous backup requests %j", async overrides => {
    const f = fixture(); await expect(f.control.execute({ ...request(), ...overrides })).rejects.toThrow(); expect(readdirSync(f.config.backupRoot)).toEqual([]);
  });
  it("restores from a surviving backup with a fresh control database and no original runtime", async () => {
    const f = await archivedFixture(), saved = await f.control.execute(request()); f.sqlite.close();
    const fresh = getSqliteClient(createDb(join(f.root, "new-control.sqlite"))); dbs.push(fresh);
    const control = new FoundationBackupControl(fresh, f.config);
    await control.execute(restore(saved.manifestDigest));
    const path = join(f.config.restoreRoot, "restore1", "database.sqlite"), before = sha(readFileSync(path));
    const copy = getSqliteClient(createDb(path)); dbs.push(copy);
    const app = Fastify(); apps.push(app);
    registerSecurityAgentFoundation(app, copy, {} as never, join(f.root, "new-host"), () => { throw new Error("model reached"); });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const management = foundationHostControl(app).management();
    const address = app.server.address() as { port: number };
    const response = await management.fetch(`http://127.0.0.1:${address.port}/api/foundation/recovery/runs/run/state?caseId=case`);
    expect(response.status).toBe(200); expect((await response.json() as { revision: number }).revision).toBe(4);
    expect(existsSync(join(f.root, "new-host", "data", "secrets", "vault.key"))).toBe(false);
    expect(sha(readFileSync(path))).toBe(before);
  });
  it("installs only guarded forensic routes in the standalone foundation, without invoking factories or models", async () => {
    const f = fixture(), saved = await f.control.execute(request()); await f.control.execute(restore(saved.manifestDigest));
    const copy = getSqliteClient(createDb(join(f.config.restoreRoot, "restore1", "database.sqlite"))); dbs.push(copy);
    const app = Fastify(); apps.push(app); const forbidden = vi.fn(() => { throw new Error("execution reached"); });
    registerSecurityAgentFoundation(app, copy, { generate: forbidden } as never, join(f.root, "fresh"), forbidden, { governedToolProviderFactory: forbidden });
    const headers = foundationHostControl(app).management().headers();
    expect((await app.inject({ url: "/api/foundation/recovery" })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/foundation/recovery", headers })).json()).toMatchObject({ mode: "inspection_only", automaticResume: false });
    expect((await app.inject({ url: "/api/foundation/recovery/runs/run/events?caseId=case", headers })).json()).toHaveLength(4);
    expect((await app.inject({ url: "/api/foundation/recovery/runs/run/state?caseId=other", headers })).statusCode).toBe(409);
    for (const url of ["/api/scenarios/runs", "/api/foundation/backups/execute", "/api/cases", "/api/scenarios/workers"]) {
      expect((await app.inject({ url, method: "POST", headers, payload: {} })).statusCode).toBe(404);
    }
    expect(forbidden).not.toHaveBeenCalled();
  });
  it("retains unknown occupancies and active leases byte-for-byte rather than replaying startup recovery", async () => {
    const f = fixture();
    f.sqlite.prepare("INSERT INTO process_execution_occupancy VALUES (?,?,?,'unknown',NULL,NULL,?)").run("external", "effect-unknown", JSON.stringify({ attribution: { caseId: "case", runId: "run" } }), "now");
    f.sqlite.prepare("INSERT INTO process_execution_occupancy VALUES (?,?,?,'reserved',NULL,NULL,?)").run("reserved", "effect-reserved", JSON.stringify({ attribution: { caseId: "case", runId: "run" } }), "now");
    const before = f.sqlite.prepare("SELECT * FROM scenario_work_leases").all(), saved = await f.control.execute(request());
    await f.control.execute(restore(saved.manifestDigest));
    const copy = getSqliteClient(createDb(join(f.config.restoreRoot, "restore1", "database.sqlite"))); dbs.push(copy);
    expect(copy.prepare("SELECT id,state,proof_ref FROM process_execution_occupancy ORDER BY id").all()).toEqual([
      { id: "external", state: "unknown", proof_ref: null }, { id: "reserved", state: "reserved", proof_ref: null },
    ]);
    expect(copy.prepare("SELECT * FROM scenario_work_leases").all()).toEqual(before);
  });
  it("replays an authorized identical command without producing a second copy, but rejects identity conflicts", async () => {
    const f = fixture(), saved = await f.control.execute(request());
    expect(await f.control.execute(request())).toMatchObject({ replayed: true, manifestDigest: saved.manifestDigest });
    await expect(f.control.execute({ ...request(), reason: "different" })).rejects.toThrow("conflict");
    await f.control.execute(restore(saved.manifestDigest)); expect(await f.control.execute(restore(saved.manifestDigest))).toMatchObject({ replayed: true });
    expect(f.control.audit("backup1")).toHaveLength(3);
    expect(() => f.sqlite.exec("DELETE FROM foundation_backup_audits")).toThrow("immutable");
  });
  it.each(["database.sqlite", "manifest.json", "READY"])("rejects missing or damaged %s without publishing restore", async file => {
    const f = fixture(), saved = await f.control.execute(request()); writeFileSync(join(f.config.backupRoot, "backup1", file), "damaged");
    await expect(f.control.execute(restore(saved.manifestDigest))).rejects.toThrow(); expect(readdirSync(f.config.restoreRoot)).toEqual([]);
  });
  it("rejects wrong manifest pins and unexpected sidecars", async () => {
    const f = fixture(), saved = await f.control.execute(request());
    expect(() => f.control.verify("backup1", "a".repeat(64))).toThrow("digest");
    writeFileSync(join(f.config.backupRoot, "backup1", "database.sqlite-wal"), "untracked");
    expect(() => f.control.verify("backup1", saved.manifestDigest)).toThrow("sidecars");
  });
  it("fails closed for unsupported manifest versions even with a matching pin", async () => {
    const f = fixture(); await f.control.execute(request()); const root = join(f.config.backupRoot, "backup1");
    const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")); manifest.format = 2;
    const body = JSON.stringify(manifest); writeFileSync(join(root, "manifest.json"), body); writeFileSync(join(root, "READY"), sha(body));
    expect(() => f.control.verify("backup1", sha(body))).toThrow();
  });
  it("rejects symlink assets and entries", async () => {
    const f = fixture(), target = join(f.root, "target"), link = join(f.root, "link"); writeFileSync(target, "material"); symlinkSync(target, link);
    const control = new FoundationBackupControl(f.sqlite, { ...f.config, assets: [{ id: "resource", path: link, sha256: sha("material") }] });
    await expect(control.execute(request())).rejects.toThrow();
    symlinkSync(f.root, join(f.config.backupRoot, "linked")); expect(() => control.verify("linked", "a".repeat(64))).toThrow("Unsafe");
  });
  it.each([{ maximumBytes: 1 }, { minimumFreeBytes: Number.MAX_SAFE_INTEGER }])("rejects insufficient destination capacity %j", async options => {
    const f = fixture(options); await expect(f.control.execute(request())).rejects.toThrow(/capacity|free-space/); expect(readdirSync(f.config.backupRoot)).toEqual([]);
  });
  it("counts quarantined and completed entries toward retention capacity and never deletes them", async () => {
    const f = fixture({ maximumEntries: 1 }); await f.control.execute(request());
    await expect(f.control.execute(request("backup2"))).rejects.toThrow("capacity"); expect(readdirSync(f.config.backupRoot)).toEqual(["backup1"]);
  });
  it("preserves an existing destination without overwriting it", async () => {
    const f = fixture(), saved = await f.control.execute(request()); writeFileSync(join(f.config.restoreRoot, "restore1"), "existing-user-file");
    await expect(f.control.execute(restore(saved.manifestDigest))).rejects.toThrow(); expect(readFileSync(join(f.config.restoreRoot, "restore1"), "utf8")).toBe("existing-user-file");
  });
  it("quarantines an interrupted publication and refuses boot or automatic overwrite", async () => {
    const f = fixture(), saved = await f.control.execute(request());
    f.sqlite.exec("CREATE TRIGGER fail_publication BEFORE INSERT ON foundation_backup_audits WHEN NEW.command_id='restore1' AND NEW.phase='prepared' BEGIN SELECT RAISE(ABORT,'injected failure'); END");
    await expect(f.control.execute(restore(saved.manifestDigest))).rejects.toThrow("injected failure");
    expect(existsSync(join(f.config.restoreRoot, "restore1", "READY"))).toBe(false);
    expect(() => createDb(join(f.config.restoreRoot, "restore1", "database.sqlite"))).toThrow();
    await expect(f.control.execute(restore(saved.manifestDigest))).rejects.toThrow("quarantined");
    expect(readRunForensics(f.sqlite, "run").revision).toBe(4);
  });
  it("reconciles a durable publication after the final audit write fails, without redoing restore", async () => {
    const f = fixture(), saved = await f.control.execute(request());
    f.sqlite.exec("CREATE TRIGGER fail_completed BEFORE INSERT ON foundation_backup_audits WHEN NEW.command_id='restore1' AND NEW.phase='completed' BEGIN SELECT RAISE(ABORT,'audit interrupted'); END");
    await expect(f.control.execute(restore(saved.manifestDigest))).rejects.toThrow("audit interrupted");
    const path = join(f.config.restoreRoot, "restore1", "database.sqlite"), before = sha(readFileSync(path));
    f.sqlite.exec("DROP TRIGGER fail_completed");
    const restarted = new FoundationBackupControl(f.sqlite, f.config);
    expect(await restarted.execute(restore(saved.manifestDigest))).toMatchObject({ replayed: true }); expect(sha(readFileSync(path))).toBe(before);
  });
  it("does not migrate or repair a corrupt durable restore fence", async () => {
    const f = fixture(), saved = await f.control.execute(request()); await f.control.execute(restore(saved.manifestDigest));
    const path = join(f.config.restoreRoot, "restore1", "database.sqlite"), raw = new Database(path);
    raw.exec("DROP TRIGGER foundation_restore_fence_UPDATE; UPDATE foundation_restore_fence SET body='{}'"); raw.close();
    const before = sha(readFileSync(path)); expect(() => createDb(path)).toThrow(); expect(sha(readFileSync(path))).toBe(before);
  });
  it("refuses a copied but not yet fenced restore before any migrations", () => {
    const f = fixture(), path = join(f.config.restoreRoot, "pending"); mkdirSync(path);
    writeFileSync(join(path, "RESTORE_PENDING"), "pending");
    const raw = new Database(join(path, "database.sqlite")); raw.exec("CREATE TABLE original(value TEXT)"); raw.close();
    const before = readFileSync(join(path, "database.sqlite"));
    expect(() => createDb(join(path, "database.sqlite"))).toThrow("quarantined");
    expect(readFileSync(join(path, "database.sqlite"))).toEqual(before);
  });
  it.each(["database.sqlite-wal", "database.sqlite-shm", "database.sqlite-journal", "untracked"])("rejects restored sidecar or untracked file %s before opening SQLite", async file => {
    const f = fixture(), saved = await f.control.execute(request()); await f.control.execute(restore(saved.manifestDigest));
    const root = join(f.config.restoreRoot, "restore1"), path = join(root, "database.sqlite"); writeFileSync(join(root, file), "untracked");
    const before = readFileSync(path); expect(() => createDb(path)).toThrow(/sidecars|Unexpected/); expect(readFileSync(path)).toEqual(before);
  });
  it("rejects a symlinked restored database before SQLite follows it", async () => {
    const f = fixture(), saved = await f.control.execute(request()); await f.control.execute(restore(saved.manifestDigest));
    const root = join(f.config.restoreRoot, "restore1"), path = join(root, "database.sqlite"), target = join(f.root, "moved.sqlite");
    const before = readFileSync(path); writeFileSync(target, before); rmSync(path); symlinkSync(target, path);
    expect(() => createDb(path)).toThrow("symbolic link");
  });
  it("keeps artifact bytes and restore authority separate, rejecting missing attachments and revoked approval", async () => {
    const f = fixture(), path = join(f.root, "resource"); writeFileSync(path, "material");
    let allowed = true;
    const control = new FoundationBackupControl(f.sqlite, { ...f.config, assets: [{ id: "resource", path, sha256: sha("material") }],
      authorizer: { async authorize(input) { return allowed ? grant.authorize(input) : { decision: "denied" }; } } });
    const saved = await control.execute(request()); allowed = false;
    await expect(control.execute(restore(saved.manifestDigest))).rejects.toThrow("authorization");
    allowed = true; rmSync(join(f.config.backupRoot, "backup1", "asset-resource"));
    await expect(control.execute(restore(saved.manifestDigest))).rejects.toThrow(); expect(readdirSync(f.config.restoreRoot)).toEqual([]);
  });
  it("rejects hash-mismatched host attachments before publishing a successful backup", async () => {
    const f = fixture(), path = join(f.root, "resource"); writeFileSync(path, "changed");
    const control = new FoundationBackupControl(f.sqlite, { ...f.config, assets: [{ id: "resource", path, sha256: sha("original") }] });
    await expect(control.execute(request())).rejects.toThrow("digest mismatch");
    expect(existsSync(join(f.config.backupRoot, "backup1", "READY"))).toBe(false);
    expect(() => createDb(join(f.config.backupRoot, "backup1", "database.sqlite"))).toThrow("not a bootable host");
  });
  it("rejects public, overlapping and symlinked destination roots", () => {
    const f = fixture(), publicRoot = join(f.root, "public"); mkdirSync(publicRoot); chmodSync(publicRoot, 0o755);
    expect(() => new FoundationBackupControl(f.sqlite, { ...f.config, backupRoot: publicRoot })).toThrow("private");
    expect(() => new FoundationBackupControl(f.sqlite, { ...f.config, restoreRoot: f.config.backupRoot })).toThrow("disjoint");
    const link = join(f.root, "alias"); symlinkSync(f.config.backupRoot, link);
    expect(() => new FoundationBackupControl(f.sqlite, { ...f.config, backupRoot: link })).toThrow("symlinks");
  });
  it("checks archived facts on forensic read rather than declaring every backed-up record semantically valid", async () => {
    const f = fixture(); f.sqlite.prepare("UPDATE scenario_event_streams SET status='completed' WHERE run_id='run'").run();
    const saved = await f.control.execute(request()); await f.control.execute(restore(saved.manifestDigest));
    const copy = getSqliteClient(createDb(join(f.config.restoreRoot, "restore1", "database.sqlite"))); dbs.push(copy);
    expect(() => readRunForensics(copy, "run")).toThrow("projection integrity");
  });
  it("provides bounded, scope-checked forensic execution records without marking unknown work cleaned", async () => {
    const f = fixture();
    f.sqlite.prepare("INSERT INTO process_execution_occupancy VALUES (?,?,?,'unknown',NULL,NULL,?)").run("external", "effect", JSON.stringify({ attribution: { caseId: "case", runId: "run" } }), "now");
    f.sqlite.prepare("INSERT INTO managed_execution_occupancy VALUES (?,?,?,'unknown',NULL,NULL,?,?)").run("managed", JSON.stringify({ invocation: { attribution: { caseId: "case", runId: "run" } } }), "old-host", "now", "now");
    const saved = await f.control.execute(request()); await f.control.execute(restore(saved.manifestDigest));
    const copy = getSqliteClient(createDb(join(f.config.restoreRoot, "restore1", "database.sqlite"))); dbs.push(copy);
    const app = Fastify(); apps.push(app); registerSecurityAgentFoundation(app, copy, {} as never, f.root, () => false);
    const headers = foundationHostControl(app).management().headers();
    for (const [kind, id] of [["processes", "external"], ["managed", "managed"]]) {
      const res = await app.inject({ url: `/api/foundation/recovery/runs/run/records?caseId=case&kind=${kind}`, headers });
      expect(res.json()).toMatchObject({ externalCleanupCertified: false, records: [{ id, state: "unknown", proof_ref: null }] });
    }
    expect((await app.inject({ url: "/api/foundation/recovery/runs/run/records?caseId=wrong&kind=processes", headers })).statusCode).toBe(409);
    expect((await app.inject({ url: "/api/foundation/recovery/runs/run/records?caseId=case&kind=processes&limit=101", headers })).statusCode).toBe(409);
  });
  it("exposes production backup operations only to management transport plus independent approval", async () => {
    const f = fixture();
    const host = await foundationHost({ empty: true, ready: () => false, foundation: { backup: f.config } });
    try {
      expect((await host.app.inject({ url: "/api/foundation/backups" })).statusCode).toBe(401);
      const worker = foundationHostControl(host.app).worker({ id: "worker", roles: ["observe"], capabilities: ["observe"], maxConcurrentWork: 1, status: "online", heartbeatAt: new Date().toISOString() }, "neutral", 1);
      expect((await host.app.inject({ url: "/api/foundation/backups", headers: worker.headers() })).statusCode).toBe(403);
      const saved = await host.request("/api/foundation/backups/execute", request());
      expect(await host.request("/api/foundation/backups/verify", { backupId: "backup1", manifestDigest: saved.manifestDigest })).toMatchObject({ executionReady: false });
      expect(await host.request("/api/foundation/backups/audit?commandId=backup1")).toHaveLength(3);
      expect(host.calls()).toBe(0);
    } finally { await host.close(); }
  });
  it("rechecks authorization after copying and leaves no published backup when approval expires", async () => {
    const f = fixture();
    const expiresAt = new Date(Date.now() + 20000).toISOString();
    const control = new FoundationBackupControl(f.sqlite, { ...f.config, authorizer: { async authorize() { return { decision: "allowed", authorizationRef: "temporary", expiresAt }; } } });
    const original = f.sqlite.backup.bind(f.sqlite);
    vi.spyOn(f.sqlite, "backup").mockImplementation(async (...args) => { const result = await original(...args); vi.spyOn(Date, "now").mockReturnValue(Date.parse(expiresAt) + 1); return result; });
    await expect(control.execute(request())).rejects.toThrow("expired");
    expect(existsSync(join(f.config.backupRoot, "backup1", "READY"))).toBe(false);
  });
  it("serializes overlapping requests and rejects further work during a backup", async () => {
    const f = fixture(), original = f.sqlite.backup.bind(f.sqlite); let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(f.sqlite, "backup").mockImplementation(async (...args) => { await gate; return original(...args); });
    const pending = f.control.execute(request()); await new Promise(resolve => setTimeout(resolve, 5));
    await expect(f.control.execute(request("backup2"))).rejects.toThrow("busy"); release(); await pending;
  });
  it.each(["prepared", "published", "completed"])("survives real SIGKILL at restore %s without replay or partial activation", async phase => {
    const f = fixture(), saved = await f.control.execute(request()); f.sqlite.close();
    const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../test-fixtures/foundation-backup-crash-host.mjs", import.meta.url)), f.root, phase, saved.manifestDigest], { stdio: ["ignore", "pipe", "pipe"] });
    const error: string[] = []; child.stderr.on("data", chunk => error.push(String(chunk)));
    const signal = await new Promise<string | null>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Crash fixture deadline exceeded")); }, 15000);
      child.on("error", err => { clearTimeout(timer); reject(err); });
      child.on("exit", (code, signal) => { clearTimeout(timer); if (signal !== "SIGKILL") reject(new Error(`Unexpected exit ${code}: ${error.join("")}`)); else resolve(signal); });
    });
    expect(signal).toBe("SIGKILL");
    const sqlite = getSqliteClient(createDb(join(f.root, "source.sqlite"))); dbs.push(sqlite);
    const control = new FoundationBackupControl(sqlite, f.config), path = join(f.config.restoreRoot, "restore1", "database.sqlite");
    if (phase === "prepared") {
      expect(() => createDb(path)).toThrow(); await expect(control.execute(restore(saved.manifestDigest))).rejects.toThrow("quarantined");
    } else {
      const copy = getSqliteClient(createDb(path)); dbs.push(copy); expect(readRunForensics(copy, "run").revision).toBe(4);
      expect(await control.execute(restore(saved.manifestDigest))).toMatchObject({ replayed: true });
    }
    expect(readRunForensics(sqlite, "run").revision).toBe(4);
  });
});
