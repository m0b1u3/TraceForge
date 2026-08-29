import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type Database from "better-sqlite3";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  canonicalJson,
  SqliteToolProviderControlStore,
  ToolProviderControlError,
  ToolProviderControlPlane,
  type ToolProviderInstallation,
} from "./tool-provider-control-plane.js";
import {
  DEFAULT_TOOL_PROVIDER_ARCHIVE_POLICY,
  extractAndVerifyToolProviderArchive,
  removeExtractedToolProviderArchive,
  ToolProviderArchiveError,
  type ToolProviderArchivePolicy,
} from "./tool-provider-archive.js";

export const TOOL_PROVIDER_ARCHIVE_MEDIA_TYPE = "application/vnd.traceforge.tool-provider-archive";

export interface ToolProviderArchiveImportAuthorizer {
  authorize(input: {
    actor: string;
    commandId: string;
    archiveSha256: string;
    archiveBytes: number;
  }): Promise<{ decision: "allowed" | "denied"; reason: string }>;
}

export interface ToolProviderArchiveImportAudit {
  commandId: string;
  requestFingerprint: string;
  archiveSha256: string;
  archiveBytes: number;
  actor: string;
  authorizationDecision: "allowed" | "denied";
  authorizationReason: string;
  outcome: "receiving" | "installed" | "rejected";
  providerId: string | null;
  providerVersion: string | null;
  signerId: string | null;
  failureReason: string | null;
  uploadCleanup: "not_required" | "pending" | "completed" | "failed";
  packageCleanup: "not_required" | "pending" | "completed" | "failed";
  createdAt: string;
  completedAt: string | null;
}

interface ImportRow {
  command_id: string;
  request_fingerprint: string;
  archive_sha256: string;
  archive_bytes: number;
  actor: string;
  authorization_decision: ToolProviderArchiveImportAudit["authorizationDecision"];
  authorization_reason: string;
  outcome: ToolProviderArchiveImportAudit["outcome"];
  provider_id: string | null;
  provider_version: string | null;
  signer_id: string | null;
  failure_reason: string | null;
  upload_path: string | null;
  staging_path: string | null;
  upload_cleanup: ToolProviderArchiveImportAudit["uploadCleanup"];
  package_cleanup: ToolProviderArchiveImportAudit["packageCleanup"];
  created_at: string;
  completed_at: string | null;
}

export class ToolProviderArchiveImportError extends Error {
  constructor(message: string, readonly statusCode: 400 | 403 | 404 | 409 | 413 | 429 | 500 = 400) {
    super(message);
    this.name = "ToolProviderArchiveImportError";
  }
}

export class ToolProviderArchiveImportService {
  readonly uploadRoot: string;
  readonly stagingRoot: string;
  private activeImports = 0;

  constructor(
    private readonly sqlite: Database.Database,
    private readonly control: ToolProviderControlPlane,
    private readonly controlStore: SqliteToolProviderControlStore,
    private readonly trustRoots: ReadonlyMap<string, string>,
    root: string,
    private readonly authorizer: ToolProviderArchiveImportAuthorizer,
    private readonly policy: ToolProviderArchivePolicy = DEFAULT_TOOL_PROVIDER_ARCHIVE_POLICY,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly maximumConcurrentImports = 2,
  ) {
    if (!isAbsolute(root)) throw new Error("Tool Provider archive import root must be absolute");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const canonicalRoot = realpathSync(root);
    this.uploadRoot = ensureChildDirectory(canonicalRoot, "uploads");
    this.stagingRoot = ensureChildDirectory(canonicalRoot, "staging");
    if (!Number.isInteger(maximumConcurrentImports) || maximumConcurrentImports < 1) {
      throw new Error("Tool Provider archive import concurrency must be a positive integer");
    }
  }

  get maximumArchiveBytes(): number { return this.policy.maximumArchiveBytes; }

  listAudits(): ToolProviderArchiveImportAudit[] {
    return (this.sqlite.prepare("SELECT * FROM tool_provider_archive_imports ORDER BY created_at, command_id").all() as ImportRow[]).map(parseAudit);
  }

