import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, getSqliteClient } from "./db/client.js";
import { SqliteToolInvocationBindingStore } from "./worker-execution-adapters.js";
import { ToolProviderGarbageCollector } from "./tool-provider-garbage-collector.js";
import { inspectToolProviderPackage, ManagedToolProviderPackageStore } from "./tool-provider-package-store.js";
import { SqliteToolProviderControlStore, type ToolProviderManifest } from "./tool-provider-control-plane.js";

const roots: string[] = [];
afterEach(() => {
  while (roots.length) {
    const root = roots.pop()!;
    makeWritable(root);
    rmSync(root, { recursive: true, force: true });
  }
});

describe("ToolProviderGarbageCollector", () => {
  it("persists dry-run ownership decisions and deletes only old unowned package and scratch payloads", async () => {
    const root = mkdtempSync(join(tmpdir(), "traceforge-provider-gc-"));
    roots.push(root);
    const source = join(root, "source");
    const packageRoot = join(root, "packages");
    const workRoot = join(root, "work");
    mkdirSync(source);
    writeFileSync(join(source, "provider.bin"), "neutral provider");
    chmodSync(join(source, "provider.bin"), 0o700);
    const packages = new ManagedToolProviderPackageStore(packageRoot);
    const inventory = inspectToolProviderPackage(source);
    const sqlite = getSqliteClient(createDb(":memory:"));
    const control = new SqliteToolProviderControlStore(sqlite);
    const oldManifest = manifest("1.0.0", inventory.digest);
    const activeManifest = manifest("2.0.0", inventory.digest);
    install(control, packages, source, oldManifest, "install-old");
    install(control, packages, source, activeManifest, "install-active");
    sqlite.prepare("UPDATE tool_provider_manifests SET state = 'disabled', updated_at = ? WHERE version = '1.0.0'")
      .run("2026-08-27T00:00:00.000Z");
    sqlite.prepare("UPDATE tool_provider_manifests SET state = 'enabled', updated_at = ? WHERE version = '2.0.0'")
      .run("2026-08-27T00:00:00.000Z");
    const orphanPackage = join(packages.root, oldManifest.providerId, ".staging-abandoned");
    mkdirSync(orphanPackage);
    writeFileSync(join(orphanPackage, "partial"), "partial package");

    const oldScratch = scratch(workRoot, "a".repeat(64), "old payload");
    const protectedBinding = {
      idempotencyKey: "effect-protected", invocationId: "invocation-protected",
      tool: { name: "candidate.observe", source: oldManifest.source, version: oldManifest.version, contractFingerprint: "a".repeat(64) },
      inputFingerprint: "b".repeat(64), attribution: { caseId: "case-1", runId: "run-1", workId: "work-1" },
    };
    await new SqliteToolInvocationBindingStore(sqlite, () => "2026-08-27T00:00:00.000Z").prepare(protectedBinding);
    const protectedIdentity = createHash("sha256").update("run-1\0work-1\0effect-protected").digest("hex");
    const protectedScratch = scratch(workRoot, protectedIdentity, "protected payload");
    const old = new Date("2026-08-27T00:00:00.000Z");
    for (const path of [orphanPackage, join(orphanPackage, "partial"), oldScratch, join(oldScratch, "payload"), protectedScratch, join(protectedScratch, "payload")]) utimesSync(path, old, old);

    const collector = new ToolProviderGarbageCollector(
      sqlite, control, packages, workRoot,
      () => ({ registryRevision: 1, status: "ready", sources: [], providers: [{
        tool: activeManifest.tools[0]!, lifecycle: "active", health: "healthy", consecutiveFailures: 0, lastFailure: null, revision: 1,
      }] }),
      { gracePeriodMs: 1_000, maximumDeletesPerRun: 10 },
      () => "2026-08-29T00:00:00.000Z",
    );
    const dryRun = collector.collect({ dryRun: true });
    expect(dryRun.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "package", providerVersion: "1.0.0", decision: "skipped", reason: "prepared_binding" }),
      expect.objectContaining({ path: expect.stringContaining(protectedIdentity), decision: "skipped", reason: "prepared_binding" }),
      expect.objectContaining({ path: expect.stringContaining("a".repeat(64)), decision: "eligible" }),
      expect.objectContaining({ path: expect.stringContaining(".staging-abandoned"), decision: "eligible", reason: "orphaned_package_payload" }),
    ]));
    expect(existsSync(oldScratch)).toBe(true);

    await new SqliteToolInvocationBindingStore(sqlite).release("effect-protected", "terminal Work");
    const applied = collector.collect({ dryRun: false });
    expect(applied.deleted).toBe(4);
    expect(existsSync(oldScratch)).toBe(false);
    expect(existsSync(protectedScratch)).toBe(false);
    expect(existsSync(orphanPackage)).toBe(false);
    expect(control.get(oldManifest.providerId, oldManifest.version)?.state).toBe("collected");
    expect(existsSync(control.get(activeManifest.providerId, activeManifest.version)!.packageRoot)).toBe(true);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM tool_provider_gc_runs").get()).toEqual({ count: 2 });
    install(control, packages, source, oldManifest, "restore-old");
    expect(control.get(oldManifest.providerId, oldManifest.version)).toMatchObject({ state: "installed" });
    expect(existsSync(control.get(oldManifest.providerId, oldManifest.version)!.packageRoot)).toBe(true);
    sqlite.close();
  });

  it.runIf(process.platform !== "win32")("refuses a symbolic-link scratch candidate without touching its target", () => {
    const root = mkdtempSync(join(tmpdir(), "traceforge-provider-gc-link-"));
    roots.push(root);
    const packages = new ManagedToolProviderPackageStore(join(root, "packages"));
    const workRoot = join(root, "work");
    const outside = join(root, "outside");
    mkdirSync(join(workRoot, "aa"), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(outside, "keep"), "keep");
    symlinkSync(outside, join(workRoot, "aa", "a".repeat(64)));
    const sqlite = getSqliteClient(createDb(":memory:"));
    const collector = new ToolProviderGarbageCollector(
      sqlite, new SqliteToolProviderControlStore(sqlite), packages, workRoot,
      () => ({ registryRevision: 0, status: "ready", sources: [], providers: [] }),
      { gracePeriodMs: 1, maximumDeletesPerRun: 10 }, () => "2026-08-29T00:00:00.000Z",
    );
    expect(collector.collect({ dryRun: false }).candidates).toContainEqual(expect.objectContaining({ decision: "skipped", reason: "invalid_layout" }));
    expect(existsSync(join(outside, "keep"))).toBe(true);
    sqlite.close();
  });
});

