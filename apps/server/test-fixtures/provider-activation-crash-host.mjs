import fs from "node:fs";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { join } from "node:path";
import { ExecutionToolDiscoveryRuntime } from "@traceforge/worker-runtime";
import { createDb, getSqliteClient } from "../src/db/client.ts";
import {
  canonicalJson, createToolProviderRuntimeBinding, SqliteToolProviderControlStore, ToolProviderControlPlane,
} from "../src/tool-provider-control-plane.ts";
import { inspectToolProviderPackage, ManagedToolProviderPackageStore } from "../src/tool-provider-package-store.ts";
import { createManagedToolProviderSourceFactory } from "../src/managed-tool-provider-source.ts";
import { SqliteExecutionToolDiscoveryStateStore } from "../src/tool-discovery-state-adapter.ts";
import { SqliteToolProviderRecoveryStateStore } from "../src/tool-provider-recovery-adapter.ts";
import { ToolProviderRecoveryReconciler } from "../src/tool-provider-recovery-reconciler.ts";
import { recoverToolRuntimeStartup } from "../src/tool-runtime-startup-recovery.ts";
import { SqliteToolInvocationBindingStore } from "../src/worker-execution-adapters.ts";

// Checkpoints exist only in this host. SIGKILL prevents catch/finally compensation.
const [mode, root, action, phase, supersession] = process.argv.slice(2);
const emit = (value) => fs.writeSync(1, `${JSON.stringify(value)}\n`);
const providerId = "neutral-provider";
const source = "managed.neutral-provider";
const commandId = "activation-command";
const targetVersion = action === "upgrade" ? "2.0.0" : "1.0.0";
const trustPath = join(root, "trust.json");
const sqlite = getSqliteClient(createDb(join(root, "host.sqlite")));
const store = new SqliteToolProviderControlStore(sqlite);
const bindings = new SqliteToolInvocationBindingStore(sqlite);
const packages = new ManagedToolProviderPackageStore(join(root, "packages"));
let privateKey;
if (mode === "crash") {
  const keys = generateKeyPairSync("ed25519");
  privateKey = keys.privateKey;
  fs.writeFileSync(trustPath, JSON.stringify({ release: keys.publicKey.export({ type: "spki", format: "pem" }) }));
}
const trust = new Map(Object.entries(JSON.parse(fs.readFileSync(trustPath, "utf8"))));
const discoveryState = new SqliteExecutionToolDiscoveryStateStore(sqlite);
const recoveryState = new SqliteToolProviderRecoveryStateStore(sqlite);
const runtime = new ExecutionToolDiscoveryRuntime([], 30_000, 3, () => new Date(), discoveryState);
// Production managed sources register signed catalogs without launching a process.
// Invocation execution is intentionally out of scope and fails loudly if attempted.
const node = new Proxy({}, { get() { throw new Error("Activation recovery must not execute a Provider process"); } });
const managedFactory = createManagedToolProviderSourceFactory(node, join(root, "work"), undefined, { state: recoveryState });
const activations = [];
const activationFences = [];
let armed = false;
function checkpoint(name, observed = undefined) {
  if (!armed || mode !== "crash" || phase !== name) return;
  emit({ checkpoint: name, snapshot: observed ?? snapshot() });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  throw new Error("Crash checkpoint unexpectedly resumed");
}
const binding = createToolProviderRuntimeBinding(
  (entry) => runtime.activateSource(entry), (id) => runtime.deactivateSource(id), (id) => runtime.drainSource(id),
  (installation) => {
    activations.push(installation.manifest.version);
    activationFences.push(bindings.admission(source, installation.manifest.version)?.status ?? "missing");
    return managedFactory(installation);
  },
);
const activate = binding.activate.bind(binding);
binding.activate = async (installation) => {
  const result = await activate(installation);
  checkpoint("runtime-activated");
  return result;
};
const port = {
  hasOpenBindings: (id, version) => bindings.hasOpenBindings(id, version),
  async closeAdmission(id, version, reason) {
    await bindings.closeAdmission(id, version, reason);
    if (version === targetVersion) checkpoint("target-fenced");
  },
  async openAdmission(id, version) {
    if (armed && phase === "superseded-pending" && version === targetVersion) throw new Error("injected admission failure");
    await bindings.openAdmission(id, version);
    if (version === targetVersion) checkpoint("admission-open");
  },
};
const control = new ToolProviderControlPlane(store, trust, binding, packages, () => new Date().toISOString(), port);
const recover = () => recoverToolRuntimeStartup(runtime, new ToolProviderRecoveryReconciler(recoveryState, control), control);
const run = () => action === "rollback"
  ? control.rollback(providerId, "2.0.0", "1.0.0", "restore prior version", "operator", commandId)
  : control.enable(providerId, targetVersion, "operator", commandId);

function install(version, deferred = false) {
  const sourceRoot = join(root, `source-${version}`);
  fs.mkdirSync(sourceRoot);
  const content = `neutral candidate ${version}`;
  fs.writeFileSync(join(sourceRoot, "provider.bin"), content, { mode: 0o700 });
  const manifest = {
    schemaVersion: 1, providerId, source, version, protocolVersion: 1,
    entrypoint: { executable: "provider.bin", arguments: [], workingDirectory: "." },
    artifact: { sha256: createHash("sha256").update(content).digest("hex"), packageSha256: inspectToolProviderPackage(sourceRoot).digest },
    capabilities: ["investigation.observe"],
    tools: [{
      name: "candidate.observe", source, version, priority: 100, description: "Observe a neutral candidate",
      inputSchema: {}, providedCapabilities: ["investigation.observe"], dependencyCapabilities: [],
      permissionRequirements: {}, risk: "read_only", timeoutMs: 1000,
    }],
    permissions: { network: "deny", filesystem: "read_only", process: "sandboxed", secrets: "none" },
    resources: { cpuTimeMs: 1000, memoryBytes: 67108864, maximumProcesses: 1, maximumWriteBytes: 1024 },
    platforms: [process.platform],
  };
  const signature = {
    algorithm: "ed25519", keyId: "release", value: sign(null, Buffer.from(canonicalJson(manifest)), privateKey).toString("base64"),
  };
  if (deferred) {
    fs.writeFileSync(join(root, "later-release.json"), JSON.stringify({ manifest, signature, sourceRoot }));
    return;
  }
  return control.install(manifest, signature, sourceRoot, "operator", `install-${version}`);
}

