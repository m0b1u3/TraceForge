import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, getSqliteClient } from "./db/client.js";
import {
  canonicalJson,
  SqliteToolProviderControlStore,
  ToolProviderControlPlane,
  type ToolProviderManifest,
  type ToolProviderSignature,
} from "./tool-provider-control-plane.js";
import { createSignedToolProviderArchive, DEFAULT_TOOL_PROVIDER_ARCHIVE_POLICY } from "./tool-provider-archive.js";
import {
  registerToolProviderArchiveImportRoutes,
  TOOL_PROVIDER_ARCHIVE_MEDIA_TYPE,
  ToolProviderArchiveImportService,
  type ToolProviderArchiveImportAuthorizer,
} from "./tool-provider-archive-import.js";
import { inspectToolProviderPackage, ManagedToolProviderPackageStore } from "./tool-provider-package-store.js";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    makeWritable(directory);
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture(authorizer?: ToolProviderArchiveImportAuthorizer) {
  const root = mkdtempSync(join(tmpdir(), "traceforge-provider-import-"));
  temporaryDirectories.push(root);
  const sourceRoot = join(root, "source");
  mkdirSync(sourceRoot);
  const executable = join(sourceRoot, "provider.bin");
  writeFileSync(executable, "neutral provider executable");
  chmodSync(executable, 0o700);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const manifest = makeManifest(sourceRoot);
  const sqlite = getSqliteClient(createDb(":memory:"));
  const controlStore = new SqliteToolProviderControlStore(sqlite);
  const trustRoots = new Map([["release-key", publicKey.export({ type: "spki", format: "pem" }).toString()]]);
  const control = new ToolProviderControlPlane(
    controlStore,
    trustRoots,
    { async activate() {}, async deactivate() {}, async drain() {} },
    new ManagedToolProviderPackageStore(join(root, "packages")),
    () => "2026-08-29T03:00:00.000Z",
  );
  const archivePath = join(root, "provider.tfpa");
  createSignedToolProviderArchive({ sourceRoot, manifestValue: manifest, privateKey, keyId: "release-key", archivePath });
  const archive = readFileSync(archivePath);
  const service = new ToolProviderArchiveImportService(
    sqlite,
    control,
    controlStore,
    trustRoots,
    join(root, "imports"),
    authorizer ?? { async authorize() { return { decision: "allowed", reason: "release operator grant" }; } },
    DEFAULT_TOOL_PROVIDER_ARCHIVE_POLICY,
    () => "2026-08-29T03:00:00.000Z",
  );
  return { root, sourceRoot, manifest, privateKey, sqlite, controlStore, control, archive, service, trustRoots };
}

