import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import type { ToolInvocationBindingStore } from "@traceforge/worker-runtime";
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
import { SqliteToolInvocationBindingStore } from "./worker-execution-adapters.js";

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

function fixture(invocationBindings?: Pick<ToolInvocationBindingStore, "hasOpenBindings" | "closeAdmission" | "openAdmission">) {
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
    invocationBindings,
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

function admissionFixture() {
  let bindings!: SqliteToolInvocationBindingStore;
  const blocked = new Set<string>();
  const port = {
    hasOpenBindings: (source: string, version: string) => bindings.hasOpenBindings(source, version),
    closeAdmission: (source: string, version: string, reason: string) => bindings.closeAdmission(source, version, reason),
    async openAdmission(source: string, version: string) {
      if (blocked.has(version)) throw new Error("injected admission failure");
      await bindings.openAdmission(source, version);
    },
  };
  const context = fixture(port);
  bindings = new SqliteToolInvocationBindingStore(context.sqlite);
  const restart = () => new ToolProviderControlPlane(context.store,
    new Map([["release-key", context.publicKey.export({ type: "spki", format: "pem" }).toString()]]),
    context.runtime, context.packages, () => "2026-08-27T12:05:00.000Z", port);
  return { ...context, bindings, blocked, restart };
}

describe("Tool Provider activation delivery recovery", () => {
  it.each(["enable", "upgrade", "rollback"] as const)("resumes committed %s admission without repeating activation or drain events", async (action) => {
    const context = admissionFixture();
    const first = context.manifest("1.0.0");
    const second = context.manifest("2.0.0");
    context.control.install(first, context.signature(first), context.sourceRoot, "operator", "install-1");
    if (action !== "enable") {
      await context.control.enable(first.providerId, first.version, "operator", "enable-1");
      context.control.install(second, context.signature(second), context.sourceRoot, "operator", "install-2");
    }
    if (action === "rollback") await context.control.enable(second.providerId, second.version, "operator", "enable-2");
    const target = action === "upgrade" ? second : first;
    const run = () => action === "rollback"
      ? context.control.rollback(first.providerId, second.version, first.version, "restore", "operator", "deliver")
      : context.control.enable(target.providerId, target.version, "operator", "deliver");
    context.blocked.add(target.version);
    await expect(run()).rejects.toThrow("injected admission failure");
    expect(context.store.get(target.providerId, target.version)?.state).toBe("enabled");
    expect(context.bindings.admission(target.source, target.version)?.status).toBe("closed");
    expect(context.store.activationDelivery("deliver")).toMatchObject({ status: "pending", last_error: "injected admission failure" });
    if (action !== "enable") {
      const previous = action === "upgrade" ? first : second;
      expect(context.store.get(previous.providerId, previous.version)?.state).toBe("disabled");
      expect(context.bindings.admission(previous.source, previous.version)?.status).toBe("closed");
    }
    const activations = [...context.activations];
    const events = context.control.listEvents();
    context.blocked.clear();
    await expect(run()).resolves.toMatchObject({ state: "enabled" });
    expect(context.store.activationDelivery("deliver")).toMatchObject({ status: "completed", last_error: null });
    const admission = context.bindings.admission(target.source, target.version);
    expect(admission?.status).toBe("open");
    await run();
    expect(context.bindings.admission(target.source, target.version)).toEqual(admission);
    expect(context.activations).toEqual(activations);
    expect(context.control.listEvents()).toEqual(events);
    context.sqlite.close();
  });

  it.each(["disable", "quarantine", "upgrade", "reenable"] as const)("does not reopen a pending command superseded by %s", async (action) => {
    const context = admissionFixture();
    const first = context.manifest();
    context.control.install(first, context.signature(first), context.sourceRoot, "operator", "install-1");
    context.blocked.add(first.version);
    await expect(context.control.enable(first.providerId, first.version, "operator", "enable-1"))
      .rejects.toThrow("injected admission failure");
    context.blocked.clear();
    if (action === "upgrade") {
      const second = context.manifest("2.0.0");
      context.control.install(second, context.signature(second), context.sourceRoot, "operator", "install-2");
      await context.control.enable(second.providerId, second.version, "operator", "enable-2");
    } else if (action === "quarantine") {
      await context.control.quarantine(first.providerId, first.version, "maintenance", "operator", "quarantine");
    } else {
      await context.control.disable(first.providerId, first.version, "maintenance", "operator", "disable");
      if (action === "reenable") await context.control.enable(first.providerId, first.version, "operator", "enable-2");
    }
    const admission = context.bindings.admission(first.source, first.version);
    const activations = [...context.activations];
    const result = await context.control.enable(first.providerId, first.version, "operator", "enable-1");
    expect(result.state).toBe(action === "reenable" ? "enabled" : action === "quarantine" ? "quarantined" : "disabled");
    expect(context.store.activationDelivery("enable-1")?.status).toBe("superseded");
    expect(context.bindings.admission(first.source, first.version)).toEqual(admission);
    expect(context.activations).toEqual(activations);
    context.sqlite.close();
  });

  it.each([false, true])("requires startup recovery before a new controller can resume delivery (failure=%s)", async (failRecovery) => {
    const context = admissionFixture();
    const first = context.manifest();
    context.control.install(first, context.signature(first), context.sourceRoot, "operator", "install-1");
    context.blocked.add(first.version);
    await expect(context.control.enable(first.providerId, first.version, "operator", "enable-1"))
      .rejects.toThrow("injected admission failure");
    context.blocked.clear();
    const restarted = context.restart();
    await expect(restarted.enable(first.providerId, first.version, "operator", "enable-1"))
      .rejects.toThrow("requires startup recovery");
    let calls = 0;
    context.runtime.activate = async () => {
      calls++;
      expect(context.bindings.admission(first.source, first.version)?.status).toBe("closed");
      if (failRecovery) throw new Error("injected recovery failure");
    };
    await expect(restarted.recover()).resolves.toEqual({
      enabled: failRecovery ? [] : ["neutral-provider@1.0.0"],
      failed: failRecovery ? ["neutral-provider@1.0.0"] : [],
    });
    expect(context.store.activationDelivery("enable-1")?.status).toBe(failRecovery ? "superseded" : "completed");
    await expect(restarted.enable(first.providerId, first.version, "operator", "enable-1"))
      .resolves.toMatchObject({ state: failRecovery ? "failed" : "enabled" });
    expect(context.bindings.admission(first.source, first.version)?.status).toBe(failRecovery ? "closed" : "open");
    expect(calls).toBe(1);
    context.sqlite.close();
  });

  it("does not transiently reopen admission when replaying a failed drain completion", async () => {
    const context = admissionFixture();
    const first = context.manifest();
    const second = context.manifest("2.0.0");
    context.control.install(first, context.signature(first), context.sourceRoot, "operator", "install-1");
    await context.control.enable(first.providerId, first.version, "operator", "enable-1");
    context.control.install(second, context.signature(second), context.sourceRoot, "operator", "install-2");
    context.runtime.activate = async () => ({ drained: Promise.reject(new Error("injected drain failure")) });
    await expect(context.control.enable(second.providerId, second.version, "operator", "enable-2"))
      .rejects.toThrow("injected drain failure");
    const revision = context.bindings.admission(second.source, second.version)!.revision;
    await expect(context.control.enable(second.providerId, second.version, "operator", "enable-2"))
      .rejects.toThrow("injected drain failure");
    expect(context.bindings.admission(second.source, second.version)).toMatchObject({ status: "closed", revision: revision + 1 });
    expect(context.store.activationDelivery("enable-2")?.status).toBe("pending");
    expect(context.store.get(first.providerId, first.version)?.state).toBe("failed");
    context.runtime.activate = async () => {};
    await expect(context.restart().recover()).resolves.toEqual({ enabled: ["neutral-provider@2.0.0"], failed: [] });
    expect(context.store.activationDelivery("enable-2")?.status).toBe("completed");
    context.sqlite.close();
  });

  it("awaits runtime cleanup even when activating the same version has no previous lifecycle to retire", async () => {
    const context = admissionFixture();
    const first = context.manifest();
    context.control.install(first, context.signature(first), context.sourceRoot, "operator", "install-1");
    await context.control.enable(first.providerId, first.version, "operator", "enable-1");
    context.runtime.activate = async () => ({ drained: Promise.reject(new Error("same version cleanup failed")) });
    await expect(context.control.enable(first.providerId, first.version, "operator", "enable-2"))
      .rejects.toThrow("same version cleanup failed");
    expect(context.store.activationDelivery("enable-2")?.status).toBe("pending");
    expect(context.bindings.admission(first.source, first.version)?.status).toBe("closed");
    context.sqlite.close();
  });

  it("keeps delivery pending when recording completion fails and safely retries it", async () => {
    const context = admissionFixture();
    const first = context.manifest();
    context.control.install(first, context.signature(first), context.sourceRoot, "operator", "install-1");
    context.sqlite.exec(`CREATE TEMP TRIGGER fail_delivery_completion BEFORE UPDATE ON tool_provider_activation_deliveries
      WHEN NEW.status = 'completed' BEGIN SELECT RAISE(ABORT, 'injected completion failure'); END`);
    await expect(context.control.enable(first.providerId, first.version, "operator", "enable-1"))
      .rejects.toThrow("injected completion failure");
    expect(context.bindings.admission(first.source, first.version)?.status).toBe("closed");
    expect(context.store.activationDelivery("enable-1")).toMatchObject({ status: "pending", last_error: "injected completion failure" });
    context.sqlite.exec("DROP TRIGGER fail_delivery_completion");
    await context.control.enable(first.providerId, first.version, "operator", "enable-1");
    expect(context.store.activationDelivery("enable-1")?.status).toBe("completed");
    expect(context.activations).toHaveLength(1);
    context.sqlite.close();
  });

  it.each(["restore", "deactivate", "restore-drain"] as const)("fails closed when %s compensation fails after the upgrade transaction aborts", async (failure) => {
    const context = admissionFixture();
    const first = context.manifest();
    const second = context.manifest("2.0.0");
    context.control.install(first, context.signature(first), context.sourceRoot, "operator", "install-1");
    await context.control.enable(first.providerId, first.version, "operator", "enable-1");
    context.control.install(second, context.signature(second), context.sourceRoot, "operator", "install-2");
    context.sqlite.exec(`CREATE TEMP TRIGGER fail_activation_commit BEFORE INSERT ON tool_provider_events
      WHEN NEW.command_id = 'enable-2' BEGIN SELECT RAISE(ABORT, 'injected commit failure'); END`);
    if (failure !== "deactivate") context.runtime.activate = async (installation) => {
      if (installation.manifest.version !== first.version) return;
      if (failure === "restore") throw new Error("injected restore failure");
      return { drained: Promise.reject(new Error("injected restore drain failure")) };
    };
    else context.runtime.deactivate = async () => { throw new Error("injected deactivate failure"); };
    await expect(context.control.enable(second.providerId, second.version, "operator", "enable-2"))
      .rejects.toThrow("compensation was incomplete");
    for (const manifest of [first, second]) {
      expect(context.bindings.admission(manifest.source, manifest.version)?.status).toBe("closed");
      expect(context.store.get(manifest.providerId, manifest.version)).toMatchObject({ state: "failed", stateReason: expect.stringContaining("compensation failed") });
    }
    expect(context.drains).toEqual([first.source]);
    expect(context.store.activationDelivery("enable-2")).toBeUndefined();
    const admission = context.bindings.admission(first.source, first.version);
    await expect(context.control.enable(first.providerId, first.version, "operator", "enable-1"))
      .resolves.toMatchObject({ state: "failed" });
    expect(context.bindings.admission(first.source, first.version)).toEqual(admission);
    await expect(context.restart().recover()).resolves.toEqual({ enabled: [], failed: [] });
    context.sqlite.close();
  });
});

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

  it("blocks a contract-breaking upgrade before runtime activation and persists the assessment", async () => {
    const context = fixture();
    const first = context.manifest("1.0.0");
    const second = context.manifest("2.0.0");
    second.tools[0] = {
      ...second.tools[0]!,
      inputSchema: {
        type: "object",
        properties: { mode: { type: "string" } },
        required: ["mode"],
      },
    };
    context.control.install(first, context.signature(first), context.sourceRoot, "operator", "install-1");
    await context.control.enable(first.providerId, first.version, "operator", "enable-1");
    context.control.install(second, context.signature(second), context.sourceRoot, "operator", "install-2");

    await expect(context.control.enable(second.providerId, second.version, "operator", "enable-2"))
      .rejects.toThrow(/contract-breaking.*input_schema_breaking/);
    expect(context.activations).toEqual(["neutral-provider@1.0.0"]);
    expect(context.store.get(second.providerId, second.version)?.state).toBe("installed");
    expect(context.control.listCompatibility(second.providerId)).toMatchObject([{
      commandId: "enable-2:compatibility:1.0.0",
      report: {
        fromVersion: "1.0.0",
        toVersion: "2.0.0",
        classification: "breaking",
        changes: [expect.objectContaining({ code: "input_schema_breaking", classification: "breaking" })],
      },
    }]);
    context.sqlite.close();
  });

  it("blocks upgrade, drain, and disable while an invocation binding is unfinished", async () => {
    let open = true;
    const closed = new Set<string>();
    const context = fixture({
      async hasOpenBindings() { return open; },
      async closeAdmission(source, version) { closed.add(`${source}@${version}`); },
      async openAdmission(source, version) { closed.delete(`${source}@${version}`); },
    });
    const first = context.manifest("1.0.0");
    const second = context.manifest("1.1.0");
    context.control.install(first, context.signature(first), context.sourceRoot, "operator", "install-1");
    await context.control.enable(first.providerId, first.version, "operator", "enable-1");
    context.control.install(second, context.signature(second), context.sourceRoot, "operator", "install-2");

    await expect(context.control.enable(second.providerId, second.version, "operator", "enable-2"))
      .rejects.toThrow(/unfinished Tool Invocation bindings.*upgrade/);
    await expect(context.control.drain(first.providerId, first.version, "maintenance", "operator", "drain-1"))
      .rejects.toThrow(/unfinished Tool Invocation bindings.*drain/);
    await expect(context.control.disable(first.providerId, first.version, "maintenance", "operator", "disable-1"))
      .rejects.toThrow(/unfinished Tool Invocation bindings.*disable/);
    expect(context.activations).toEqual(["neutral-provider@1.0.0"]);
    expect(context.drains).toEqual([]);
    expect(context.deactivations).toEqual([]);
    expect(closed.size).toBe(0);

    open = false;
    await expect(context.control.enable(second.providerId, second.version, "operator", "enable-3"))
      .resolves.toMatchObject({ state: "enabled", manifest: { version: "1.1.0" } });
    expect(closed).toEqual(new Set(["managed.neutral-provider@1.0.0"]));
    context.sqlite.close();
  });

  it("reopens the active version and closes the failed target when activation cannot commit", async () => {
    const closed = new Set<string>();
    const context = fixture({
      async hasOpenBindings() { return false; },
      async closeAdmission(source, version) { closed.add(`${source}@${version}`); },
      async openAdmission(source, version) { closed.delete(`${source}@${version}`); },
    });
    const first = context.manifest("1.0.0");
    const second = context.manifest("1.1.0");
    context.control.install(first, context.signature(first), context.sourceRoot, "operator", "install-1");
    await context.control.enable(first.providerId, first.version, "operator", "enable-1");
    context.control.install(second, context.signature(second), context.sourceRoot, "operator", "install-2");
    context.runtime.activate = async (installation) => {
      if (installation.manifest.version === second.version) throw new Error("activation failed");
    };

    await expect(context.control.enable(second.providerId, second.version, "operator", "enable-2"))
      .resolves.toMatchObject({ state: "failed", manifest: { version: "1.1.0" } });
    expect(context.store.get(first.providerId, first.version)?.state).toBe("enabled");
    expect(closed).toEqual(new Set(["managed.neutral-provider@1.1.0"]));
    context.sqlite.close();
  });

  it("restores the previous runtime generation when the durable upgrade commit fails", async () => {
    const closed = new Set<string>();
    const context = fixture({
      async hasOpenBindings() { return false; },
      async closeAdmission(source, version) { closed.add(`${source}@${version}`); },
      async openAdmission(source, version) { closed.delete(`${source}@${version}`); },
    });
    const first = context.manifest("1.0.0");
    const second = context.manifest("1.1.0");
    context.control.install(first, context.signature(first), context.sourceRoot, "operator", "install-1");
    await context.control.enable(first.providerId, first.version, "operator", "enable-1");
    context.control.install(second, context.signature(second), context.sourceRoot, "operator", "install-2");
    context.sqlite.exec(`
      CREATE TEMP TRIGGER fail_provider_upgrade_commit
      BEFORE INSERT ON tool_provider_events
      WHEN NEW.command_id = 'enable-2'
      BEGIN SELECT RAISE(ABORT, 'injected durable commit failure'); END
    `);

    await expect(context.control.enable(second.providerId, second.version, "operator", "enable-2"))
      .rejects.toThrow("injected durable commit failure");
    expect(context.store.get(first.providerId, first.version)?.state).toBe("enabled");
    expect(context.store.get(second.providerId, second.version)?.state).toBe("installed");
    expect(context.activations).toEqual([
      "neutral-provider@1.0.0",
      "neutral-provider@1.1.0",
      "neutral-provider@1.0.0",
    ]);
    expect(context.deactivations).toEqual([second.source]);
    expect(closed).toEqual(new Set([`${second.source}@${second.version}`]));
    expect(context.store.findCommand("enable-2")).toBeNull();

    context.sqlite.exec("DROP TRIGGER fail_provider_upgrade_commit");
    await expect(context.control.enable(second.providerId, second.version, "operator", "enable-2"))
      .resolves.toMatchObject({ state: "enabled", manifest: { version: "1.1.0" } });
    expect(closed).toEqual(new Set([`${first.source}@${first.version}`]));
    context.sqlite.close();
  });

  it("rejects invalid lifecycle metadata before changing runtime or admission state", async () => {
    const closed = new Set<string>();
    const context = fixture({
      async hasOpenBindings() { return false; },
      async closeAdmission(source, version) { closed.add(`${source}@${version}`); },
      async openAdmission(source, version) { closed.delete(`${source}@${version}`); },
    });
    const manifest = context.manifest("1.0.0");
    context.control.install(manifest, context.signature(manifest), context.sourceRoot, "operator", "install-1");

    await expect(context.control.enable(manifest.providerId, manifest.version, "", "enable-invalid"))
      .rejects.toThrow("actor is required");
    expect(context.activations).toEqual([]);
    expect(context.deactivations).toEqual([]);
    expect(closed.size).toBe(0);
    expect(context.store.get(manifest.providerId, manifest.version)?.state).toBe("installed");
    context.sqlite.close();
  });

  it("restores the current runtime generation when a rollback commit fails", async () => {
    const closed = new Set<string>();
    const context = fixture({
      async hasOpenBindings() { return false; },
      async closeAdmission(source, version) { closed.add(`${source}@${version}`); },
      async openAdmission(source, version) { closed.delete(`${source}@${version}`); },
    });
    const first = context.manifest("1.0.0");
    const second = context.manifest("2.0.0");
    context.control.install(first, context.signature(first), context.sourceRoot, "operator", "install-1");
    await context.control.enable(first.providerId, first.version, "operator", "enable-1");
    context.control.install(second, context.signature(second), context.sourceRoot, "operator", "install-2");
    await context.control.enable(second.providerId, second.version, "operator", "enable-2");
    context.sqlite.exec(`
      CREATE TEMP TRIGGER fail_provider_rollback_commit
      BEFORE INSERT ON tool_provider_events
      WHEN NEW.command_id = 'rollback-1'
      BEGIN SELECT RAISE(ABORT, 'injected rollback commit failure'); END
    `);

    await expect(context.control.rollback(
      second.providerId, second.version, first.version, "operator rollback", "operator", "rollback-1",
    )).rejects.toThrow("injected rollback commit failure");
    expect(context.store.get(second.providerId, second.version)?.state).toBe("enabled");
    expect(context.store.get(first.providerId, first.version)?.state).toBe("disabled");
    expect(context.activations.slice(-2)).toEqual([
      "neutral-provider@1.0.0",
      "neutral-provider@2.0.0",
    ]);
    expect(context.deactivations).toEqual([first.source]);
    expect(closed).toEqual(new Set([`${first.source}@${first.version}`]));
    expect(context.store.findCommand("rollback-1")).toBeNull();
    context.sqlite.close();
  });

  it("allows a resource change through generation draining and records requires_drain", async () => {
    const context = fixture();
    const first = context.manifest("1.0.0");
    const second = context.manifest("1.1.0");
    second.resources = { ...second.resources, memoryBytes: second.resources.memoryBytes + 1 };
    context.control.install(first, context.signature(first), context.sourceRoot, "operator", "install-1");
    await context.control.enable(first.providerId, first.version, "operator", "enable-1");
    context.control.install(second, context.signature(second), context.sourceRoot, "operator", "install-2");

    await expect(context.control.enable(second.providerId, second.version, "operator", "enable-2"))
      .resolves.toMatchObject({ state: "enabled", manifest: { version: "1.1.0" } });
    expect(context.store.get(first.providerId, first.version)?.state).toBe("disabled");
    expect(context.control.listCompatibility(second.providerId)[0]).toMatchObject({
      report: {
        classification: "requires_drain",
        changes: [expect.objectContaining({ code: "resources_changed" })],
      },
    });
    context.sqlite.close();
  });

  it("rejects corrupted compatibility audit records", async () => {
    const context = fixture();
    const first = context.manifest("1.0.0");
    const second = context.manifest("1.1.0");
    context.control.install(first, context.signature(first), context.sourceRoot, "operator", "install-1");
    await context.control.enable(first.providerId, first.version, "operator", "enable-1");
    context.control.install(second, context.signature(second), context.sourceRoot, "operator", "install-2");
    await context.control.enable(second.providerId, second.version, "operator", "enable-2");
    context.sqlite.prepare("UPDATE tool_provider_compatibility_audits SET report_json = '{'").run();
    expect(() => context.control.listCompatibility(first.providerId)).toThrow(/invalid JSON/);
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
    registerToolProviderControlRoutes(app, context.control, { allowLocalPackageInstall: true });

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
    const compatibility = await app.inject({ method: "GET", url: "/api/security-tools/providers/compatibility?providerId=neutral-provider" });
    expect(compatibility.json()).toEqual({ audits: [] });
    await app.close();
    context.sqlite.close();
  });

  it("keeps the local packageRoot installation route closed by default", async () => {
    const context = fixture();
    const app = Fastify();
    registerToolProviderControlRoutes(app, context.control);
    const response = await app.inject({
      method: "POST",
      url: "/api/security-tools/providers/install",
      payload: { actor: "operator", commandId: "bypass-attempt" },
    });
    expect(response.statusCode).toBe(404);
    await app.close();
    context.sqlite.close();
  });
});
