import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutionNode } from "@traceforge/execution-node";
import {
  ExecutionToolDiscoveryRuntime,
  executionToolCatalogFingerprint,
  type ToolProviderRecoverySnapshot,
} from "@traceforge/worker-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, getSqliteClient } from "./db/client.js";
import { SqliteExecutionToolDiscoveryStateStore } from "./tool-discovery-state-adapter.js";
import { createManagedToolProviderSourceFactory } from "./managed-tool-provider-source.js";
import {
  canonicalJson,
  createToolProviderRuntimeBinding,
  SqliteToolProviderControlStore,
  ToolProviderControlPlane,
  type ToolProviderManifest,
  type ToolProviderSignature,
} from "./tool-provider-control-plane.js";
import { inspectToolProviderPackage, ManagedToolProviderPackageStore } from "./tool-provider-package-store.js";
import { SqliteToolProviderRecoveryStateStore } from "./tool-provider-recovery-adapter.js";
import { ToolProviderRecoveryReconciler } from "./tool-provider-recovery-reconciler.js";
import { recoverToolRuntimeStartup } from "./tool-runtime-startup-recovery.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length) {
    const directory = temporaryDirectories.pop()!;
    makeTreeWritable(directory);
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Tool Runtime startup recovery", () => {
  it("keeps a crash-interrupted quarantine out of the registry while independently recovering a healthy source", async () => {
    const root = mkdtempSync(join(tmpdir(), "traceforge-tool-startup-"));
    temporaryDirectories.push(root);
    const databasePath = join(root, "runtime.sqlite");
    const packageRoot = join(root, "packages");
    const workRoot = join(root, "work");
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const trustRoots = new Map([["release-key", publicKey.export({ type: "spki", format: "pem" }).toString()]]);
    const packages = new ManagedToolProviderPackageStore(packageRoot);
    const bad = providerFixture(root, "first-provider");
    const healthy = providerFixture(root, "second-provider");
    const signature = (manifest: ToolProviderManifest): ToolProviderSignature => ({
      algorithm: "ed25519", keyId: "release-key",
      value: sign(null, Buffer.from(canonicalJson(manifest)), privateKey).toString("base64"),
    });

    let sqlite = getSqliteClient(createDb(databasePath));
    const setupControl = new ToolProviderControlPlane(
      new SqliteToolProviderControlStore(sqlite), trustRoots,
      { async activate() {}, async deactivate() {}, async drain() {} }, packages,
      () => "2026-08-29T06:00:00.000Z",
    );
    setupControl.install(bad.manifest, signature(bad.manifest), bad.sourceRoot, "operator", "install-first");
    await setupControl.enable(bad.manifest.providerId, bad.manifest.version, "operator", "enable-first");
    setupControl.install(healthy.manifest, signature(healthy.manifest), healthy.sourceRoot, "operator", "install-second");
    await setupControl.enable(healthy.manifest.providerId, healthy.manifest.version, "operator", "enable-second");

    const recoveryState = new SqliteToolProviderRecoveryStateStore(sqlite);
    await recoveryState.save(quarantined(bad.manifest.providerId, bad.manifest.version));
    const discoveryState = new SqliteExecutionToolDiscoveryStateStore(sqlite);
    await discoveryState.save({
      schemaVersion: 1, source: bad.manifest.source, revision: 2, outcome: "ready",
      lastAttemptAt: "2026-08-29T05:59:00.000Z", lastSuccessAt: "2026-08-29T05:59:01.000Z",
      lastFailure: null, lastSuccessfulCatalog: bad.manifest.tools,
      catalogFingerprint: executionToolCatalogFingerprint(bad.manifest.tools), updatedAt: "2026-08-29T05:59:01.000Z",
    });
    sqlite.close();

    const firstBoot = await boot(databasePath, packages, workRoot, trustRoots);
    expect(firstBoot.control.list().find((entry) => entry.manifest.providerId === healthy.manifest.providerId)).toMatchObject({
      state: "enabled", stateReason: null,
    });
    expect(firstBoot.report).toEqual({
      reconciliation: {
        projectedToControl: ["first-provider@1.0.0"], projectedToRecovery: [], consistent: [],
      },
      providers: { enabled: ["second-provider@1.0.0"], failed: [] },
    });
    expect(firstBoot.createdSources).toEqual(["second-provider@1.0.0"]);
    expect(firstBoot.runtime.registry.get(healthy.manifest.tools[0]!.name)).toMatchObject({ lifecycle: "active" });
    expect(firstBoot.runtime.registry.get(bad.manifest.tools[0]!.name)).toBeUndefined();
    expect(firstBoot.runtime.snapshot().sources.map((source) => source.source)).toEqual([healthy.manifest.source]);
    expect(firstBoot.control.list().find((entry) => entry.manifest.providerId === bad.manifest.providerId)?.state).toBe("quarantined");
    expect(firstBoot.control.listEvents(bad.manifest.providerId).filter((event) => event.type === "quarantined")).toHaveLength(1);
    await firstBoot.runtime.close();
    firstBoot.sqlite.close();

    const secondBoot = await boot(databasePath, packages, workRoot, trustRoots);
    expect(secondBoot.report.reconciliation).toEqual({
      projectedToControl: [], projectedToRecovery: [], consistent: ["first-provider@1.0.0"],
    });
    expect(secondBoot.report.providers).toEqual({ enabled: ["second-provider@1.0.0"], failed: [] });
    expect(secondBoot.createdSources).toEqual(["second-provider@1.0.0"]);
    expect(secondBoot.runtime.registry.get(bad.manifest.tools[0]!.name)).toBeUndefined();
    expect(secondBoot.control.listEvents(bad.manifest.providerId).filter((event) => event.type === "quarantined")).toHaveLength(1);
    await secondBoot.runtime.close();
    secondBoot.sqlite.close();
  });
});

