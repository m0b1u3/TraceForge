import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ScenarioPackageRegistry } from "@traceforge/scenario-sdk";
import { ExtensionAssemblyControl } from "./extension-assembly.js";
import type { FoundationMcpServer } from "./mcp-execution-source.js";
import { SqlitePackageContextStore } from "./package-context-resources.js";
import { contextBinding, contextPackage, contextText } from "./test-fixtures/context-package.js";
import { database } from "./test-fixtures/execution-recovery.js";
import type { ToolProviderInstallation, ToolProviderInstallState } from "./tool-provider-control-plane.js";

const roots: string[] = [], children = new Set<ChildProcessWithoutNullStreams>();
const crashFixture = join(import.meta.dirname, "../test-fixtures/extension-assembly-crash-host.mjs");
afterEach(async () => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL"); await new Promise<void>((resolve) => child.once("close", () => resolve()));
  }
  children.clear(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function mcp(reviewVersion = 1, serverVersion = "1"): FoundationMcpServer {
  return {
    source: "fixture.mcp", serverName: "neutral", serverVersion, reviewVersion, packages: [contextBinding],
    tools: [{ remoteName: "observe", authorizationAction: "fixture.read", validateInput() {}, authorizeInput() {},
      tool: { name: "fixture.observe", source: "fixture.mcp", version: "1", priority: 100, description: "Neutral observation",
        inputSchema: { type: "object" }, providedCapabilities: ["fixture.read"], dependencyCapabilities: [],
        permissionRequirements: {}, risk: "read_only", timeoutMs: 1_000 } }],
    process: { executable: "/fixture/provider", workingDirectory: "/fixture", environment: {},
      attribution: { caseId: "service", runId: "service", workId: "service", workerId: "service", scopeRef: "service",
        leaseId: "service", leaseExpiresAt: "2099-01-01T00:00:00.000Z", actionId: "discover", idempotencyKey: "discover" },
      permissions: { version: 1, platform: "linux", filesystem: { read: [], write: [], deny: [] }, network: "deny",
        process: { access: "sandboxed", interactive: false, background: false }, secrets: "deny", sources: ["fixture"] },
      resources: { cpuTimeMs: 1_000, memoryBytes: 64 * 1024 * 1024, maximumProcesses: 1, writeBytes: 1_024 },
      requestTimeoutMs: 1_000 },
  };
}

function installed(path = ":memory:") {
  const sqlite = database(path), packages = new ScenarioPackageRegistry([contextPackage(["fixture.read"])]);
  const store = new SqlitePackageContextStore(sqlite);
  store.install(packages, [{ package: contextBinding, resourceId: "first", content: contextText }]);
  return { sqlite, packages, store };
}

function managedProvider(state: ToolProviderInstallState): ToolProviderInstallation {
  return { manifest: { schemaVersion: 1, providerId: "neutral-provider", source: "managed.neutral", version: "1.0.0",
    protocolVersion: 1, entrypoint: { executable: "provider", arguments: [], workingDirectory: "." },
    artifact: { sha256: "a".repeat(64), packageSha256: "b".repeat(64) }, capabilities: ["fixture.read"], tools: [],
    permissions: { network: "deny", filesystem: "none", process: "sandboxed", secrets: "none" },
    resources: { cpuTimeMs: 1000, memoryBytes: 1024, maximumProcesses: 1, maximumWriteBytes: 0 }, platforms: [process.platform] },
    packageRoot: "/must-not-enter-assembly", manifestFingerprint: "c".repeat(64), signerId: "fixture-signer",
    signature: { algorithm: "ed25519", keyId: "fixture-key", value: "signature" }, state, stateReason: null,
    installedAt: "2026-09-02T00:00:00.000Z", updatedAt: "2026-09-02T00:00:00.000Z" };
}

describe("unified extension assembly", () => {
  it("persists a deterministic secret-free Package, Skill/knowledge and MCP dependency closure", () => {
    const value = installed();
    const first = new ExtensionAssemblyControl(value.sqlite, value.packages, value.store, [mcp()], []);
    expect(first.snapshot()).toMatchObject({ state: "ready", generation: 1,
      unitCounts: { package: 1, skill: 1, knowledge: 0, mcp_tool_profile: 1, mcp_context_profile: 0, process_provider: 0 } });
    expect(first.deploymentComponent()).toEqual({ kind: "extension_assembly", id: "active", version: "1",
      digest: first.snapshot().digest.slice("sha256:".length), required: true });
    expect(new ExtensionAssemblyControl(value.sqlite, value.packages, value.store, [mcp()], []).snapshot())
      .toMatchObject({ state: "ready", generation: 1, digest: first.snapshot().digest });
    const stored = value.sqlite.prepare("SELECT manifest_json FROM extension_assembly_snapshots").get() as { manifest_json: string };
    expect(stored.manifest_json).not.toMatch(/\/fixture|leaseExpiresAt|idempotencyKey/);
    value.sqlite.close();
  });

  it("rejects package widening, same-review identity replacement, and implicit profile rollback", () => {
    const value = installed(); new ExtensionAssemblyControl(value.sqlite, value.packages, value.store, [mcp(2, "2")], []);
    const changed = mcp(2, "changed");
    expect(() => new ExtensionAssemblyControl(value.sqlite, value.packages, value.store, [changed], []))
      .toThrow(/version changed identity/);
    expect(() => new ExtensionAssemblyControl(value.sqlite, value.packages, value.store, [mcp(1)], []))
      .toThrow(/rollback requires/);
    const widened = mcp(3, "3"); widened.packages = [{ id: "other", version: "1", schemaRevision: 1 }];
    expect(() => new ExtensionAssemblyControl(value.sqlite, value.packages, value.store, [widened], []))
      .toThrow(/binding.*unavailable/i);
    value.sqlite.close();
  });

  it("rolls an existing profile back only with a whole-deployment attestation", () => {
    const value = installed();
    const first = new ExtensionAssemblyControl(value.sqlite, value.packages, value.store, [mcp(1, "1")], []).snapshot();
    const second = new ExtensionAssemblyControl(value.sqlite, value.packages, value.store, [mcp(2, "2")], []).snapshot();
    expect(second).toMatchObject({ generation: 2, previousDigest: first.digest });
    expect(() => new ExtensionAssemblyControl(value.sqlite, value.packages, value.store, [mcp(1, "1")], []))
      .toThrow(/explicit control-plane operation/);
    const rolledBack = new ExtensionAssemblyControl(value.sqlite, value.packages, value.store, [mcp(1, "1")], [], {
      authorizeProfileRollback: () => ({ authorizationRef: "independent-rollback-review", deploymentRef: "release-1" }),
    }).snapshot();
    expect(rolledBack).toMatchObject({ state: "ready", generation: 3, digest: first.digest, previousDigest: second.digest });
    expect(value.sqlite.prepare("SELECT authorization_ref,deployment_ref FROM extension_assembly_profile_rollbacks").get())
      .toEqual({ authorization_ref: "independent-rollback-review", deployment_ref: "release-1" });
    expect(() => value.sqlite.exec("DELETE FROM extension_assembly_profile_rollbacks")).toThrow(/immutable/i);
    value.sqlite.close();
  });

  it("reports current Package/resource revocation without rewriting its historical assembly", () => {
    const value = installed(); const control = new ExtensionAssemblyControl(value.sqlite, value.packages, value.store, [mcp()], []);
    value.store.revoke(contextBinding.id === "neutral" ? `sha256:${"0".repeat(64)}` : "", "unrelated");
    expect(control.snapshot().state).toBe("ready");
    const resource = value.packages.list()[0]!.resourceManifest!.resources[0]!;
    value.store.revoke(resource.digest, "withdrawn");
    expect(control.snapshot()).toMatchObject({ state: "unavailable", generation: 1, digest: expect.any(String), reason: expect.stringMatching(/revoked/i) });
    expect(value.sqlite.prepare("SELECT count(*) AS n FROM extension_assembly_snapshots").get()).toEqual({ n: 1 });
    value.sqlite.close();
  });

  it("durably revokes an exact reviewed profile with authorization and immutable replay", async () => {
    const value = installed(); let authorizations = 0;
    const control = new ExtensionAssemblyControl(value.sqlite, value.packages, value.store, [mcp()], [], {
      revokeAuthorizer: { async authorize() { authorizations++; return { decision: "allowed" as const,
        authorizationRef: "independent-extension-review", expiresAt: "2099-01-01T00:00:00.000Z" }; } },
    }, () => "2026-09-02T00:00:00.000Z");
    const profileDigest = control.snapshot().digest;
    const exactProfile = value.sqlite.prepare("SELECT profile_digest FROM extension_assembly_profiles WHERE kind='mcp_tool'")
      .get() as { profile_digest: string };
    const request = { commandId: "revoke_profile", kind: "mcp_tool", source: "fixture.mcp",
      profileDigest: exactProfile.profile_digest, actor: "operator", reason: "review withdrawn" } as const;
    expect(await control.revokeProfile(request)).toMatchObject({ replayed: false, audit: { automaticResume: false } });
    expect(await control.revokeProfile(request)).toMatchObject({ replayed: true });
    expect(authorizations).toBe(2);
    expect(() => control.assertProfileAvailable("mcp_tool", "fixture.mcp", exactProfile.profile_digest)).toThrow(/revoked/i);
    expect(control.snapshot()).toMatchObject({ state: "unavailable", digest: profileDigest, reason: expect.stringMatching(/revoked/i) });
    expect(control.inspectRevocation("revoke_profile")).toMatchObject({ authorizationRef: "independent-extension-review" });
    const restarted = new ExtensionAssemblyControl(value.sqlite, value.packages, value.store, [mcp()], []);
    expect(() => restarted.assertProfileAvailable("mcp_tool", "fixture.mcp", exactProfile.profile_digest)).toThrow(/revoked/i);
    expect(() => value.sqlite.exec("DELETE FROM extension_assembly_profile_revocations")).toThrow(/immutable/i);
    value.sqlite.close();
  });

  it("projects Managed Provider install and lifecycle changes into the same assembly generations", () => {
    const value = installed(); const control = new ExtensionAssemblyControl(value.sqlite, value.packages, value.store, [mcp()], []);
    let inventory = [managedProvider("installed")]; control.attachManagedProviderInventory(() => inventory);
    expect(control.snapshot()).toMatchObject({ generation: 2, unitCounts: { managed_provider: 1 } });
    inventory = [managedProvider("enabled")];
    const enabled = control.snapshot(); expect(enabled).toMatchObject({ generation: 3, unitCounts: { managed_provider: 1 } });
    expect(control.snapshot().generation).toBe(3);
    const bodies = value.sqlite.prepare("SELECT manifest_json FROM extension_assembly_snapshots").all() as Array<{ manifest_json: string }>;
    expect(JSON.stringify(bodies)).not.toContain("must-not-enter-assembly");
    value.sqlite.close();
  });

  it("pins trusted Scenario Process launch material to the exact Package version without storing it", () => {
    const sqlite = database(), pkg = contextPackage([]); pkg.resourceManifest = undefined; pkg.createToolSources = undefined;
    pkg.runtime = { protocol: "traceforge-scenario-process-rpc", protocolVersion: 1, id: pkg.id, version: pkg.version,
      source: "scenario:neutral", entrypoint: "package://runtime/main.mjs", providedCapabilities: [], hostCapabilities: [] };
    const packages = new ScenarioPackageRegistry([pkg]), store = new SqlitePackageContextStore(sqlite);
    const launch = { executable: "/reviewed/provider", workingDirectory: "/reviewed", environment: { TOKEN: "must-not-persist" },
      attribution: { caseId: "service", runId: "service", workId: "service", workerId: "service", scopeRef: "service",
        leaseId: "service", leaseExpiresAt: "2099-01-01T00:00:00.000Z", actionId: "start", idempotencyKey: "start" },
      permissions: { version: 1 as const, platform: "linux" as const, filesystem: { read: [], write: [], deny: [] }, network: "deny" as const,
        process: { access: "sandboxed" as const, interactive: false, background: false }, secrets: "deny" as const, sources: ["fixture"] },
      resources: { cpuTimeMs: 1000, memoryBytes: 1024, maximumProcesses: 1, writeBytes: 0 } };
    const first = new ExtensionAssemblyControl(sqlite, packages, store, [], [], { scenarioProcessLaunches: { "scenario:neutral": launch } });
    expect(first.snapshot()).toMatchObject({ state: "ready", unitCounts: { process_provider: 1 } });
    expect((sqlite.prepare("SELECT manifest_json FROM extension_assembly_snapshots").get() as { manifest_json: string }).manifest_json)
      .not.toMatch(/reviewed|TOKEN|must-not-persist/);
    expect(() => new ExtensionAssemblyControl(sqlite, packages, store, [], [], { scenarioProcessLaunches: {
      "scenario:neutral": { ...launch, executable: "/changed/provider" },
    } })).toThrow(/launch profile changed/i);
    sqlite.close();
  });

  it("archives old generations only after authorization while retaining a verified lookup and hot recovery window", async () => {
    const root = mkdtempSync(join(tmpdir(), "traceforge-extension-archive-")); roots.push(root);
    let value = installed(join(root, "state.db")); let authorizations = 0;
    const control = new ExtensionAssemblyControl(value.sqlite, value.packages, value.store, [mcp()], [], {
      archiveAuthorizer: { async authorize() { authorizations++; return { decision: "allowed" as const,
        authorizationRef: "independent-history-review", expiresAt: "2099-01-01T00:00:00.000Z" }; } },
    }, () => "2026-09-02T00:00:00.000Z");
    const firstDigest = control.snapshot().digest;
    let currentProvider = managedProvider("enabled");
    for (let index = 1; index <= 40; index++) {
      currentProvider = { ...currentProvider, stateReason: `transition-${index}` };
      control.reconcileManagedProviders([currentProvider]);
    }
    const active = control.snapshot();
    expect(active).toMatchObject({ state: "ready", generation: 41 });
    const request = { commandId: "archive_old_assembly", throughGeneration: 9, actor: "operator",
      reason: "retain a bounded hot recovery window" } as const;
    const archived = await control.archiveHistory(request);
    expect(archived).toMatchObject({ replayed: false, audit: { firstGeneration: 1, lastGeneration: 9,
      generations: 9, authorizationRef: "independent-history-review" } });
    expect(control.snapshot()).toMatchObject({ state: "ready", generation: 41, digest: active.digest });
    expect(value.sqlite.prepare("SELECT count(*) AS n FROM extension_assembly_activations").get()).toEqual({ n: 32 });
    expect(value.sqlite.prepare("SELECT count(*) AS n FROM extension_assembly_archive_index").get()).toEqual({ n: 9 });
    expect(control.historyGeneration(1)).toMatchObject({ activation: { generation: 1, snapshotDigest: firstDigest },
      snapshot: { digest: firstDigest, manifest: { format: "traceforge.extension-assembly.v1" } } });
    expect(control.historyGeneration(41)).toMatchObject({ activation: { generation: 41, snapshotDigest: active.digest },
      snapshot: { digest: active.digest } });
    expect(await control.archiveHistory(request)).toMatchObject({ replayed: true });
    expect(authorizations).toBe(2);
    await expect(control.archiveHistory({ ...request, throughGeneration: 10 })).rejects.toThrow(/conflicts/i);
    await expect(control.archiveHistory({ ...request, commandId: "archive_hot_window", throughGeneration: 40 }))
      .rejects.toThrow(/No inactive.*eligible/i);
    expect(() => value.sqlite.exec("DELETE FROM extension_assembly_archives")).toThrow(/immutable/i);
    expect(() => value.sqlite.exec("UPDATE extension_assembly_archive_index SET command_id='changed'")).toThrow(/immutable/i);
    expect(() => value.sqlite.exec("DELETE FROM extension_assembly_activations WHERE generation=10")).toThrow(/immutable/i);
    value.sqlite.close();
    value = installed(join(root, "state.db"));
    const restarted = new ExtensionAssemblyControl(value.sqlite, value.packages, value.store, [mcp()], [],
      { managedProviders: [currentProvider] });
    expect(restarted.snapshot()).toMatchObject({ state: "ready", generation: 41, digest: active.digest });
    expect(restarted.historyGeneration(9)).toMatchObject({ activation: { generation: 9 }, snapshot: { digest: expect.any(String) } });
    expect(value.sqlite.pragma("integrity_check", { simple: true })).toBe("ok");
    value.sqlite.close();
  });

  it("denies history archive by default and never archives the active recovery window", async () => {
    const value = installed();
    const control = new ExtensionAssemblyControl(value.sqlite, value.packages, value.store, [mcp()], []);
    await expect(control.archiveHistory({ commandId: "not_authorized", throughGeneration: 1, actor: "operator",
      reason: "attempted archive" })).rejects.toThrow(/authorization denied/i);
    expect(value.sqlite.prepare("SELECT count(*) AS n FROM extension_assembly_archives").get()).toEqual({ n: 0 });
    value.sqlite.close();
  });

  it("keeps the old active generation after SIGKILL inside activation and converges on restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "traceforge-extension-assembly-")); roots.push(root);
    const databasePath = join(root, "state.db"), configPath = join(root, "config.json");
    let value = installed(databasePath);
    const first = new ExtensionAssemblyControl(value.sqlite, value.packages, value.store, [mcp()], []).snapshot();
    value.sqlite.close(); writeFileSync(configPath, JSON.stringify({ databasePath }));
    const child = spawn(process.execPath, ["--import", "tsx", crashFixture, configPath], { stdio: ["pipe", "pipe", "pipe"] });
    children.add(child);
    const checkpoint = await new Promise<string>((resolve, reject) => {
      let stdout = "", stderr = "";
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.stdout.on("data", (chunk) => { stdout += chunk; const newline = stdout.indexOf("\n");
        if (newline >= 0) resolve((JSON.parse(stdout.slice(0, newline)) as { checkpoint: string }).checkpoint); });
      child.once("close", () => reject(new Error(`Assembly crash fixture exited early: ${stderr}`)));
      setTimeout(() => reject(new Error(`Assembly crash fixture timed out: ${stderr}`)), 10_000).unref();
    });
    expect(checkpoint).toBe("before-active-switch"); child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
    value = installed(databasePath);
    expect(value.sqlite.prepare("SELECT generation,snapshot_digest FROM extension_assembly_active").get())
      .toEqual({ generation: 1, snapshot_digest: first.digest });
    const recovered = new ExtensionAssemblyControl(value.sqlite, value.packages, value.store, [mcp(2, "2")], []).snapshot();
    expect(recovered).toMatchObject({ state: "ready", generation: 2, previousDigest: first.digest });
    expect(value.sqlite.pragma("integrity_check", { simple: true })).toBe("ok"); value.sqlite.close();
  });
});