function manifest(version: string, digest: string): ToolProviderManifest {
  return {
    schemaVersion: 1, providerId: "neutral-provider", source: "managed.neutral-provider", version, protocolVersion: 1,
    entrypoint: { executable: "provider.bin", arguments: [], workingDirectory: "." },
    artifact: { sha256: createHash("sha256").update("neutral provider").digest("hex"), packageSha256: digest },
    capabilities: ["investigation.observe"],
    tools: [{ name: "candidate.observe", source: "managed.neutral-provider", version, priority: 100, description: "Observe",
      inputSchema: {}, providedCapabilities: ["investigation.observe"], dependencyCapabilities: [], permissionRequirements: {}, risk: "read_only", timeoutMs: 1_000 }],
    permissions: { network: "deny", filesystem: "read_only", process: "sandboxed", secrets: "none" },
    resources: { cpuTimeMs: 1_000, memoryBytes: 64 * 1024 * 1024, maximumProcesses: 1, maximumWriteBytes: 1_024 },
    platforms: [process.platform],
  };
}

function install(control: SqliteToolProviderControlStore, packages: ManagedToolProviderPackageStore, source: string, value: ToolProviderManifest, commandId: string) {
  const packageRoot = packages.publish(source, value.providerId, value.version, value.artifact.packageSha256);
  control.install({
    manifest: value, packageRoot, fingerprint: "a".repeat(64), signature: { algorithm: "ed25519", keyId: "key", value: "signature" },
    commandFingerprint: "b".repeat(64), actor: "test", commandId, at: "2026-08-27T00:00:00.000Z",
  });
}

function scratch(root: string, identity: string, content: string): string {
  const path = join(root, identity.slice(0, 2), identity);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "payload"), content);
  return path;
}

function makeWritable(root: string): void {
  if (!existsSync(root)) return;
  const stats = lstatSync(root);
  if (stats.isSymbolicLink()) return;
  if (stats.isDirectory()) for (const name of readdirSync(root)) makeWritable(join(root, name));
  chmodSync(root, stats.isDirectory() ? 0o700 : 0o600);
}
