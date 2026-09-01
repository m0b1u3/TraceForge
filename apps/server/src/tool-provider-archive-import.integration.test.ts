import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
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

const filesystemFaults = vi.hoisted(() => ({
  intercept: null as null | ((operation: string, args: unknown[]) => { value: unknown } | void),
}));
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const wrapped = Object.fromEntries(["writeSync", "writeFileSync", "mkdtempSync", "mkdirSync", "renameSync", "rmSync"].map((name) => [
    name,
    (...args: unknown[]) => {
      const override = filesystemFaults.intercept?.(name, args);
      if (override) return override.value;
      return (actual[name as keyof typeof actual] as (...values: unknown[]) => unknown)(...args);
    },
  ]));
  return { ...actual, ...wrapped };
});

const temporaryDirectories: string[] = [];
afterEach(() => {
  filesystemFaults.intercept = null;
  for (const directory of temporaryDirectories.splice(0)) {
    makeWritable(directory);
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture(authorizer?: ToolProviderArchiveImportAuthorizer) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "traceforge-provider-import-")));
  temporaryDirectories.push(root);
  const sourceRoot = join(root, "source");
  mkdirSync(sourceRoot);
  const executable = join(sourceRoot, "provider.bin");
  writeFileSync(executable, "neutral provider executable");
  chmodSync(executable, 0o700);
  mkdirSync(join(sourceRoot, "assets"));
  writeFileSync(join(sourceRoot, "assets", "metadata.json"), "{}");
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

