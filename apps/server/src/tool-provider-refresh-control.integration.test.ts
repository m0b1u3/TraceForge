import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { ExecutionToolDiscoveryRuntime, type ExecutionToolAdapter } from "@traceforge/worker-runtime";
import { createDb, getSqliteClient } from "./db/client.js";
import { SqliteExecutionToolDiscoveryStateStore } from "./tool-discovery-state-adapter.js";
import {
  canonicalJson,
  createToolProviderRuntimeBinding,
  SqliteToolProviderControlStore,
  ToolProviderControlPlane,
  type ToolProviderManifest,
  type ToolProviderSignature,
} from "./tool-provider-control-plane.js";
import { inspectToolProviderPackage, ManagedToolProviderPackageStore } from "./tool-provider-package-store.js";
import {
  registerToolProviderRefreshRoutes,
  ToolProviderRefreshControl,
  type ToolProviderRefreshAuthorizer,
} from "./tool-provider-refresh-control.js";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    makeWritable(directory);
    rmSync(directory, { recursive: true, force: true });
  }
});

async function fixture(authorizer?: ToolProviderRefreshAuthorizer) {
  const root = mkdtempSync(join(tmpdir(), "traceforge-provider-refresh-"));
  temporaryDirectories.push(root);
  const sourceRoot = join(root, "source");
  mkdirSync(sourceRoot);
  const executable = join(sourceRoot, "provider.bin");
  writeFileSync(executable, "neutral provider executable");
  chmodSync(executable, 0o700);
  const manifest = makeManifest(sourceRoot);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const signature: ToolProviderSignature = {
    algorithm: "ed25519",
    keyId: "release-key",
    value: sign(null, Buffer.from(canonicalJson(manifest)), privateKey).toString("base64"),
  };
  const sqlite = getSqliteClient(createDb(":memory:"));
  const runtime = new ExecutionToolDiscoveryRuntime([], 0, 3, () => new Date("2026-08-29T04:00:00.000Z"), new SqliteExecutionToolDiscoveryStateStore(sqlite));
  let discoveryCalls = 0;
  let discoveryError: Error | null = null;
  let catalog = adapters(manifest);
  const gates: Array<Promise<void>> = [];
  const controlStore = new SqliteToolProviderControlStore(sqlite);
  const control = new ToolProviderControlPlane(
    controlStore,
    new Map([["release-key", publicKey.export({ type: "spki", format: "pem" }).toString()]]),
    createToolProviderRuntimeBinding(
      (source) => runtime.activateSource(source),
      (source) => runtime.deactivateSource(source),
      (source) => { runtime.drainSource(source); },
      async () => ({
        source: manifest.source,
        async discover() {
          discoveryCalls += 1;
          const gate = gates.shift();
          if (gate) await gate;
          if (discoveryError) throw discoveryError;
          return catalog;
        },
      }),
    ),
    new ManagedToolProviderPackageStore(join(root, "packages")),
    () => "2026-08-29T04:00:00.000Z",
  );
  control.install(manifest, signature, sourceRoot, "operator", "install");
  const enabled = await control.enable(manifest.providerId, manifest.version, "operator", "enable");
  expect(enabled.state).toBe("enabled");
  const refresh = new ToolProviderRefreshControl(
    sqlite,
    control,
    runtime,
    authorizer ?? { async authorize() { return { decision: "allowed", reason: "operator refresh grant" }; } },
    () => "2026-08-29T04:01:00.000Z",
  );
  return {
    root, sqlite, runtime, control, manifest, refresh,
    discoveryCalls: () => discoveryCalls,
    fail(error: Error | null) { discoveryError = error; },
    setCatalog(value: ExecutionToolAdapter[]) { catalog = value; },
    gate(value: Promise<void>) { gates.push(value); },
  };
}