async function boot(
  databasePath: string,
  packages: ManagedToolProviderPackageStore,
  workRoot: string,
  trustRoots: ReadonlyMap<string, string>,
) {
  const sqlite = getSqliteClient(createDb(databasePath));
  const recoveryState = new SqliteToolProviderRecoveryStateStore(sqlite);
  const runtime = new ExecutionToolDiscoveryRuntime(
    [], 30_000, 3, () => new Date("2026-08-29T06:01:00.000Z"),
    new SqliteExecutionToolDiscoveryStateStore(sqlite),
  );
  const managedFactory = createManagedToolProviderSourceFactory({} as ExecutionNode, workRoot, undefined, {
    state: recoveryState, now: () => new Date("2026-08-29T06:01:00.000Z"),
  });
  const createdSources: string[] = [];
  const control = new ToolProviderControlPlane(
    new SqliteToolProviderControlStore(sqlite), trustRoots,
    createToolProviderRuntimeBinding(
      (source) => runtime.activateSource(source),
      (source) => runtime.deactivateSource(source),
      (source) => { runtime.drainSource(source); },
      (installation) => {
        createdSources.push(`${installation.manifest.providerId}@${installation.manifest.version}`);
        return managedFactory(installation);
      },
    ),
    packages,
    () => "2026-08-29T06:01:00.000Z",
  );
  const report = await recoverToolRuntimeStartup(
    runtime, new ToolProviderRecoveryReconciler(recoveryState, control), control,
  );
  return { sqlite, runtime, control, createdSources, report };
}

function providerFixture(root: string, providerId: string) {
  const sourceRoot = join(root, `source-${providerId}`);
  mkdirSync(sourceRoot);
  const content = `${providerId} executable`;
  const executable = join(sourceRoot, "provider.bin");
  writeFileSync(executable, content);
  chmodSync(executable, 0o700);
  const source = `managed.${providerId}`;
  const manifest: ToolProviderManifest = {
    schemaVersion: 1, providerId, source, version: "1.0.0", protocolVersion: 1,
    entrypoint: { executable: "provider.bin", arguments: [], workingDirectory: "." },
    artifact: {
      sha256: createHash("sha256").update(content).digest("hex"),
      packageSha256: inspectToolProviderPackage(sourceRoot).digest,
    },
    capabilities: [`fixture.${providerId}.observe`],
    tools: [{
      name: `${providerId}.observe`, source, version: "1.0.0", priority: 100,
      description: "Observe a neutral candidate", inputSchema: {},
      providedCapabilities: [`fixture.${providerId}.observe`], dependencyCapabilities: [],
      permissionRequirements: {}, risk: "read_only", timeoutMs: 1_000,
    }],
    permissions: { network: "deny", filesystem: "read_only", process: "sandboxed", secrets: "none" },
    resources: { cpuTimeMs: 10_000, memoryBytes: 64 * 1024 * 1024, maximumProcesses: 2, maximumWriteBytes: 1_024 },
    platforms: [process.platform],
  };
  return { sourceRoot, manifest };
}

function quarantined(providerId: string, version: string): ToolProviderRecoverySnapshot {
  return {
    schemaVersion: 1, identity: { providerId, version }, status: "quarantined", revision: 3,
    failures: [{ kind: "crash", message: "provider process exited", retryable: true, at: "2026-08-29T05:58:00.000Z" }],
    nextAttemptAt: null, stabilityDeadlineAt: null, quarantineReason: "failure budget exhausted",
    updatedAt: "2026-08-29T05:58:00.000Z",
  };
}

function makeTreeWritable(root: string): void {
  if (!existsSync(root)) return;
  const stats = lstatSync(root);
  chmodSync(root, stats.isDirectory() ? 0o700 : 0o600);
  if (!stats.isDirectory()) return;
  for (const name of readdirSync(root)) makeTreeWritable(join(root, name));
}