describe("Tool Provider archive import control plane", () => {
  it("authorizes, installs, audits, cleans staging, and replays the same command", async () => {
    const context = fixture();
    const app = Fastify();
    registerToolProviderArchiveImportRoutes(app, context.service);
    const request = {
      method: "POST" as const,
      url: "/api/security-tools/providers/archive-import",
      headers: {
        "content-type": TOOL_PROVIDER_ARCHIVE_MEDIA_TYPE,
        "x-traceforge-actor": "release-operator",
        "x-traceforge-command-id": "archive-import-1",
      },
      payload: context.archive,
    };
    const first = await app.inject(request);
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ replayed: false, installation: { state: "installed" } });
    const replay = await app.inject(request);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ replayed: true, audit: { outcome: "installed" } });
    expect(context.service.listAudits()).toMatchObject([{
      actor: "release-operator",
      authorizationDecision: "allowed",
      outcome: "installed",
      providerId: "neutral-provider",
      signerId: "release-key",
      uploadCleanup: "completed",
      packageCleanup: "completed",
    }]);
    expect(readdirSync(context.service.uploadRoot)).toEqual([]);
    expect(readdirSync(context.service.stagingRoot)).toEqual([]);

    const conflict = await app.inject({ ...request, payload: Buffer.concat([context.archive, Buffer.from("changed")]) });
    expect(conflict.statusCode).toBe(409);
    await app.close();
    context.sqlite.close();
  });

  it("fails closed on denied or broken authorization and records the decision without writing files", async () => {
    for (const authorizer of [
      { async authorize() { return { decision: "denied" as const, reason: "operator lacks release role" }; } },
      { async authorize(): Promise<{ decision: "allowed"; reason: string }> { throw new Error("authorization backend unavailable"); } },
    ]) {
      const context = fixture(authorizer);
      await expect(context.service.import({ archive: context.archive, actor: "operator", commandId: randomCommand() }))
        .rejects.toMatchObject({ statusCode: 403 });
      expect(context.service.listAudits()).toMatchObject([{
        authorizationDecision: "denied",
        outcome: "rejected",
        uploadCleanup: "completed",
        packageCleanup: "not_required",
      }]);
      expect(readdirSync(context.service.uploadRoot)).toEqual([]);
      context.sqlite.close();
    }
  });

  it("rejects invalid archives, persists a bounded reason, and removes temporary files", async () => {
    const context = fixture();
    const invalid = Buffer.from(context.archive);
    invalid[invalid.length - 1] ^= 0xff;
    await expect(context.service.import({ archive: invalid, actor: "operator", commandId: "invalid-archive" }))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(context.service.listAudits()).toMatchObject([{
      outcome: "rejected",
      authorizationDecision: "allowed",
      uploadCleanup: "completed",
      packageCleanup: "not_required",
    }]);
    expect(context.service.listAudits()[0].failureReason?.length).toBeLessThanOrEqual(512);
    expect(readdirSync(context.service.uploadRoot)).toEqual([]);
    context.sqlite.close();
  });

  it("reconciles interrupted imports from the durable install command and cleans owned leftovers", () => {
    const context = fixture();
    const manifest = makeManifest(context.sourceRoot);
    const signature: ToolProviderSignature = {
      algorithm: "ed25519",
      keyId: "release-key",
      value: sign(null, Buffer.from(canonicalJson(manifest)), context.privateKey).toString("base64"),
    };
    context.control.install(manifest, signature, context.sourceRoot, "operator", "committed:archive-install");
    insertReceiving(context, "committed");
    insertReceiving(context, "not-committed");
    writeFileSync(join(context.service.uploadRoot, "upload-orphan.tfpa"), context.archive);
    mkdirSync(join(context.service.stagingRoot, "provider-orphan"));

    const report = context.service.recoverInterrupted();
    expect(report).toEqual({ installed: 1, rejected: 1, orphaned: 2, cleanupFailures: 0 });
    expect(context.service.listAudits().map((audit) => audit.outcome)).toEqual(["installed", "rejected"]);
    expect(context.sqlite.prepare("SELECT recovered_installed, recovered_rejected, orphaned, cleanup_failures FROM tool_provider_archive_cleanup_runs").get())
      .toEqual({ recovered_installed: 1, recovered_rejected: 1, orphaned: 2, cleanup_failures: 0 });
    expect(readdirSync(context.service.uploadRoot)).toEqual([]);
    expect(readdirSync(context.service.stagingRoot)).toEqual([]);
    context.sqlite.close();
  });

  it("rejects an oversized HTTP body while streaming at the upload boundary", async () => {
    const context = fixture();
    const limited = new ToolProviderArchiveImportService(
      context.sqlite,
      context.control,
      context.controlStore,
      context.trustRoots,
      join(context.root, "limited-imports"),
      { async authorize() { return { decision: "allowed", reason: "test" }; } },
      { ...DEFAULT_TOOL_PROVIDER_ARCHIVE_POLICY, maximumArchiveBytes: 32 },
    );
    const app = Fastify();
    registerToolProviderArchiveImportRoutes(app, limited);
    const response = await app.inject({
      method: "POST",
      url: "/api/security-tools/providers/archive-import",
      headers: {
        "content-type": TOOL_PROVIDER_ARCHIVE_MEDIA_TYPE,
        "x-traceforge-actor": "operator",
        "x-traceforge-command-id": "oversized",
      },
      payload: context.archive,
    });
    expect(response.statusCode).toBe(413);
    expect(limited.listAudits()).toEqual([]);
    await app.close();
    context.sqlite.close();
  });
});

function makeManifest(sourceRoot: string): ToolProviderManifest {
  const executableBytes = "neutral provider executable";
  return {
    schemaVersion: 1,
    providerId: "neutral-provider",
    source: "managed.neutral-provider",
    version: "1.0.0",
    protocolVersion: 1,
    entrypoint: { executable: "provider.bin", arguments: [], workingDirectory: "." },
    artifact: {
      sha256: createHash("sha256").update(executableBytes).digest("hex"),
      packageSha256: inspectToolProviderPackage(sourceRoot).digest,
    },
    capabilities: ["investigation.observe"],
    tools: [{
      name: "candidate.observe", source: "managed.neutral-provider", version: "1.0.0", priority: 100,
      description: "Observe a neutral candidate", inputSchema: {}, providedCapabilities: ["investigation.observe"],
      dependencyCapabilities: [], permissionRequirements: {}, risk: "read_only", timeoutMs: 1_000,
    }],
    permissions: { network: "deny", filesystem: "read_only", process: "sandboxed", secrets: "none" },
    resources: { cpuTimeMs: 10_000, memoryBytes: 64 * 1024 * 1024, maximumProcesses: 2, maximumWriteBytes: 1_024 },
    platforms: [process.platform],
  };
}

function insertReceiving(context: ReturnType<typeof fixture>, commandId: string): void {
  const uploadPath = join(context.service.uploadRoot, `upload-${commandId}.tfpa`);
  const stagingPath = join(context.service.stagingRoot, `provider-${commandId}`);
  writeFileSync(uploadPath, context.archive, { mode: 0o600 });
  mkdirSync(stagingPath);
  context.sqlite.prepare(`
    INSERT INTO tool_provider_archive_imports
      (command_id, request_fingerprint, archive_sha256, archive_bytes, actor, authorization_decision,
       authorization_reason, outcome, upload_path, staging_path, upload_cleanup, package_cleanup, created_at)
    VALUES (?, ?, ?, ?, 'operator', 'allowed', 'test', 'receiving', ?, ?, 'pending', 'pending', ?)
  `).run(commandId, "f".repeat(64), "a".repeat(64), context.archive.length, uploadPath, stagingPath, "2026-08-29T03:00:00.000Z");
}

function makeWritable(path: string): void {
  if (!existsSync(path)) return;
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) return;
  chmodSync(path, stats.isDirectory() ? 0o700 : 0o600);
  if (stats.isDirectory()) for (const name of readdirSync(path)) makeWritable(join(path, name));
}

let commandSequence = 0;
function randomCommand(): string { commandSequence += 1; return `denied-${commandSequence}`; }