describe("Provider archive filesystem fault injection", () => {
  it.each(["disk-full", "no-progress"])("audits %s upload writes without authorizing or installing", async (fault) => {
    let authorizations = 0;
    const context = fixture({ async authorize() {
      authorizations += 1;
      return { decision: "allowed", reason: "test" };
    } });
    filesystemFaults.intercept = (operation) => {
      if (operation !== "writeSync") return;
      if (fault === "no-progress") return { value: 0 };
      throw new Error("ENOSPC: injected upload write failure");
    };
    await expect(context.service.import({ archive: context.archive, actor: "operator", commandId: "write-failed" }))
      .rejects.toMatchObject({ statusCode: 500 });
    expect(authorizations).toBe(0);
    expect(context.control.list()).toEqual([]);
    expect(context.service.listAudits()).toEqual([]);
    expect(context.service.listReceiveFailures()).toMatchObject([{
      commandId: "write-failed", receivedBytes: context.archive.length, uploadCleanup: "completed",
    }]);
    expect(readdirSync(context.service.uploadRoot)).toEqual([]);
    filesystemFaults.intercept = null;
    await expect(context.service.import({ archive: context.archive, actor: "operator", commandId: "write-failed" }))
      .resolves.toMatchObject({ installation: { state: "installed" } });
    expect(authorizations).toBe(1);
    context.sqlite.close();
  });

  it("recovers a partial upload whose initial cleanup failed without inventing a complete digest or authorization", async () => {
    const context = fixture();
    filesystemFaults.intercept = (operation, args) => {
      if (operation === "rmSync" && String(args[0]).startsWith(context.service.uploadRoot)) {
        throw new Error("EACCES: injected upload cleanup failure");
      }
    };
    const archive = (async function* () {
      yield context.archive.subarray(0, 12);
      throw new Error("injected receive interruption");
    })();
    await expect(context.service.importStream({ archive, actor: "operator", commandId: "interrupted-receive" }))
      .rejects.toThrow("injected receive interruption");
    expect(context.service.listReceiveFailures()).toMatchObject([{
      receivedBytes: 12, uploadCleanup: "failed", failureReason: "injected receive interruption",
    }]);
    expect(context.service.listAudits()).toEqual([]);
    expect(context.control.list()).toEqual([]);
    expect(readdirSync(context.service.uploadRoot)).toHaveLength(1);
    filesystemFaults.intercept = null;
    const restarted = new ToolProviderArchiveImportService(
      context.sqlite, context.control, context.controlStore, context.trustRoots, join(context.root, "imports"),
      { async authorize() { throw new Error("recovery must not authorize or install"); } },
    );
    expect(restarted.recoverInterrupted()).toEqual({ installed: 0, rejected: 0, orphaned: 0, cleanupFailures: 0 });
    expect(restarted.listReceiveFailures()).toMatchObject([{ uploadCleanup: "completed" }]);
    expect(readdirSync(restarted.uploadRoot)).toEqual([]);
    expect(context.control.list()).toEqual([]);
    context.sqlite.close();
  });

  it.each(["allocate", "extract-directory", "extract-write", "publish-rename"])("rejects %s failures without publishing an installation", async (fault) => {
    const context = fixture();
    filesystemFaults.intercept = (operation, args) => {
      const path = String(args[0]);
      const matches = (fault === "allocate" && operation === "mkdtempSync" && path.startsWith(context.service.stagingRoot))
        || (fault === "extract-directory" && operation === "mkdirSync" && path.startsWith(join(context.service.stagingRoot, "provider-")))
        || (fault === "extract-write" && operation === "writeFileSync" && path.startsWith(context.service.stagingRoot))
        || (fault === "publish-rename" && operation === "renameSync" && path.startsWith(join(context.root, "packages")));
      if (matches) throw new Error(`${fault === "allocate" || fault === "extract-directory" ? "EACCES" : "ENOSPC"}: injected ${fault} failure`);
    };
    await expect(context.service.import({ archive: context.archive, actor: "operator", commandId: fault }))
      .rejects.toMatchObject({ statusCode: 500 });
    expect(context.control.list()).toEqual([]);
    expect(context.service.listAudits()).toMatchObject([{
      outcome: "rejected", failureReason: expect.stringContaining(fault), uploadCleanup: "completed",
      packageCleanup: fault === "allocate" ? "not_required" : "completed",
    }]);
    expect(readdirSync(context.service.uploadRoot)).toEqual([]);
    expect(readdirSync(context.service.stagingRoot)).toEqual([]);
    const providerRoot = join(context.root, "packages", context.manifest.providerId);
    if (existsSync(providerRoot)) expect(readdirSync(providerRoot)).toEqual([]);
    context.sqlite.close();
  });

  it("records extraction ownership before writes and retries failed staging cleanup", async () => {
    const context = fixture();
    filesystemFaults.intercept = (operation, args) => {
      if (!String(args[0]).startsWith(context.service.stagingRoot)) return;
      if (operation === "writeFileSync") throw new Error("ENOSPC: injected extraction failure");
      if (operation === "rmSync") throw new Error("EACCES: injected staging cleanup failure");
    };
    await expect(context.service.import({ archive: context.archive, actor: "operator", commandId: "extract-cleanup-failed" }))
      .rejects.toMatchObject({ statusCode: 500 });
    expect(context.service.listAudits()).toMatchObject([{
      outcome: "rejected", packageCleanup: "failed", uploadCleanup: "completed",
      failureReason: expect.stringContaining("extraction failure"),
    }]);
    expect(context.service.listAudits()[0].failureReason).toContain("staging cleanup failure");
    expect(readdirSync(context.service.stagingRoot)).toHaveLength(1);
    expect(context.control.list()).toEqual([]);
    filesystemFaults.intercept = null;
    expect(context.service.recoverInterrupted().cleanupFailures).toBe(0);
    expect(context.service.listAudits()).toMatchObject([{ outcome: "rejected", packageCleanup: "completed" }]);
    expect(readdirSync(context.service.stagingRoot)).toEqual([]);
    context.sqlite.close();
  });

  it.each(["upload", "staging"])("preserves a committed installation while retrying %s cleanup", async (kind) => {
    const context = fixture();
    const cleanupRoot = kind === "upload" ? context.service.uploadRoot : context.service.stagingRoot;
    filesystemFaults.intercept = (operation, args) => {
      if (operation === "rmSync" && String(args[0]).startsWith(cleanupRoot)) throw new Error("EACCES: cleanup denied");
    };
    const result = await context.service.import({ archive: context.archive, actor: "operator", commandId: "cleanup-failed" });
    expect(result.installation.state).toBe("installed");
    expect(result.audit[kind === "upload" ? "uploadCleanup" : "packageCleanup"]).toBe("failed");
    expect(readdirSync(cleanupRoot)).toHaveLength(1);
    filesystemFaults.intercept = null;
    expect(context.service.recoverInterrupted().cleanupFailures).toBe(0);
    expect(context.service.listAudits()).toMatchObject([{
      outcome: "installed", uploadCleanup: "completed", packageCleanup: "completed",
    }]);
    const replay = await context.service.import({ archive: context.archive, actor: "operator", commandId: "cleanup-failed" });
    expect(replay.replayed).toBe(true);
    expect(context.control.listEvents(context.manifest.providerId)).toHaveLength(1);
    expect(existsSync(result.installation.packageRoot)).toBe(true);
    context.sqlite.close();
  });

  it("refuses cleanup records pointing outside the managed upload root", async () => {
    const context = fixture();
    const outside = join(context.root, "upload-keep.tfpa");
    writeFileSync(outside, "user content");
    context.sqlite.prepare(`
      INSERT INTO tool_provider_archive_receive_failures
        (id, command_id, actor, received_bytes, failure_reason, upload_path, upload_cleanup, created_at, updated_at)
      VALUES ('outside', 'outside', 'operator', 0, 'interrupted', ?, 'failed', ?, ?)
    `).run(outside, new Date().toISOString(), new Date().toISOString());
    expect(context.service.recoverInterrupted().cleanupFailures).toBe(1);
    expect(readFileSync(outside, "utf8")).toBe("user content");
    expect(context.service.listReceiveFailures()).toMatchObject([{ uploadCleanup: "failed" }]);
    context.sqlite.close();
  });

  it("completes short writes without truncating the signed archive", async () => {
    const context = fixture();
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    let writes = 0;
    filesystemFaults.intercept = (operation, args) => {
      if (operation !== "writeSync") return;
      writes += 1;
      return { value: actual.writeSync(args[0] as number, args[1] as Buffer, args[2] as number, Math.min(7, args[3] as number)) };
    };
    const result = await context.service.import({ archive: context.archive, actor: "operator", commandId: "short-writes" });
    expect(result.installation.state).toBe("installed");
    expect(result.audit.archiveSha256).toBe(createHash("sha256").update(context.archive).digest("hex"));
    expect(writes).toBe(Math.ceil(context.archive.length / 7));
    context.sqlite.close();
  });

  it.runIf(process.platform !== "win32")("refuses cleanup after the upload root is replaced by a symbolic link", () => {
    const context = fixture();
    const outside = join(context.root, "user-files");
    mkdirSync(outside);
    const sentinel = join(outside, "upload-keep.tfpa");
    writeFileSync(sentinel, "user content");
    renameSync(context.service.uploadRoot, join(context.root, "original-uploads"));
    symlinkSync(outside, context.service.uploadRoot, "dir");
    const at = new Date().toISOString();
    context.sqlite.prepare(`
      INSERT INTO tool_provider_archive_receive_failures
        (id, command_id, actor, received_bytes, failure_reason, upload_path, upload_cleanup, created_at, updated_at)
      VALUES ('swapped-root', 'swapped-root', 'operator', 0, 'interrupted', ?, 'failed', ?, ?)
    `).run(join(context.service.uploadRoot, "upload-keep.tfpa"), at, at);
    expect(context.service.recoverInterrupted().cleanupFailures).toBe(1);
    expect(readFileSync(sentinel, "utf8")).toBe("user content");
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
