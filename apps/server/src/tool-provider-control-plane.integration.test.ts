import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { createDb, getSqliteClient } from "./db/client.js";
import {
  canonicalJson,
  registerToolProviderControlRoutes,
  SqliteToolProviderControlStore,
  ToolProviderControlPlane,
  type ToolProviderManifest,
  type ToolProviderRuntimeBinding,
  type ToolProviderSignature,
} from "./tool-provider-control-plane.js";
import { inspectToolProviderPackage, ManagedToolProviderPackageStore } from "./tool-provider-package-store.js";

const temporaryDirectories: string[] = [];
afterEach(() => {
  while (temporaryDirectories.length) {
    const directory = temporaryDirectories.pop()!;
    makeTreeWritable(directory);
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeTreeWritable(root: string): void {
  if (!existsSync(root)) return;
  const stats = lstatSync(root);
  chmodSync(root, stats.isDirectory() ? 0o700 : 0o600);
  if (!stats.isDirectory()) return;
  for (const name of readdirSync(root)) makeTreeWritable(join(root, name));
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "traceforge-provider-control-"));
  temporaryDirectories.push(directory);
  const sourceRoot = join(directory, "source");
  const managedRoot = join(directory, "managed");
  mkdirSync(sourceRoot);
  const executable = join(sourceRoot, "provider.bin");
  writeFileSync(executable, "first candidate provider");
  chmodSync(executable, 0o700);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const sqlite = getSqliteClient(createDb(":memory:"));
  const activations: string[] = [];
  const deactivations: string[] = [];
  const drains: string[] = [];
  const runtime: ToolProviderRuntimeBinding = {
    async activate(installation) { activations.push(`${installation.manifest.providerId}@${installation.manifest.version}`); },
    async deactivate(source) { deactivations.push(source); },
    async drain(source) { drains.push(source); },
  };
  const store = new SqliteToolProviderControlStore(sqlite);
  const packages = new ManagedToolProviderPackageStore(managedRoot);
  const control = new ToolProviderControlPlane(
    store,
    new Map([["release-key", publicKey.export({ type: "spki", format: "pem" }).toString()]]),
    runtime,
    packages,
    () => "2026-08-27T12:00:00.000Z",
  );
  const manifest = (version = "1.0.0"): ToolProviderManifest => ({
    schemaVersion: 1,
    providerId: "neutral-provider",
    source: "managed.neutral-provider",
    version,
    protocolVersion: 1,
    entrypoint: { executable: "provider.bin", arguments: [], workingDirectory: "." },
    artifact: {
      sha256: createHash("sha256").update("first candidate provider").digest("hex"),
      packageSha256: inspectToolProviderPackage(sourceRoot).digest,
    },
    capabilities: ["investigation.observe"],
    tools: [{
      name: "candidate.observe", source: "managed.neutral-provider", version, priority: 100,
      description: "Observe a neutral candidate", inputSchema: {}, providedCapabilities: ["investigation.observe"],
      dependencyCapabilities: [], permissionRequirements: {}, risk: "read_only", timeoutMs: 1_000,
    }],
    permissions: { network: "deny", filesystem: "read_only", process: "sandboxed", secrets: "none" },
    resources: { cpuTimeMs: 10_000, memoryBytes: 64 * 1024 * 1024, maximumProcesses: 2, maximumWriteBytes: 1024 },
    platforms: [process.platform],
  });
  const signature = (value: ToolProviderManifest): ToolProviderSignature => ({
    algorithm: "ed25519",
    keyId: "release-key",
    value: sign(null, Buffer.from(canonicalJson(value)), privateKey).toString("base64"),
  });
  return { sqlite, store, control, manifest, signature, activations, deactivations, drains, runtime, publicKey, packages, directory, sourceRoot, managedRoot, executable };
}

describe("Tool Provider supply-chain control plane", () => {
  it("installs a signed manifest and persists audited lifecycle commands", async () => {
    const context = fixture();
    const manifest = context.manifest();
    const installed = context.control.install(manifest, context.signature(manifest), context.sourceRoot, "operator", "install-1");
    expect(installed.state).toBe("installed");
    expect(installed.packageRoot.startsWith(context.packages.root)).toBe(true);
    expect(installed.packageRoot).not.toBe(context.sourceRoot);

    const enabled = await context.control.enable(manifest.providerId, manifest.version, "operator", "enable-1");
    expect(enabled.state).toBe("enabled");
    expect(context.activations).toEqual(["neutral-provider@1.0.0"]);
    expect(context.control.install(manifest, context.signature(manifest), context.sourceRoot, "operator", "install-1").state).toBe("installed");

    const draining = await context.control.drain(manifest.providerId, manifest.version, "maintenance", "operator", "drain-1");
    expect(draining.state).toBe("draining");
    expect(context.drains).toEqual([manifest.source]);

    const disabled = await context.control.disable(manifest.providerId, manifest.version, "maintenance complete", "operator", "disable-1");
    expect(disabled.state).toBe("disabled");
    expect(context.deactivations).toEqual([manifest.source]);
    expect(context.control.listEvents(manifest.providerId).map((event) => event.type)).toEqual([
      "installed", "enabled", "draining", "disabled",
    ]);
    context.sqlite.close();
  });

  it("rejects unsigned content, executable tampering, and command reuse with different input", () => {
    const context = fixture();
    const manifest = context.manifest();
    const signature = context.signature(manifest);
    expect(() => context.control.install(manifest, { ...signature, value: Buffer.alloc(64).toString("base64") }, context.sourceRoot, "operator", "bad-signature"))
      .toThrow("signature verification failed");

    context.control.install(manifest, signature, context.sourceRoot, "operator", "install-1");
    expect(() => context.control.install({ ...manifest, capabilities: ["investigation.mutate"] }, signature, context.sourceRoot, "operator", "install-1"))
      .toThrow("already used with different input");

    const escaping = { ...manifest, version: "1.0.1", entrypoint: { ...manifest.entrypoint, executable: "../outside" } };
    expect(() => context.control.install(escaping, context.signature(escaping), context.sourceRoot, "operator", "escaping"))
      .toThrow("package root");

    writeFileSync(context.executable, "tampered provider");
    const tampered = { ...manifest, version: "1.0.2", tools: manifest.tools.map((tool) => ({ ...tool, version: "1.0.2" })) };
    expect(() => context.control.install(tampered, context.signature(tampered), context.sourceRoot, "operator", "tampered"))
      .toThrow(/hash does not match|package digest/);
    context.sqlite.close();
  });

  it("blocks implicit downgrade, supports explicit rollback, and restores only enabled versions", async () => {
    const context = fixture();
    const first = context.manifest("1.0.0");
    const second = context.manifest("2.0.0");
    context.control.install(first, context.signature(first), context.sourceRoot, "operator", "install-1");
    await context.control.enable(first.providerId, first.version, "operator", "enable-1");
    context.control.install(second, context.signature(second), context.sourceRoot, "operator", "install-2");
    await context.control.enable(second.providerId, second.version, "operator", "enable-2");

    expect(context.store.get(first.providerId, first.version)?.state).toBe("disabled");
    await expect(context.control.enable(first.providerId, first.version, "operator", "implicit-downgrade"))
      .rejects.toThrow("Refusing implicit downgrade");

    const rolledBack = await context.control.rollback(
      first.providerId, second.version, first.version, "regression detected", "operator", "rollback-1",
    );
    expect(rolledBack.state).toBe("enabled");
    expect(context.store.get(second.providerId, second.version)?.state).toBe("disabled");

    const recovered: string[] = [];
    const restarted = new ToolProviderControlPlane(
      context.store,
      new Map([["release-key", context.publicKey.export({ type: "spki", format: "pem" }).toString()]]),
      { async activate(installation) { recovered.push(`${installation.manifest.providerId}@${installation.manifest.version}`); }, async deactivate() {}, async drain() {} },
      context.packages,
      () => "2026-08-27T12:05:00.000Z",
    );
    await expect(restarted.recover()).resolves.toEqual({ enabled: ["neutral-provider@1.0.0"], failed: [] });
    expect(recovered).toEqual(["neutral-provider@1.0.0"]);
    context.sqlite.close();
  });

  it("persists the new version and the old drain before waiting for in-flight calls", async () => {
    const context = fixture();
    const first = context.manifest("1.0.0");
    const second = context.manifest("2.0.0");
    context.control.install(first, context.signature(first), context.sourceRoot, "operator", "install-1");
    await context.control.enable(first.providerId, first.version, "operator", "enable-1");
    context.control.install(second, context.signature(second), context.sourceRoot, "operator", "install-2");

    let release!: () => void;
    const drained = new Promise<void>((resolve) => { release = resolve; });
    context.runtime.activate = async (installation) => installation.manifest.version === "2.0.0" ? { drained } : undefined;
    const upgrading = context.control.enable(second.providerId, second.version, "operator", "enable-2");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(context.store.get(first.providerId, first.version)?.state).toBe("draining");
    expect(context.store.get(second.providerId, second.version)?.state).toBe("enabled");
    release();
    await expect(upgrading).resolves.toMatchObject({ state: "enabled", manifest: { version: "2.0.0" } });
    expect(context.store.get(first.providerId, first.version)?.state).toBe("disabled");
    context.sqlite.close();
  });

  it("reconciles a durable interrupted drain after restart without replaying old invocation ownership", async () => {
    const context = fixture();
    const first = context.manifest("1.0.0");
    const second = context.manifest("2.0.0");
    context.control.install(first, context.signature(first), context.sourceRoot, "operator", "install-1");
    await context.control.enable(first.providerId, first.version, "operator", "enable-1");
    context.control.install(second, context.signature(second), context.sourceRoot, "operator", "install-2");
    context.store.activateVersion({
      providerId: first.providerId, version: second.version, previous: [context.store.get(first.providerId, first.version)!],
      eventType: "enabled", reason: null, actor: "operator", commandId: "enable-2",
      fingerprint: createHash("sha256").update("interrupted-upgrade").digest("hex"), at: "2026-08-27T12:01:00.000Z",
    });

    const recovered: string[] = [];
    const restarted = new ToolProviderControlPlane(
      context.store,
      new Map([["release-key", context.publicKey.export({ type: "spki", format: "pem" }).toString()]]),
      { async activate(installation) { recovered.push(`${installation.manifest.providerId}@${installation.manifest.version}`); }, async deactivate() {}, async drain() {} },
      context.packages,
      () => "2026-08-27T12:05:00.000Z",
    );
    await expect(restarted.recover()).resolves.toEqual({ enabled: ["neutral-provider@2.0.0"], failed: [] });
    expect(recovered).toEqual(["neutral-provider@2.0.0"]);
    expect(context.store.get(first.providerId, first.version)?.state).toBe("disabled");
    expect(context.store.get(second.providerId, second.version)?.state).toBe("enabled");
    context.sqlite.close();
  });

  it("serializes lifecycle commands for the same Provider while an upgrade is draining", async () => {
    const context = fixture();
    const first = context.manifest("1.0.0");
    const second = context.manifest("2.0.0");
    context.control.install(first, context.signature(first), context.sourceRoot, "operator", "install-1");
    await context.control.enable(first.providerId, first.version, "operator", "enable-1");
    context.control.install(second, context.signature(second), context.sourceRoot, "operator", "install-2");
    let release!: () => void;
    const drained = new Promise<void>((resolve) => { release = resolve; });
    context.runtime.activate = async (installation) => installation.manifest.version === "2.0.0" ? { drained } : undefined;

    const upgrading = context.control.enable(second.providerId, second.version, "operator", "enable-2");
    const draining = context.control.drain(second.providerId, second.version, "maintenance", "operator", "drain-2");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(context.drains).toEqual([]);

    release();
    await upgrading;
    await expect(draining).resolves.toMatchObject({ state: "draining", manifest: { version: "2.0.0" } });
    expect(context.drains).toEqual([second.source]);
    context.sqlite.close();
  });

  it("does not deactivate the active source when quarantining an inactive version", async () => {
    const context = fixture();
    const first = context.manifest("1.0.0");
    const second = context.manifest("2.0.0");
    context.control.install(first, context.signature(first), context.sourceRoot, "operator", "install-1");
    await context.control.enable(first.providerId, first.version, "operator", "enable-1");
    context.control.install(second, context.signature(second), context.sourceRoot, "operator", "install-2");
    await context.control.enable(second.providerId, second.version, "operator", "enable-2");

    await context.control.quarantine(first.providerId, first.version, "historic version revoked", "operator", "quarantine-1");
    expect(context.deactivations).toEqual([]);
    expect(context.store.get(second.providerId, second.version)?.state).toBe("enabled");
    context.sqlite.close();
  });

  it("exposes installation, lifecycle, inventory, and audit operations through the control API", async () => {
    const context = fixture();
    const manifest = context.manifest();
    const app = Fastify();
    registerToolProviderControlRoutes(app, context.control);

    const installed = await app.inject({
      method: "POST", url: "/api/security-tools/providers/install",
      payload: { manifest, signature: context.signature(manifest), packageRoot: context.sourceRoot, actor: "operator", commandId: "install-api" },
    });
    expect(installed.statusCode).toBe(201);
    const enabled = await app.inject({
      method: "POST", url: "/api/security-tools/providers/neutral-provider/versions/1.0.0/enable",
      payload: { actor: "operator", commandId: "enable-api" },
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json()).toMatchObject({ state: "enabled", manifest: { providerId: "neutral-provider" } });

    const inventory = await app.inject({ method: "GET", url: "/api/security-tools/providers" });
    expect(inventory.json()).toMatchObject({ providers: [{ state: "enabled" }] });
    const audit = await app.inject({ method: "GET", url: "/api/security-tools/providers/events?providerId=neutral-provider" });
    expect(audit.json()).toMatchObject({ events: [{ type: "installed" }, { type: "enabled" }] });
    await app.close();
    context.sqlite.close();
  });
});
