import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  readSync, readdirSync, realpathSync, statfsSync, writeFileSync, writeSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";
import { canonicalJson } from "@traceforge/orchestration-core";
import { waitForCancellation } from "@traceforge/worker-runtime";
import type { FastifyInstance } from "fastify";
import { registerExecutionArchiveFunctions } from "./db/execution-archive.js";
import { readFoundationRestoreFence, installFoundationRestoreFence } from "./db/foundation-restore-fence.js";
import { readRunForensics } from "./scenario-run-disposal.js";
import { readHistoryRows } from "./db/scenario-history.js";
import { registerFoundationRecoveryReadinessRoutes, type FoundationRecoveryReadinessOptions } from "./foundation-recovery-readiness.js";
import { FoundationRecoveryActivationControl, registerFoundationRecoveryActivationRoutes, type FoundationRecoveryActivationOptions } from "./foundation-recovery-activation.js";

export const foundationBackupIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/);
export const foundationBackupDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const id = foundationBackupIdSchema;
const digest = foundationBackupDigestSchema;
const requestSchema = z.object({ commandId: id, operation: z.enum(["backup", "restore"]),
  backupId: id.optional(), manifestDigest: digest.optional(), actor: z.string().trim().min(1).max(256),
  reason: z.string().trim().min(1).max(1024),
}).strict().superRefine((v, ctx) => {
  if (v.operation === "restore" ? !v.backupId || !v.manifestDigest : v.backupId !== undefined || v.manifestDigest !== undefined)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Restore requires backup identity and independently pinned manifest digest; backup accepts neither" });
});
export type FoundationBackupRequest = z.infer<typeof requestSchema>;
export interface FoundationBackupAuthorizer {
  authorize(input: FoundationBackupRequest): Promise<{ decision: "allowed"; authorizationRef: string; expiresAt: string } | { decision: "denied" }>;
}
export interface FoundationBackupOptions {
  /** Dedicated, private host-owned directories. Never supplied by an HTTP caller or a model. */
  backupRoot: string; restoreRoot: string;
  authorizer?: FoundationBackupAuthorizer;
  /** Optional immutable, non-secret attachments, explicitly selected by the trusted host. No recursive discovery. */
  assets?: readonly { id: string; path: string; sha256: string }[];
  maximumBytes?: number; maximumEntries?: number; minimumFreeBytes?: number; timeoutMs?: number;
}
const fileSchema = z.object({ id, sha256: digest, bytes: z.number().int().nonnegative() }).strict();
export const foundationBackupManifestSchema = z.object({ format: z.literal(1), profile: z.literal("foundation-forensics-v1"), backupId: id,
  at: z.string().datetime(), schemaDigest: digest, database: fileSchema,
  assets: z.array(fileSchema).max(128),
  dependencies: z.array(z.object({ id: z.string().max(80), status: z.literal("not_included"), detail: z.string().max(512) }).strict()).length(5),
  executionReady: z.literal(false), automaticResume: z.literal(false),
}).strict();
export type FoundationBackupManifest = z.infer<typeof foundationBackupManifestSchema>;
type Manifest = FoundationBackupManifest;
const manifestSchema = foundationBackupManifestSchema;
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const dependencies: Manifest["dependencies"] = [
  { id: "vault-key", status: "not_included", detail: "Encrypted vault entries are in SQLite; original host key or TRACEFORGE_VAULT_KEY must be safeguarded separately. Never regenerate to claim recovered credentials." },
  { id: "scenario-reviewed-materials", status: "not_included", detail: "Package files, current review authorities and trusted host assembly associations require independent provisioning and current trust checks." },
  { id: "provider-materials", status: "not_included", detail: "Provider packages, imports, work directories and remote services are not a transactional part of SQLite." },
  { id: "host-configuration", status: "not_included", detail: "Model/MCP configuration, credentials, signing keys, native helpers and permission profiles are host dependencies, not exported execution authority." },
  { id: "external-files", status: "not_included", detail: "Artifacts, legacy file checkpoints and custom external stores require separate inventory. Explicit attachments are verified bytes, not proof of complete coverage." },
];