  async import(input: { archive: Buffer; actor: string; commandId: string }): Promise<{
    installation: ToolProviderInstallation;
    audit: ToolProviderArchiveImportAudit;
    replayed: boolean;
  }> {
    const actor = required(input.actor, "actor");
    const commandId = required(input.commandId, "commandId");
    if (!Buffer.isBuffer(input.archive) || !input.archive.length) throw new ToolProviderArchiveImportError("Tool Provider archive body is required");
    if (input.archive.byteLength > this.policy.maximumArchiveBytes) {
      throw new ToolProviderArchiveImportError(`Tool Provider archive exceeds ${this.policy.maximumArchiveBytes} compressed bytes`, 413);
    }
    return this.withImportSlot(async () => {
      const uploadPath = join(this.uploadRoot, `upload-${randomUUID()}.tfpa`);
      writeFileSync(uploadPath, input.archive, { flag: "wx", mode: 0o600 });
      return this.importUploaded({ uploadPath, archiveSha256: sha256(input.archive), archiveBytes: input.archive.byteLength, actor, commandId });
    });
  }

  async importStream(input: { archive: AsyncIterable<Buffer | Uint8Array | string>; actor: string; commandId: string }): Promise<{
    installation: ToolProviderInstallation;
    audit: ToolProviderArchiveImportAudit;
    replayed: boolean;
  }> {
    const actor = required(input.actor, "actor");
    const commandId = required(input.commandId, "commandId");
    return this.withImportSlot(async () => {
      const uploadPath = join(this.uploadRoot, `upload-${randomUUID()}.tfpa`);
      const received = await receiveArchiveStream(input.archive, uploadPath, this.policy.maximumArchiveBytes);
      return this.importUploaded({ uploadPath, archiveSha256: received.sha256, archiveBytes: received.bytes, actor, commandId });
    });
  }

  private async importUploaded(input: {
    uploadPath: string;
    archiveSha256: string;
    archiveBytes: number;
    actor: string;
    commandId: string;
  }): Promise<{ installation: ToolProviderInstallation; audit: ToolProviderArchiveImportAudit; replayed: boolean }> {
    const { uploadPath, archiveSha256, archiveBytes, actor, commandId } = input;
    const requestFingerprint = sha256(Buffer.from(canonicalJson({ actor, archiveSha256, archiveBytes })));
    const existing = this.getRow(commandId);
    if (existing) {
      cleanupUpload(this.uploadRoot, uploadPath);
      return this.replay(existing, requestFingerprint);
    }

    const authorization = await this.authorize({ actor, commandId, archiveSha256, archiveBytes });
    const at = this.now();
    if (authorization.decision === "denied") {
      const uploadCleanup = cleanupUpload(this.uploadRoot, uploadPath);
      try {
        this.insertRow({
          commandId, requestFingerprint, archiveSha256, archiveBytes, actor,
          authorizationDecision: "denied", authorizationReason: authorization.reason, outcome: "rejected",
          failureReason: authorization.reason,
          uploadPath, uploadCleanup, packageCleanup: "not_required", createdAt: at, completedAt: at,
        });
      } catch (error) {
        const raced = this.getRow(commandId);
        if (raced) return this.replay(raced, requestFingerprint);
        throw error;
      }
      throw new ToolProviderArchiveImportError("Tool Provider archive import is not authorized", 403);
    }

    try {
      this.insertRow({
        commandId, requestFingerprint, archiveSha256, archiveBytes, actor,
        authorizationDecision: "allowed", authorizationReason: authorization.reason, outcome: "receiving",
        uploadPath, uploadCleanup: "pending", packageCleanup: "not_required", createdAt: at, completedAt: null,
      });
    } catch (error) {
      cleanupUpload(this.uploadRoot, uploadPath);
      const raced = this.getRow(commandId);
      if (raced) return this.replay(raced, requestFingerprint);
      throw error;
    }

    let stagingPath: string | null = null;
    let installation: ToolProviderInstallation | null = null;
    let failure: unknown;
    try {
      const extracted = extractAndVerifyToolProviderArchive({
        archivePath: uploadPath,
        stagingRoot: this.stagingRoot,
        trustRoots: this.trustRoots,
        policy: this.policy,
      });
      stagingPath = extracted.packageRoot;
      this.sqlite.prepare(`
        UPDATE tool_provider_archive_imports
        SET provider_id = ?, provider_version = ?, signer_id = ?, staging_path = ?, package_cleanup = 'pending'
        WHERE command_id = ? AND outcome = 'receiving'
      `).run(extracted.manifest.providerId, extracted.manifest.version, extracted.signature.keyId, stagingPath, commandId);
      installation = this.control.install(
        extracted.manifest,
        extracted.signature,
        extracted.packageRoot,
        actor,
        installCommandId(commandId),
      );
    } catch (error) {
      failure = error;
    }

    const uploadCleanup = cleanupUpload(this.uploadRoot, uploadPath);
    const packageCleanup = stagingPath ? cleanupPackage(this.stagingRoot, stagingPath) : "not_required";
    const completedAt = this.now();
    if (failure || !installation) {
      const reason = boundedMessage(failure ?? "Tool Provider archive installation did not complete");
      this.sqlite.prepare(`
        UPDATE tool_provider_archive_imports
        SET outcome = 'rejected', failure_reason = ?, upload_cleanup = ?, package_cleanup = ?, completed_at = ?
        WHERE command_id = ?
      `).run(reason, uploadCleanup, packageCleanup, completedAt, commandId);
      throw mapImportError(failure, reason);
    }
    this.sqlite.prepare(`
      UPDATE tool_provider_archive_imports
      SET outcome = 'installed', upload_cleanup = ?, package_cleanup = ?, completed_at = ?
      WHERE command_id = ?
    `).run(uploadCleanup, packageCleanup, completedAt, commandId);
    return { installation, audit: parseAudit(this.getRow(commandId)!), replayed: false };
  }