describe("Tool Provider explicit refresh control", () => {
  it("refreshes an enabled exact version, audits the stable signed catalog, and replays idempotently", async () => {
    const context = await fixture();
    const app = Fastify();
    registerToolProviderRefreshRoutes(app, context.refresh);
    const request = {
      method: "POST" as const,
      url: "/api/security-tools/providers/neutral-provider/versions/1.0.0/refresh",
      payload: { actor: "operator", commandId: "refresh-1", reason: "manual reconciliation" },
    };
    const first = await app.inject(request);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      replayed: false,
      audit: { outcome: "succeeded", beforeRevision: 1, afterRevision: 2, catalogChanged: false },
    });
    const replay = await app.inject(request);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ replayed: true, audit: { commandId: "refresh-1" } });
    expect((await app.inject({
      method: "POST",
      url: "/api/security-tools/providers/neutral-provider/versions/1.0.0/refresh",
    })).statusCode).toBe(400);
    expect(context.discoveryCalls()).toBe(2);
    await app.close();
    context.sqlite.close();
  });

  it("retains the signed catalog and returns the same durable failure without rediscovery", async () => {
    const context = await fixture();
    context.fail(new Error("catalog probe unavailable"));
    const input = {
      providerId: context.manifest.providerId, version: context.manifest.version,
      actor: "operator", commandId: "refresh-failed", reason: "recover degraded discovery",
    };
    await expect(context.refresh.refresh(input)).rejects.toMatchObject({ statusCode: 502 });
    expect(context.runtime.registry.get("candidate.observe")).toMatchObject({ lifecycle: "active" });
    expect(context.refresh.listAudits()).toMatchObject([{
      outcome: "failed", beforeRevision: 1, afterRevision: 2, catalogChanged: false,
      failureReason: "catalog probe unavailable",
    }]);
    await expect(context.refresh.refresh(input)).rejects.toThrow("catalog probe unavailable");
    expect(context.discoveryCalls()).toBe(2);
    context.sqlite.close();
  });

  it("fails closed on denied or broken authorization without invoking discovery", async () => {
    for (const authorizer of [
      { async authorize() { return { decision: "denied" as const, reason: "refresh role is missing" }; } },
      { async authorize(): Promise<{ decision: "allowed"; reason: string }> { throw new Error("authorizer unavailable"); } },
    ]) {
      const context = await fixture(authorizer);
      await expect(context.refresh.refresh({
        providerId: context.manifest.providerId, version: context.manifest.version,
        actor: "operator", commandId: `denied-${context.discoveryCalls()}`, reason: "manual refresh",
      })).rejects.toMatchObject({ statusCode: 403 });
      expect(context.discoveryCalls()).toBe(1);
      expect(context.refresh.listAudits()).toMatchObject([{ authorizationDecision: "denied", outcome: "denied" }]);
      context.sqlite.close();
    }
  });

  it("rejects disabled versions and catalogs that differ from the signed manifest", async () => {
    const disabled = await fixture();
    await disabled.control.disable(
      disabled.manifest.providerId, disabled.manifest.version, "maintenance", "operator", "disable",
    );
    await expect(disabled.refresh.refresh({
      providerId: disabled.manifest.providerId, version: disabled.manifest.version,
      actor: "operator", commandId: "disabled-refresh", reason: "manual refresh",
    })).rejects.toMatchObject({ statusCode: 409 });
    expect(disabled.discoveryCalls()).toBe(1);
    disabled.sqlite.close();

    const mismatch = await fixture();
    mismatch.setCatalog([]);
    await expect(mismatch.refresh.refresh({
      providerId: mismatch.manifest.providerId, version: mismatch.manifest.version,
      actor: "operator", commandId: "catalog-mismatch", reason: "manual refresh",
    })).rejects.toMatchObject({ statusCode: 502 });
    expect(mismatch.runtime.registry.get("candidate.observe")).toMatchObject({ lifecycle: "active" });
    expect(mismatch.refresh.listAudits()).toMatchObject([{
      outcome: "failed", catalogChanged: false,
      failureReason: expect.stringContaining("differs from its signed manifest"),
    }]);
    mismatch.sqlite.close();
  });

  it("serializes distinct commands for the same Provider instead of coalescing their refreshes", async () => {
    const context = await fixture();
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    context.gate(new Promise<void>((resolve) => { releaseFirst = resolve; }));
    context.gate(new Promise<void>((resolve) => { releaseSecond = resolve; }));
    const first = context.refresh.refresh({
      providerId: context.manifest.providerId, version: context.manifest.version,
      actor: "operator", commandId: "serial-1", reason: "first refresh",
    });
    const second = context.refresh.refresh({
      providerId: context.manifest.providerId, version: context.manifest.version,
      actor: "operator", commandId: "serial-2", reason: "second refresh",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(context.discoveryCalls()).toBe(2);
    releaseFirst();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(context.discoveryCalls()).toBe(3);
    releaseSecond();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(context.refresh.listAudits().map((audit) => audit.outcome)).toEqual(["succeeded", "succeeded"]);
    context.sqlite.close();
  });

  it("marks an interrupted running command failed without executing it again", async () => {
    const context = await fixture();
    context.sqlite.prepare(`
      INSERT INTO tool_provider_refresh_audits
        (command_id, request_fingerprint, actor, provider_id, provider_version, source, requested_reason,
         authorization_decision, authorization_reason, outcome, created_at)
      VALUES ('interrupted', ?, 'operator', ?, ?, ?, 'manual refresh', 'allowed', 'test', 'running', ?)
    `).run("f".repeat(64), context.manifest.providerId, context.manifest.version, context.manifest.source, "2026-08-29T04:00:00.000Z");
    expect(context.refresh.recoverInterrupted()).toBe(1);
    expect(context.refresh.listAudits()).toMatchObject([{
      commandId: "interrupted", outcome: "failed", failureReason: expect.stringContaining("interrupted"),
    }]);
    expect(context.discoveryCalls()).toBe(1);
    context.sqlite.close();
  });
});

function makeManifest(sourceRoot: string): ToolProviderManifest {
  return {
    schemaVersion: 1,
    providerId: "neutral-provider",
    source: "managed.neutral-provider",
    version: "1.0.0",
    protocolVersion: 1,
    entrypoint: { executable: "provider.bin", arguments: [], workingDirectory: "." },
    artifact: {
      sha256: createHash("sha256").update("neutral provider executable").digest("hex"),
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

function adapters(manifest: ToolProviderManifest): ExecutionToolAdapter[] {
  return manifest.tools.map((tool) => ({
    ...tool,
    async execute() { return { status: "succeeded", summary: "done", raw: "", refs: [], retryable: false }; },
  }));
}

function makeWritable(path: string): void {
  if (!existsSync(path)) return;
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) return;
  chmodSync(path, stats.isDirectory() ? 0o700 : 0o600);
  if (stats.isDirectory()) for (const name of readdirSync(path)) makeWritable(join(path, name));
}