function directory(path: string) {
  const absolute = resolve(path);
  // Reject symlinks in every existing component, including a redirected parent.
  let current = absolute;
  while (true) {
    try { if (lstatSync(current).isSymbolicLink()) throw new Error("Backup directories cannot contain symlinks"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const parent = resolve(current, ".."); if (parent === current) break; current = parent;
  }
  mkdirSync(absolute, { recursive: true, mode: 0o700 });
  if (!lstatSync(absolute).isDirectory()) throw new Error("Expected private backup directory");
  if (process.platform !== "win32" && (lstatSync(absolute).mode & 0o077) !== 0) throw new Error("Backup directories must be private (0700)");
  return realpathSync(absolute);
}
function readBounded(path: string, maximum: number): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const stat = fstatSync(fd); if (!stat.isFile() || stat.size > maximum) throw new Error("Backup file type or size invalid"); return readFileSync(fd); }
  finally { closeSync(fd); }
}
function fileDigest(path: string, maximum: number) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd); if (!stat.isFile() || stat.size > maximum) throw new Error("Backup file type or size invalid");
    const result = createHash("sha256"), buffer = Buffer.alloc(1024 * 1024); let bytes = 0, count: number;
    while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      bytes += count; if (bytes > maximum) throw new Error("Backup file grew beyond capacity"); result.update(buffer.subarray(0, count));
    }
    if (bytes !== stat.size) throw new Error("Backup file changed during verification");
    return { sha256: result.digest("hex"), bytes };
  } finally { closeSync(fd); }
}
function durableFile(path: string, body: string) {
  writeFileSync(path, body, { flag: "wx", mode: 0o600 }); sync(path);
}
function copyVerified(source: string, target: string, expected: string, maximum: number, deadline: number) {
  const input = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(input); if (!stat.isFile() || stat.size > maximum) throw new Error("Attachment type or byte capacity invalid");
    const output = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      const hash = createHash("sha256"), buffer = Buffer.alloc(1024 * 1024); let bytes = 0, count: number;
      while ((count = readSync(input, buffer, 0, buffer.length, null)) > 0) {
        bytes += count; if (bytes > maximum || Date.now() >= deadline) throw new Error("Attachment byte capacity or deadline exceeded");
        hash.update(buffer.subarray(0, count));
        for (let written = 0; written < count;) written += writeSync(output, buffer, written, count - written);
      }
      if (bytes !== stat.size || hash.digest("hex") !== expected) throw new Error("Backup attachment or source digest mismatch");
      fsyncSync(output);
    } finally { closeSync(output); }
  } finally { closeSync(input); }
}
function sync(path: string) { const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { fsyncSync(fd); } finally { closeSync(fd); } }
function schemaDigest(sqlite: Database.Database) {
  return hash(canonicalJson(sqlite.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name").all()));
}
function checkDatabase(path: string, expectedSchema?: string) {
  // The backup is host-pinned, not an arbitrary SQL plugin. Never run its triggers or migrations.
  const sqlite = new Database(path, { readonly: true, fileMustExist: true });
  try {
    registerExecutionArchiveFunctions(sqlite);
    if (sqlite.pragma("quick_check", { simple: true }) !== "ok") throw new Error("SQLite integrity check failed");
    if (readFoundationRestoreFence(sqlite)) throw new Error("Inspection copies cannot be treated as executable source backups");
    sqlite.prepare("SELECT run_id,case_id,revision,status FROM scenario_event_streams LIMIT 0").all();
    sqlite.prepare("SELECT run_id,sequence,payload_json FROM scenario_events LIMIT 0").all();
    sqlite.prepare("SELECT run_id,digest,snapshot_json FROM scenario_history_segments LIMIT 0").all();
    const actual = schemaDigest(sqlite);
    if (expectedSchema && actual !== expectedSchema) throw new Error("Backup schema digest mismatch");
    return actual;
  } finally { sqlite.close(); }
}

/** Local filesystem disaster export. READY is the publish point; incomplete directories are quarantined, never booted. */
export class FoundationBackupControl {
  private readonly roots: { backup: string; restore: string };
  private readonly maximum: number; private readonly entries: number; private readonly floor: number; private readonly timeout: number;
  private busy = false;
  constructor(private readonly sqlite: Database.Database, private readonly options: FoundationBackupOptions) {
    this.options = { ...options, assets: options.assets?.map(asset => ({ ...asset })) };
    if (readFoundationRestoreFence(sqlite)) throw new Error("Inspection host cannot mutate backup control");
    this.maximum = options.maximumBytes ?? 8 * 1024 ** 3; this.entries = options.maximumEntries ?? 32;
    this.floor = options.minimumFreeBytes ?? 64 * 1024 ** 2; this.timeout = options.timeoutMs ?? 60000;
    for (const n of [this.maximum, this.entries, this.floor, this.timeout]) if (!Number.isSafeInteger(n) || n < 1) throw new Error("Invalid backup limits");
    if (this.maximum > 64 * 1024 ** 3 || this.entries > 1024 || this.timeout > 300000 || (options.assets?.length ?? 0) > 128) throw new Error("Backup limits exceeded");
    this.roots = { backup: directory(options.backupRoot), restore: directory(options.restoreRoot) };
    const a = this.roots.backup, b = this.roots.restore;
    if (a === b || a.startsWith(b + sep) || b.startsWith(a + sep)) throw new Error("Backup and restore roots must be disjoint");
    if (new Set(options.assets?.map(asset => asset.id)).size !== (options.assets?.length ?? 0)) throw new Error("Duplicate attachment identity");
    for (const asset of options.assets ?? []) { id.parse(asset.id); digest.parse(asset.sha256); }
    sqlite.exec(`CREATE TABLE IF NOT EXISTS foundation_backup_operations (command_id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,request_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS foundation_backup_audits (sequence INTEGER PRIMARY KEY,command_id TEXT NOT NULL,phase TEXT NOT NULL,body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS foundation_backup_audit_command ON foundation_backup_audits(command_id,sequence);
      CREATE TRIGGER IF NOT EXISTS foundation_backup_operation_capacity BEFORE INSERT ON foundation_backup_operations BEGIN
        SELECT CASE WHEN (SELECT count(*) FROM foundation_backup_operations)>=10000 THEN RAISE(ABORT,'Backup command capacity exceeded') END;
        SELECT execution_physical_admit(recovery_floor,maximum_database_bytes,maximum_wal_bytes,32768,'recovery') FROM execution_physical_policy WHERE id=1;
      END;
      CREATE TRIGGER IF NOT EXISTS foundation_backup_audit_capacity BEFORE INSERT ON foundation_backup_audits BEGIN
        SELECT CASE WHEN (SELECT count(*) FROM foundation_backup_audits)>=50000 OR length(CAST(NEW.body AS BLOB))>8192
          THEN RAISE(ABORT,'Backup audit capacity exceeded') END;
      END;`);
    for (const table of ["foundation_backup_operations", "foundation_backup_audits"]) for (const operation of ["UPDATE", "DELETE"])
      sqlite.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_${operation} BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT,'Backup audit is immutable'); END;`);
  }

  inspect() { return { enabled: true, executionReady: false, automaticResume: false, dependencies,
    limits: { maximumBytes: this.maximum, maximumEntries: this.entries, minimumFreeBytes: this.floor, timeoutMs: this.timeout },
    backupEntries: readdirSync(this.roots.backup).length, restoreEntries: readdirSync(this.roots.restore).length, automaticDeletion: false }; }
  audit(commandId: string) { id.parse(commandId); return this.sqlite.prepare("SELECT sequence,phase,body FROM foundation_backup_audits WHERE command_id=? ORDER BY sequence LIMIT 8").all(commandId); }

  /** Trusted-host filesystem handoff for encrypted media assembly. Never expose these paths through HTTP. */
  mediaSource(backupId: string, expectedDigest: string) {
    const verified = this.verify(backupId, expectedDigest), root = this.entry(this.roots.backup, backupId);
    const files = [verified.manifest.database.id === "database" ? { path: "database.sqlite", ...verified.manifest.database } : undefined,
      ...verified.manifest.assets.map(asset => ({ path: `asset-${asset.id}`, ...asset })),
      { path: "manifest.json", id: "manifest", ...fileDigest(join(root, "manifest.json"), 128 * 1024) }].filter((item): item is NonNullable<typeof item> => !!item);
    return { root, manifest: verified.manifest, manifestDigest: verified.manifestDigest, files };
  }

  beginOfflineImport(backupId: string, expectedBytes: number) {
    id.parse(backupId); if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1) throw new Error("Invalid offline import size");
    this.capacity(this.roots.backup, expectedBytes);
    const destination = join(this.roots.backup, backupId); mkdirSync(destination, { mode: 0o700 }); sync(this.roots.backup);
    durableFile(join(destination, "BACKUP_ONLY"), "Not an execution authority"); sync(destination); return destination;
  }

  completeOfflineImport(backupId: string, expectedDigest: string) { return this.verify(backupId, expectedDigest); }

  trustedBackupRoot() { return this.roots.backup; }
  retentionTarget(backupId: string, expectedDigest: string) {
    const source=this.mediaSource(backupId,expectedDigest);
    return { kind:"backup" as const,id:backupId,digest:expectedDigest,root:source.root,
      files:["BACKUP_ONLY","READY",...source.files.map(file=>file.path)].sort() };
  }

  verify(backupId: string, expectedDigest: string) {
    id.parse(backupId); digest.parse(expectedDigest);
    const root = this.entry(this.roots.backup, backupId), ready = readBounded(join(root, "READY"), 64).toString();
    const body = readBounded(join(root, "manifest.json"), 128 * 1024), actual = hash(body);
    if (actual !== expectedDigest || ready !== actual) throw new Error("Backup manifest digest mismatch");
    const manifest = manifestSchema.parse(JSON.parse(body.toString()));
    if (manifest.backupId !== backupId || manifest.database.id !== "database" || new Set(manifest.assets.map(a => a.id)).size !== manifest.assets.length)
      throw new Error("Backup identity mismatch");
    if (canonicalJson(manifest.dependencies) !== canonicalJson(dependencies)) throw new Error("Unsupported backup dependency contract");
    const files = [{ ...manifest.database, path: "database.sqlite" }, ...manifest.assets.map(asset => ({ ...asset, path: `asset-${asset.id}` }))];
    if (files.reduce((sum, file) => sum + file.bytes, 0) > this.maximum) throw new Error("Backup exceeds byte capacity");
    const expectedNames = [...files.map(f => f.path), "manifest.json", "READY", "BACKUP_ONLY"].sort();
    if (canonicalJson(readdirSync(root).sort()) !== canonicalJson(expectedNames)) throw new Error("Unexpected backup files or SQLite sidecars");
    for (const file of files) {
      const found = fileDigest(join(root, file.path), this.maximum);
      if (found.sha256 !== file.sha256 || found.bytes !== file.bytes) throw new Error("Backup file digest mismatch");
    }
    checkDatabase(join(root, "database.sqlite"), manifest.schemaDigest);
    return { manifest, manifestDigest: actual, executionReady: false as const };
  }

  async execute(value: unknown) {
    const input = requestSchema.parse(structuredClone(value));
    const grant = structuredClone(await waitForCancellation(() => this.options.authorizer?.authorize(structuredClone(input))
      ?? Promise.resolve({ decision: "denied" as const }), AbortSignal.timeout(10000)));
    const authorized = () => {
      if (grant.decision !== "allowed" || !grant.authorizationRef?.trim() || grant.authorizationRef.length > 1024 || !(Date.parse(grant.expiresAt) > Date.now()))
        throw new Error("Backup/restore authorization denied or expired");
    };
    authorized();
    if (this.busy) throw new Error("Backup control busy"); this.busy = true;
    const requestHash = hash(canonicalJson(input)), destination = join(this.roots[input.operation], input.commandId);
    let started = false;
    try {
      const old = this.sqlite.prepare("SELECT request_hash FROM foundation_backup_operations WHERE command_id=?").get(input.commandId) as { request_hash: string } | undefined;
      if (old) {
        if (old.request_hash !== requestHash) throw new Error("Backup command conflict");
        const prepared = this.sqlite.prepare("SELECT body FROM foundation_backup_audits WHERE command_id=? AND phase='prepared'").get(input.commandId) as { body: string } | undefined;
        if (!prepared) throw new Error("Interrupted operation is quarantined; inspect audit and use a new command identity");
        const result = JSON.parse(prepared.body) as { manifestDigest: string; databaseDigest: string };
        this.validatePublished(input, result);
        if (!this.sqlite.prepare("SELECT 1 FROM foundation_backup_audits WHERE command_id=? AND phase='completed'").get(input.commandId))
          this.record(input.commandId, "completed", result);
        return { ...result, id: input.commandId, replayed: true, executionReady: false };
      }
      const verified = input.operation === "restore" ? this.verify(input.backupId!, input.manifestDigest!) : undefined;
      const sourceBytes = verified ? verified.manifest.database.bytes + verified.manifest.assets.reduce((sum, a) => sum + a.bytes, 0)
        : Number(this.sqlite.pragma("page_count", { simple: true })) * Number(this.sqlite.pragma("page_size", { simple: true }))
          + (this.options.assets ?? []).reduce((sum, a) => sum + fileDigest(a.path, this.maximum).bytes, 0);
      this.capacity(this.roots[input.operation], sourceBytes);
      this.sqlite.transaction(() => {
        this.sqlite.prepare("INSERT INTO foundation_backup_operations VALUES (?,?,?)").run(input.commandId, requestHash, canonicalJson(input));
        this.record(input.commandId, "started", { operation: input.operation, authorizationRef: grant.decision === "allowed" ? grant.authorizationRef : "", at: new Date().toISOString() });
      })();
      started = true;
      mkdirSync(destination, { mode: 0o700 }); sync(this.roots[input.operation]);
      durableFile(join(destination, input.operation === "backup" ? "BACKUP_ONLY" : "RESTORE_PENDING"), "Not an execution authority"); sync(destination);
      const dbPath = join(destination, "database.sqlite"), deadline = Date.now() + this.timeout;
      if (input.operation === "backup") {
        await this.sqlite.backup(dbPath, { progress: progress => {
          authorized(); if (Date.now() >= deadline) throw new Error("Backup deadline exceeded");
          this.freeSpace(this.roots.backup, progress.remainingPages * Number(this.sqlite.pragma("page_size", { simple: true })));
          if (progress.totalPages * Number(this.sqlite.pragma("page_size", { simple: true })) > this.maximum) throw new Error("Backup grew beyond byte capacity");
          return 100;
        } });
        // Online backup includes committed WAL pages; normalize the independent copy, never checkpoint the live source.
        const copy = new Database(dbPath); try { copy.pragma("journal_mode = DELETE"); } finally { copy.close(); }
        const assets: Manifest["assets"] = [];
        for (const asset of this.options.assets ?? []) {
          copyVerified(asset.path, join(destination, `asset-${asset.id}`), asset.sha256, this.maximum, deadline);
          const info = fileDigest(join(destination, `asset-${asset.id}`), this.maximum);
          if (info.sha256 !== asset.sha256) throw new Error("Host attachment changed or hash mismatch");
          sync(join(destination, `asset-${asset.id}`)); assets.push({ id: asset.id, ...info });
        }
        const manifest: Manifest = { format: 1, profile: "foundation-forensics-v1", backupId: input.commandId, at: new Date().toISOString(),
          schemaDigest: checkDatabase(dbPath), database: { id: "database", ...fileDigest(dbPath, this.maximum) }, assets, dependencies,
          executionReady: false, automaticResume: false };
        if (manifest.database.bytes + assets.reduce((sum, a) => sum + a.bytes, 0) > this.maximum) throw new Error("Backup exceeds byte capacity");
        durableFile(join(destination, "manifest.json"), canonicalJson(manifest));
      } else {
        const source = this.entry(this.roots.backup, input.backupId!);
        copyVerified(join(source, "database.sqlite"), dbPath, verified!.manifest.database.sha256, this.maximum, deadline);
        if (fileDigest(dbPath, this.maximum).sha256 !== verified!.manifest.database.sha256) throw new Error("Restore source changed");
        checkDatabase(dbPath, verified!.manifest.schemaDigest);
        for (const asset of verified!.manifest.assets) {
          const path = join(destination, `asset-${asset.id}`); copyVerified(join(source, `asset-${asset.id}`), path, asset.sha256, this.maximum, deadline);
          if (fileDigest(path, this.maximum).sha256 !== asset.sha256) throw new Error("Restore attachment changed"); sync(path);
        }
        const copy = new Database(dbPath);
        try { installFoundationRestoreFence(copy, { format: 1, mode: "inspection_only", backupId: input.backupId!, restoreId: input.commandId,
          manifestDigest: input.manifestDigest!, restoredAt: new Date().toISOString(), automaticResume: false, externalCleanupCertified: false }); }
        finally { copy.close(); }
        durableFile(join(destination, "manifest.json"), canonicalJson(verified!.manifest));
      }
      authorized(); if (Date.now() >= deadline) throw new Error("Backup/restore deadline exceeded");
      sync(dbPath); sync(destination);
      const result = { manifestDigest: hash(readBounded(join(destination, "manifest.json"), 128 * 1024)), databaseDigest: fileDigest(dbPath, this.maximum).sha256 };
      this.record(input.commandId, "prepared", result);
      durableFile(join(destination, "READY"), result.manifestDigest); sync(destination);
      this.record(input.commandId, "completed", result);
      return { ...result, id: input.commandId, replayed: false, executionReady: false };
    } catch (error) {
      if (started) {
        // Do not delete forensic residue or turn a publication/audit uncertainty into a clean rollback claim.
        try { this.record(input.commandId, "interrupted", { at: new Date().toISOString(), disposition: "inspect_publication_before_retry" }); } catch { /* started remains durable if the audit disk is unavailable */ }
      }
      throw error;
    } finally { this.busy = false; }
  }

  private validatePublished(input: FoundationBackupRequest, result: { manifestDigest: string; databaseDigest: string }) {
    if (input.operation === "backup") { this.verify(input.commandId, result.manifestDigest); return; }
    const root = this.entry(this.roots.restore, input.commandId);
    if (readBounded(join(root, "READY"), 64).toString() !== result.manifestDigest
      || hash(readBounded(join(root, "manifest.json"), 128 * 1024)) !== result.manifestDigest
      || fileDigest(join(root, "database.sqlite"), this.maximum).sha256 !== result.databaseDigest) throw new Error("Restored publication missing or changed");
    const manifest = manifestSchema.parse(JSON.parse(readBounded(join(root, "manifest.json"), 128 * 1024).toString()));
    for (const asset of manifest.assets) if (fileDigest(join(root, `asset-${asset.id}`), this.maximum).sha256 !== asset.sha256) throw new Error("Restored attachment changed");
    const copy = new Database(join(root, "database.sqlite"), { readonly: true, fileMustExist: true });
    try { const fence = readFoundationRestoreFence(copy); if (fence?.restoreId !== input.commandId || fence.manifestDigest !== input.manifestDigest) throw new Error("Restore fence mismatch"); }
    finally { copy.close(); }
  }
  private entry(root: string, name: string) {
    const path = join(root, name); if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory() || realpathSync(path) !== path) throw new Error("Unsafe backup entry"); return path;
  }
  private freeSpace(root: string, pending: number) { const stat = statfsSync(root, { bigint: true }); if (stat.bavail * stat.bsize < BigInt(this.floor) + BigInt(pending)) throw new Error("Backup destination free-space floor exceeded"); }
  private capacity(root: string, bytes: number) {
    if (bytes > this.maximum || readdirSync(root).length >= this.entries) throw new Error("Backup destination capacity exceeded");
    this.freeSpace(root, bytes + 1024 * 1024);
  }
  private record(commandId: string, phase: string, body: unknown) { this.sqlite.prepare("INSERT INTO foundation_backup_audits(command_id,phase,body) VALUES (?,?,?)").run(commandId, phase, canonicalJson(body)); }
}

export function registerFoundationBackupRoutes(app: FastifyInstance, control: FoundationBackupControl) {
  const route = (suffix: string, method: "GET" | "POST", handler: (value: unknown) => unknown) => app.route({ method,
    url: `/api/foundation/backups${suffix}`, handler: async (req, reply) => {
      try { return await handler(method === "GET" ? req.query : req.body); }
      catch (error) { return reply.code(error instanceof z.ZodError ? 400 : 409).send({ error: error instanceof Error ? error.message.slice(0, 512) : "Backup unavailable" }); }
    } });
  route("", "GET", () => control.inspect());
  route("/audit", "GET", value => control.audit(z.object({ commandId: id }).strict().parse(value).commandId));
  route("/verify", "POST", value => { const v = z.object({ backupId: id, manifestDigest: digest }).strict().parse(value); return control.verify(v.backupId, v.manifestDigest); });
  route("/execute", "POST", value => control.execute(value));
}

/** Only inert, bounded forensic reads are installed on a restored host. No package code or recovery constructors. */
export function registerFoundationInspectionRoutes(app: FastifyInstance, sqlite: Database.Database,
  readiness?: FoundationRecoveryReadinessOptions, activation?: FoundationRecoveryActivationOptions) {
  const fence = readFoundationRestoreFence(sqlite); if (!fence) throw new Error("Missing restore fence");
  sqlite.pragma("query_only = ON");
  app.get("/api/foundation/recovery", async () => ({ ...fence, executionReady: false, dependencies }));
  const readinessControl=registerFoundationRecoveryReadinessRoutes(app,sqlite,fence,readiness);
  if(activation){if(!readinessControl)throw new Error("Recovery activation requires the readiness control");
    registerFoundationRecoveryActivationRoutes(app,new FoundationRecoveryActivationControl(activation,sqlite,fence,readinessControl));}
  app.get("/api/foundation/recovery/runs", async (req, reply) => {
    try {
      const q = z.object({ after: z.string().max(256).default(""), limit: z.coerce.number().int().min(1).max(100).default(50) }).strict().parse(req.query);
      return sqlite.prepare("SELECT run_id,case_id,status,revision FROM scenario_event_streams WHERE run_id>? ORDER BY run_id LIMIT ?").all(q.after, q.limit);
    } catch { return reply.code(400).send({ error: "Invalid forensic query" }); }
  });
  for (const part of ["state", "events"] as const) app.get(`/api/foundation/recovery/runs/:runId/${part}`, async (req, reply) => {
    try {
      const runId = z.object({ runId: z.string().min(1).max(256) }).parse(req.params).runId;
      const q = z.object({ caseId: z.string().min(1).max(256), after: z.coerce.number().int().nonnegative().default(0), limit: z.coerce.number().int().min(1).max(100).default(50) }).strict().parse(req.query);
      const scope = sqlite.prepare("SELECT case_id FROM scenario_event_streams WHERE run_id=?").get(runId) as { case_id: string } | undefined;
      if (scope?.case_id !== q.caseId) throw new Error("Run scope mismatch");
      const result = part === "state" ? readRunForensics(sqlite, runId) : readHistoryRows(sqlite, runId, q.after, q.limit);
      if (Buffer.byteLength(JSON.stringify(result)) > 4 * 1024 ** 2) throw new Error("Forensic page budget exceeded");
      return result;
    } catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message.slice(0, 512) : "Forensic read failed" }); }
  });
  app.get("/api/foundation/recovery/runs/:runId/records", async (req, reply) => {
    try {
      const runId = z.object({ runId: z.string().min(1).max(256) }).parse(req.params).runId;
      const q = z.object({ caseId: z.string().min(1).max(256), kind: z.enum(["processes", "managed", "invocations"]),
        after: z.string().max(1024).default(""), limit: z.coerce.number().int().min(1).max(100).default(50) }).strict().parse(req.query);
      const scope = sqlite.prepare("SELECT case_id FROM scenario_event_streams WHERE run_id=?").get(runId) as { case_id: string } | undefined;
      if (scope?.case_id !== q.caseId) throw new Error("Run scope mismatch");
      const table = { processes: "process_execution_occupancy", managed: "managed_execution_occupancy", invocations: "tool_invocation_bindings" }[q.kind];
      if (!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) return { available: false, records: [], externalCleanupCertified: false };
      const sql = q.kind === "processes" ? `SELECT id,state,request_id,proof_ref FROM process_execution_occupancy
        WHERE json_extract(identity_json,'$.attribution.caseId')=? AND json_extract(identity_json,'$.attribution.runId')=? AND id>? ORDER BY id LIMIT ?`
        : q.kind === "managed" ? `SELECT idempotency_key AS id,state,request_id,proof_ref FROM managed_execution_occupancy
        WHERE json_extract(identity_json,'$.invocation.attribution.caseId')=? AND json_extract(identity_json,'$.invocation.attribution.runId')=? AND idempotency_key>? ORDER BY idempotency_key LIMIT ?`
        : `SELECT b.idempotency_key AS id,b.work_id,b.status AS binding_status,e.status AS execution_status,e.lease_id FROM tool_invocation_bindings b
        LEFT JOIN tool_invocation_executions e USING(idempotency_key) WHERE b.case_id=? AND b.run_id=? AND b.idempotency_key>? ORDER BY b.idempotency_key LIMIT ?`;
      const records = sqlite.prepare(sql).all(q.caseId, runId, q.after, q.limit);
      if (Buffer.byteLength(JSON.stringify(records)) > 1024 * 1024) throw new Error("Forensic record page capacity exceeded");
      return { available: true, records, externalCleanupCertified: false };
    } catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message.slice(0, 512) : "Forensic read failed" }); }
  });
}