  private async withImportSlot<T>(operation: () => Promise<T>): Promise<T> {
    if (this.activeImports >= this.maximumConcurrentImports) {
      throw new ToolProviderArchiveImportError("Tool Provider archive import concurrency is exhausted", 429);
    }
    this.activeImports += 1;
    try { return await operation(); }
    finally { this.activeImports -= 1; }
  }

  recoverInterrupted(): { installed: number; rejected: number; orphaned: number; cleanupFailures: number } {
    const rows = this.sqlite.prepare(`
      SELECT * FROM tool_provider_archive_imports
      WHERE outcome = 'receiving' OR upload_cleanup = 'failed' OR package_cleanup = 'failed'
    `).all() as ImportRow[];
    let installed = 0;
    let rejected = 0;
    let orphaned = 0;
    let cleanupFailures = 0;
    const referencedUploads = new Set(rows.flatMap((row) => row.upload_path ? [resolve(row.upload_path)] : []));
    const referencedPackages = new Set(rows.flatMap((row) => row.staging_path ? [resolve(row.staging_path)] : []));
    for (const row of rows) {
      const committed = row.outcome === "receiving" ? this.controlStore.findCommand(installCommandId(row.command_id)) : null;
      const uploadCleanup = row.upload_path ? cleanupUpload(this.uploadRoot, row.upload_path) : "not_required";
      const packageCleanup = row.staging_path ? cleanupPackage(this.stagingRoot, row.staging_path) : "not_required";
      if (uploadCleanup === "failed" || packageCleanup === "failed") cleanupFailures += 1;
      if (row.outcome === "receiving") {
        if (committed) installed += 1;
        else rejected += 1;
        this.sqlite.prepare(`
          UPDATE tool_provider_archive_imports
          SET outcome = ?, failure_reason = ?, upload_cleanup = ?, package_cleanup = ?, completed_at = ?
          WHERE command_id = ? AND outcome = 'receiving'
        `).run(
          committed ? "installed" : "rejected",
          committed ? null : "Archive import was interrupted before installation committed",
          uploadCleanup, packageCleanup, this.now(), row.command_id,
        );
      } else {
        this.sqlite.prepare(`
          UPDATE tool_provider_archive_imports SET upload_cleanup = ?, package_cleanup = ? WHERE command_id = ?
        `).run(uploadCleanup, packageCleanup, row.command_id);
      }
    }
    for (const name of readdirSync(this.uploadRoot)) {
      const path = join(this.uploadRoot, name);
      if (referencedUploads.has(path)) continue;
      orphaned += 1;
      if (cleanupUpload(this.uploadRoot, path) === "failed") cleanupFailures += 1;
    }
    for (const name of readdirSync(this.stagingRoot)) {
      const path = join(this.stagingRoot, name);
      if (referencedPackages.has(path)) continue;
      orphaned += 1;
      if (cleanupPackage(this.stagingRoot, path) === "failed") cleanupFailures += 1;
    }
    const report = { installed, rejected, orphaned, cleanupFailures };
    if (rows.length || orphaned || cleanupFailures) {
      this.sqlite.prepare(`
        INSERT INTO tool_provider_archive_cleanup_runs
          (id, recovered_installed, recovered_rejected, orphaned, cleanup_failures, completed_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), installed, rejected, orphaned, cleanupFailures, this.now());
    }
    return report;
  }

  private async authorize(input: { actor: string; commandId: string; archiveSha256: string; archiveBytes: number }) {
    try {
      const result = await this.authorizer.authorize(input);
      if (!result || !["allowed", "denied"].includes(result.decision) || !result.reason?.trim()) throw new Error("invalid authorization response");
      return { decision: result.decision, reason: result.reason.trim().slice(0, 512) } as const;
    } catch {
      return { decision: "denied", reason: "Archive import authorization failed closed" } as const;
    }
  }

  private replay(row: ImportRow, requestFingerprint: string): {
    installation: ToolProviderInstallation;
    audit: ToolProviderArchiveImportAudit;
    replayed: boolean;
  } {
    if (row.request_fingerprint !== requestFingerprint) {
      throw new ToolProviderArchiveImportError(`Archive import command ${row.command_id} was already used with different input`, 409);
    }
    if (row.outcome === "receiving") throw new ToolProviderArchiveImportError(`Archive import command ${row.command_id} is already in progress`, 409);
    if (row.outcome === "rejected") throw new ToolProviderArchiveImportError(row.failure_reason ?? "Tool Provider archive import was rejected", row.authorization_decision === "denied" ? 403 : 400);
    const installation = row.provider_id && row.provider_version
      ? this.control.list().find((candidate) => candidate.manifest.providerId === row.provider_id && candidate.manifest.version === row.provider_version)
      : undefined;
    if (!installation) throw new ToolProviderArchiveImportError("Installed archive audit no longer resolves to a Provider manifest", 500);
    return { installation, audit: parseAudit(row), replayed: true };
  }

  private getRow(commandId: string): ImportRow | undefined {
    return this.sqlite.prepare("SELECT * FROM tool_provider_archive_imports WHERE command_id = ?").get(commandId) as ImportRow | undefined;
  }

  private insertRow(input: {
    commandId: string; requestFingerprint: string; archiveSha256: string; archiveBytes: number; actor: string;
    authorizationDecision: "allowed" | "denied"; authorizationReason: string; outcome: "receiving" | "rejected";
    failureReason?: string;
    uploadPath?: string; uploadCleanup: ToolProviderArchiveImportAudit["uploadCleanup"];
    packageCleanup: ToolProviderArchiveImportAudit["packageCleanup"]; createdAt: string; completedAt: string | null;
  }): void {
    this.sqlite.prepare(`
      INSERT INTO tool_provider_archive_imports
        (command_id, request_fingerprint, archive_sha256, archive_bytes, actor, authorization_decision,
         authorization_reason, outcome, failure_reason, upload_path, upload_cleanup, package_cleanup, created_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.commandId, input.requestFingerprint, input.archiveSha256, input.archiveBytes, input.actor,
      input.authorizationDecision, input.authorizationReason, input.outcome, input.failureReason ?? null, input.uploadPath ?? null,
      input.uploadCleanup, input.packageCleanup, input.createdAt, input.completedAt,
    );
  }
}

export function registerToolProviderArchiveImportRoutes(app: FastifyInstance, service: ToolProviderArchiveImportService): void {
  app.addContentTypeParser(
    TOOL_PROVIDER_ARCHIVE_MEDIA_TYPE,
    { bodyLimit: service.maximumArchiveBytes },
    (_request, payload, done) => done(null, payload),
  );
  app.post("/api/security-tools/providers/archive-import", async (request, reply) => {
    try {
      const actor = header(request.headers["x-traceforge-actor"]);
      const commandId = header(request.headers["x-traceforge-command-id"]);
      const result = await service.importStream({
        archive: request.body as AsyncIterable<Buffer | Uint8Array | string>, actor, commandId,
      });
      return reply.code(result.replayed ? 200 : 201).send(result);
    } catch (error) {
      return importError(reply, error);
    }
  });
}

function parseAudit(row: ImportRow): ToolProviderArchiveImportAudit {
  return {
    commandId: row.command_id, requestFingerprint: row.request_fingerprint, archiveSha256: row.archive_sha256,
    archiveBytes: row.archive_bytes, actor: row.actor, authorizationDecision: row.authorization_decision,
    authorizationReason: row.authorization_reason, outcome: row.outcome, providerId: row.provider_id,
    providerVersion: row.provider_version, signerId: row.signer_id, failureReason: row.failure_reason,
    uploadCleanup: row.upload_cleanup, packageCleanup: row.package_cleanup, createdAt: row.created_at, completedAt: row.completed_at,
  };
}

function cleanupUpload(root: string, path: string): "completed" | "failed" {
  try {
    const target = assertManagedDirectChild(root, path, "upload-", ".tfpa");
    if (existsSync(target)) {
      const stats = lstatSync(target);
      if (stats.isSymbolicLink() || !stats.isFile()) throw new Error("upload is not a regular file");
      rmSync(target);
    }
    return "completed";
  } catch { return "failed"; }
}

async function receiveArchiveStream(
  stream: AsyncIterable<Buffer | Uint8Array | string>,
  uploadPath: string,
  maximumBytes: number,
): Promise<{ bytes: number; sha256: string }> {
  const digest = createHash("sha256");
  let bytes = 0;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(uploadPath, "wx", 0o600);
    for await (const value of stream) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      bytes += chunk.byteLength;
      if (bytes > maximumBytes) throw new ToolProviderArchiveImportError(`Tool Provider archive exceeds ${maximumBytes} compressed bytes`, 413);
      digest.update(chunk);
      let offset = 0;
      while (offset < chunk.byteLength) offset += writeSync(descriptor, chunk, offset, chunk.byteLength - offset);
    }
    if (!bytes) throw new ToolProviderArchiveImportError("Tool Provider archive body is required");
    closeSync(descriptor);
    descriptor = null;
    return { bytes, sha256: digest.digest("hex") };
  } catch (error) {
    if (descriptor !== null) closeSync(descriptor);
    cleanupUpload(dirname(uploadPath), uploadPath);
    throw error;
  }
}