function snapshot() {
  return {
    integrity: sqlite.pragma("integrity_check", { simple: true }),
    installations: control.list().map((entry) => ({ version: entry.manifest.version, state: entry.state })).sort((a, b) => a.version.localeCompare(b.version)),
    deliveries: sqlite.prepare("SELECT command_id, version, status FROM tool_provider_activation_deliveries ORDER BY command_id").all(),
    events: control.listEvents().map((event) => ({ commandId: event.commandId, type: event.type, version: event.version })),
    fences: sqlite.prepare("SELECT tool_version AS version, status FROM tool_invocation_admission_fences ORDER BY tool_version").all(),
    activeVersions: runtime.snapshot().providers.filter((entry) => entry.lifecycle === "active").map((entry) => entry.tool.version),
    acceptingSources: runtime.snapshot().sources.filter((entry) => entry.acceptingInvocations).map((entry) => entry.source),
    activations: [...activations], activationFences: [...activationFences],
  };
}

async function probeAdmissions() {
  const result = {};
  for (const entry of control.list()) {
    const version = entry.manifest.version;
    const id = `probe-${process.pid}-${version}`;
    try {
      await bindings.prepare({
        idempotencyKey: id, invocationId: id,
        tool: { name: "candidate.observe", source, version, contractFingerprint: "a".repeat(64) },
        inputFingerprint: "b".repeat(64), attribution: { caseId: "neutral-case", runId: "neutral-run", workId: "neutral-work" },
      });
      await bindings.complete(id);
      result[version] = "admitted";
    } catch (error) {
      if (!error.message.includes("admission is closed")) throw error;
      result[version] = "closed";
    }
  }
  return result;
}

async function supersede() {
  if (supersession === "upgrade") {
    const release = JSON.parse(fs.readFileSync(join(root, "later-release.json"), "utf8"));
    control.install(release.manifest, release.signature, release.sourceRoot, "operator", "install-3.0.0");
    await control.enable(providerId, "3.0.0", "operator", "later-enable");
  } else {
    await control[supersession](providerId, targetVersion, "operator maintenance", "operator", "later-state");
  }
}

if (mode === "crash") {
  install("1.0.0");
  if (action !== "enable") {
    await control.enable(providerId, "1.0.0", "operator", "setup-first");
    install("2.0.0");
  }
  if (action === "rollback") await control.enable(providerId, "2.0.0", "operator", "setup-second");
  // A signed later release lets stale-command tests supersede without exporting private keys.
  if (supersession === "upgrade") install("3.0.0", true);
  const activateVersion = store.activateVersion.bind(store);
  let beforeTransaction;
  store.activateVersion = (...args) => {
    beforeTransaction = snapshot();
    const result = activateVersion(...args);
    checkpoint("lifecycle-committed");
    return result;
  };
  if (phase === "lifecycle-uncommitted") {
    // Do not reenter SQLite from its own trigger. The trigger confirms the uncommitted
    // delivery INSERT; the attached snapshot was read immediately before the transaction.
    sqlite.function("activation_checkpoint", () => checkpoint("lifecycle-uncommitted", beforeTransaction));
    sqlite.exec(`CREATE TEMP TRIGGER crash_activation_transaction AFTER INSERT ON tool_provider_activation_deliveries
      WHEN NEW.command_id = 'activation-command' BEGIN SELECT activation_checkpoint(); END`);
  }
  if (phase === "compensation-restored") {
    sqlite.exec(`CREATE TEMP TRIGGER reject_activation_transaction BEFORE INSERT ON tool_provider_activation_deliveries
      WHEN NEW.command_id = 'activation-command' BEGIN SELECT RAISE(ABORT, 'injected activation commit failure'); END`);
  }
  armed = true;
  try { await run(); }
  catch (error) {
    if (phase === "superseded-pending" && error.message === "injected admission failure") {
      armed = false;
      await supersede();
      armed = true;
      checkpoint("superseded-pending");
    }
    if (phase !== "compensation-restored" || error.message !== "injected activation commit failure") throw error;
    checkpoint("compensation-restored");
    throw error;
  }
  checkpoint("delivery-completed");
  throw new Error(`No crash checkpoint reached at ${phase}`);
} else {
  const before = snapshot();
  const recovery = await recover();
  const recovered = snapshot();
  let result = null;
  let superseded = null;
  if (mode === "supersede") {
    await supersede();
    superseded = snapshot();
  }
  if (mode === "replay" || mode === "supersede") result = { state: (await run()).state };
  else if (mode !== "recover") throw new Error(`Unknown host mode ${mode}`);
  const probes = await probeAdmissions();
  const discovery = await discoveryState.load(source);
  emit({ before, recovery, recovered, superseded, result, probes,
    catalogVersions: discovery?.lastSuccessfulCatalog.map((entry) => entry.version) ?? [], after: snapshot() });
}
await runtime.close();
sqlite.close();
