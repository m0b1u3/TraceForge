import fs from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { join, relative } from "node:path";
import { createDb, getSqliteClient } from "../src/db/client.ts";
import { createSignedToolProviderArchive } from "../src/tool-provider-archive.ts";
import { ToolProviderArchiveImportService } from "../src/tool-provider-archive-import.ts";
import { SqliteToolProviderControlStore, ToolProviderControlPlane } from "../src/tool-provider-control-plane.ts";
import { ManagedToolProviderPackageStore } from "../src/tool-provider-package-store.ts";
import { ToolProviderGarbageCollector } from "../src/tool-provider-garbage-collector.ts";

// Test-only host: the parent kills this exact process at a confirmed synchronous boundary.
const [mode, root, phase] = process.argv.slice(2);
const emit = (value) => fs.writeSync(1, `${JSON.stringify(value)}\n`);
function checkpoint(name) {
  if (mode !== "install" || phase !== name) return;
  emit({ checkpoint: name });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  throw new Error("Crash checkpoint unexpectedly resumed");
}

const providerId = "neutral-provider";
const version = "1.0.0";
const commandId = "archive-command";
const archivePath = join(root, "provider.tfpa");
const trustPath = join(root, "public-trust.json");
if (mode === "install") {
  const sourceRoot = join(root, "source");
  fs.mkdirSync(sourceRoot);
  fs.writeFileSync(join(sourceRoot, "provider.bin"), "neutral test provider", { mode: 0o700 });
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  fs.writeFileSync(trustPath, JSON.stringify({ release: publicKey.export({ type: "spki", format: "pem" }) }));
  createSignedToolProviderArchive({
    sourceRoot, privateKey, keyId: "release", archivePath,
    manifestValue: {
      schemaVersion: 1, providerId, source: "managed.neutral-provider", version, protocolVersion: 1,
      entrypoint: { executable: "provider.bin", arguments: [], workingDirectory: "." },
      capabilities: ["investigation.observe"],
      tools: [{
        name: "candidate.observe", source: "managed.neutral-provider", version, priority: 100,
        description: "Observe a neutral candidate", inputSchema: {}, providedCapabilities: ["investigation.observe"],
        dependencyCapabilities: [], permissionRequirements: {}, risk: "read_only", timeoutMs: 1000,
      }],
      permissions: { network: "deny", filesystem: "read_only", process: "sandboxed", secrets: "none" },
      resources: { cpuTimeMs: 1000, memoryBytes: 67108864, maximumProcesses: 1, maximumWriteBytes: 1024 },
      platforms: [process.platform],
    },
  });
}
const sqlite = getSqliteClient(createDb(join(root, "host.sqlite")));
const store = new SqliteToolProviderControlStore(sqlite);
const packages = new ManagedToolProviderPackageStore(join(root, "packages"));
const trust = new Map(Object.entries(JSON.parse(fs.readFileSync(trustPath, "utf8"))));
let activations = 0;
let authorizations = 0;
const control = new ToolProviderControlPlane(store, trust, {
  async activate() { activations += 1; throw new Error("This import harness must never execute a Provider"); },
  async deactivate() {}, async drain() {},
}, packages);
const imports = new ToolProviderArchiveImportService(sqlite, control, store, trust, join(root, "imports"), {
  async authorize() {
    authorizations += 1;
    if (mode === "recover") throw new Error("Recovery must not request import authorization");
    checkpoint("upload-complete");
    return { decision: "allowed", reason: "neutral test grant" };
  },
});

function tree(path) {
  return fs.readdirSync(path).sort().flatMap((name) => {
    const child = join(path, name);
    return fs.lstatSync(child).isDirectory() ? [relative(root, child), ...tree(child)] : [relative(root, child)];
  });
}
function snapshot() {
  return {
    installations: control.list().map((entry) => ({ version: entry.manifest.version, state: entry.state })),
    audits: imports.listAudits(), events: control.listEvents().length,
    uploads: tree(imports.uploadRoot), staging: tree(imports.stagingRoot), packages: tree(packages.root),
    activations, authorizations,
    integrity: sqlite.pragma("integrity_check", { simple: true }),
  };
}

if (mode === "install") {
  const originalMkdtemp = fs.mkdtempSync;
  fs.mkdtempSync = (...args) => {
    const path = originalMkdtemp(...args);
    if (String(args[0]).startsWith(imports.stagingRoot)) checkpoint("staging-created");
    return path;
  };
  const originalWrite = fs.writeFileSync;
  fs.writeFileSync = (...args) => {
    if (String(args[0]).startsWith(imports.stagingRoot)) checkpoint("staging-registered");
    return originalWrite(...args);
  };
  syncBuiltinESMExports();
  const publish = packages.publish.bind(packages);
  packages.publish = (...args) => {
    const published = publish(...args);
    checkpoint("package-published");
    return published;
  };
  if (phase === "manifest-uncommitted") {
    sqlite.function("crash_checkpoint", () => checkpoint("manifest-uncommitted"));
    sqlite.exec(`CREATE TEMP TRIGGER crash_during_manifest_transaction
      AFTER INSERT ON tool_provider_manifests BEGIN SELECT crash_checkpoint(); END`);
  }
  const install = store.install.bind(store);
  store.install = (...args) => {
    const installed = install(...args);
    checkpoint("manifest-committed");
    return installed;
  };
  await imports.import({ archive: fs.readFileSync(archivePath), actor: "operator", commandId });
  checkpoint("audit-committed");
  throw new Error(`No crash checkpoint reached for ${phase}`);
} else if (mode === "recover") {
  const before = snapshot();
  const recovery = imports.recoverInterrupted();
  const providerRecovery = await control.recover();
  const collector = new ToolProviderGarbageCollector(
    sqlite, store, packages, join(root, "work"),
    () => ({ registryRevision: 0, status: "ready", sources: [], providers: [] }),
    { gracePeriodMs: 86_400_000 }, () => new Date(Date.now() + 2 * 86_400_000).toISOString(),
  );
  const grace = collector.collect({ dryRun: true, at: new Date().toISOString() });
  const gc = collector.collect({ dryRun: false });
  let enableProbe = null;
  if (control.list().length === 0) {
    try { await control.enable(providerId, version, "operator", "missing-version-probe"); }
    catch (error) { enableProbe = error.statusCode; }
  }
  emit({ before, recovery, providerRecovery, graceEligible: grace.eligible, deleted: gc.deleted, gcFailures: gc.failures, enableProbe, after: snapshot() });
} else if (mode === "replay") {
  const before = snapshot();
  let result;
  try {
    const imported = await imports.import({ archive: fs.readFileSync(archivePath), actor: "operator", commandId });
    result = { replayed: imported.replayed, state: imported.installation.state };
  } catch (error) { result = { statusCode: error.statusCode }; }
  emit({ before, result, after: snapshot() });
} else {
  throw new Error(`Unknown test host mode: ${mode}`);
}
sqlite.close();