function cleanupPackage(root: string, path: string): "completed" | "failed" {
  try { removeExtractedToolProviderArchive(root, path); return "completed"; }
  catch { return "failed"; }
}

function assertManagedDirectChild(root: string, path: string, prefix: string, suffix: string): string {
  const target = resolve(path);
  const fromRoot = relative(root, target);
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)
    || dirname(target) !== root || !basename(target).startsWith(prefix) || !basename(target).endsWith(suffix)) {
    throw new Error("managed path escapes its root");
  }
  return target;
}

function ensureChildDirectory(root: string, name: string): string {
  const path = join(root, name);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const canonical = realpathSync(path);
  if (dirname(canonical) !== root || !statSync(canonical).isDirectory()) throw new Error("Tool Provider archive directory escapes its managed root");
  return canonical;
}

function mapImportError(error: unknown, reason: string): ToolProviderArchiveImportError {
  if (error instanceof ToolProviderArchiveImportError) return error;
  if (error instanceof ToolProviderControlError) return new ToolProviderArchiveImportError(reason, error.statusCode);
  if (error instanceof ToolProviderArchiveError) return new ToolProviderArchiveImportError(reason, 400);
  return new ToolProviderArchiveImportError(reason, 500);
}

function importError(reply: FastifyReply, error: unknown) {
  if (error instanceof ToolProviderArchiveImportError) return reply.code(error.statusCode).send({ error: error.message });
  return reply.code(500).send({ error: boundedMessage(error) });
}

function header(value: string | string[] | undefined): string { return Array.isArray(value) ? value[0] ?? "" : value ?? ""; }
function required(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new ToolProviderArchiveImportError(`${label} is required`);
  return value.trim();
}
function installCommandId(commandId: string): string { return `${commandId}:archive-install`; }
function sha256(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function boundedMessage(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 512); }
