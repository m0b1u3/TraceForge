import fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalExecutionNode, NodeSpawnProcessLauncher, permissionProfileFingerprint, resourceLimitsFingerprint } from "@traceforge/execution-node";
import { DurableScenarioRuntime, ScenarioDefinitionRegistry } from "@traceforge/orchestration-core";
import { createExecutionToolRegistry, PolicyExecutionToolGateway, ExecutionNodeToolProviderClient } from "@traceforge/worker-runtime";
import { createDb, getSqliteClient } from "../src/db/client.ts";
import { SqliteToolInvocationBindingStore, SqliteToolReceiptStore } from "../src/worker-execution-adapters.ts";
import { SqliteScenarioEventStore, SqliteWorkerRegistry } from "../src/scenario-event-store.ts";
import { ScenarioRunRecoveryService } from "../src/scenario-run-recovery.ts";
import { SqliteProcessExecutionJournal } from "../src/execution-process-journal.ts";

const [mode, root, phase] = process.argv.slice(2);
const at = "2026-08-30T00:00:00.000Z";
const later = "2026-08-30T00:02:00.000Z";
const now = () => mode === "crash" ? at : later;
const sqlite = getSqliteClient(createDb(join(root, "host.sqlite")));
const bindings = new SqliteToolInvocationBindingStore(sqlite, now);
const receipts = new SqliteToolReceiptStore(sqlite, now);
const events = new SqliteScenarioEventStore(sqlite);
const definition = {
  kind: "neutral", version: 1, title: "Neutral", authorizationActions: ["observe"], requiredCapabilities: ["observe"],
  workKinds: [{ id: "observe", defaultWorkerRoles: ["observer"] }], initialPhaseId: "observe",
  agentTopology: {
    planner: { enabled: false, pollIntervalMs: 1000, maximumGraphNodes: 1, maximumRecentEvents: 1, maximumRunItems: 1, maximumProposalsPerEvaluation: 1 },
    observer: { enabled: false, pollIntervalMs: 1000, maximumGraphNodes: 1, maximumRecentEvents: 1, maximumRunItems: 1 },
    workerPools: [{ id: "neutral", role: "observer", workKinds: ["observe"], activation: "on_demand", minimumInstances: 0, maximumInstances: 1, maxConcurrentWork: 1, capabilities: ["observe"] }],
  },
  phases: [{ id: "observe", title: "Observe", objective: "Observe", allowedWorkKinds: ["observe"], maxParallelWork: 1, requiredCapabilities: ["observe"], transitions: [{ to: "complete", allOf: [{ kind: "decision" }] }] }],
};
const runtime = new DurableScenarioRuntime(events, new ScenarioDefinitionRegistry([definition]));
function command(id, value) {
  return runtime.execute({ runId: "run", commandId: id, expectedRevision: events.load("run").revision,
    definitionKind: "neutral", definitionVersion: 1, command: value }).state;
}
function claim(id) {
  return command(id, { type: "claim_work", workId: "work", workerId: "worker", workerRoles: ["observer"], workerCapabilities: ["observe"],
    workerCurrentWork: 0, workerMaxConcurrentWork: 1, leaseId: id, leaseExpiresAt: "2099-01-01T00:00:00.000Z", at: now() });
}
if (mode === "crash") {
  command("start", { type: "start_run", runId: "run", caseId: "case", goal: "Observe", scopeRef: "scope",
    scenarioPackage: { id: "neutral-test", version: "1.0.0", schemaRevision: 1 }, availableCapabilities: ["observe"], at });
  command("propose", { type: "propose_work", proposal: { id: "work", kind: "observe", title: "Observe", objective: "Observe", idempotencyKey: "effect" }, at });
  claim("lease-first");
}
function checkpoint(name) {
  if (mode !== "crash" || phase !== name) return;
  fs.writeSync(1, `${JSON.stringify({ checkpoint: name })}\n`);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
if (mode === "crash") {
  const prepare = bindings.prepare.bind(bindings);
  bindings.prepare = async (...args) => { const value = await prepare(...args); checkpoint("prepared"); return value; };
  const begin = bindings.beginExecution.bind(bindings);
  bindings.beginExecution = async (...args) => { await begin(...args); checkpoint("claimed"); };
  const put = receipts.put.bind(receipts);
  receipts.put = async (...args) => { checkpoint("result-returned"); await put(...args); checkpoint("receipt-committed"); };
}
const platform = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
const provider = fileURLToPath(new URL("./invocation-provider.mjs", import.meta.url));
const permissions = { version: 1, platform, filesystem: { read: [{ path: dirname(process.execPath), scope: "tree" }, { path: dirname(provider), scope: "tree" }, { path: root, scope: "tree" }], write: [{ path: root, scope: "tree" }], deny: [] }, network: "deny", process: { access: "sandboxed", interactive: false, background: false }, secrets: "deny" };
let launches = 0;
// Test-only attestation. Production sandbox selection is not changed or bypassed.
const launcher = new NodeSpawnProcessLauncher((request) => ({
  executable: request.executable, arguments: request.arguments, workingDirectory: request.workingDirectory, environment: request.environment,
  detached: false, windowsHide: true, enforcement: {
    sandboxBackend: "neutral-test", sandboxed: true, filesystemPolicyApplied: true,
    permissionProfileFingerprint: permissionProfileFingerprint(request.permissions), resourceLimitsApplied: true,
    resourceLimitsFingerprint: resourceLimitsFingerprint(request.resources), network: "deny",
  },
}));
const launch = launcher.launch.bind(launcher);
launcher.launch = async (...args) => { launches++; return launch(...args); };
const node = new LocalExecutionNode(launcher, { processJournal: new SqliteProcessExecutionJournal(sqlite), platform, sandboxBackends: ["neutral-test"], capabilities: {
  process: { spawn: true, stdio: true, tty: false, adoption: false, resourceLimits: true, signals: ["terminate", "kill"] },
} });
const gateway = new PolicyExecutionToolGateway(createExecutionToolRegistry([{
  name: "neutral.observe", source: "managed.neutral", version: "1.0.0", priority: 100, description: "Observe", inputSchema: {},
  providedCapabilities: ["observe"], dependencyCapabilities: [], permissionRequirements: {}, risk: "read_only", timeoutMs: 5000,
  async execute(input, context) {
    const client = new ExecutionNodeToolProviderClient({ node, executable: process.execPath, arguments: [provider, root, mode === "crash" ? phase : "normal"],
      workingDirectory: root, environment: {}, attribution: {
        caseId: context.caseId, runId: context.runId, workId: context.workId, workerId: context.workerId, scopeRef: context.scopeRef,
        leaseId: context.leaseId, leaseExpiresAt: context.leaseExpiresAt, idempotencyKey: context.idempotencyKey, actionId: context.idempotencyKey,
      },
      permissions: { ...permissions, sources: ["neutral-test"] }, resources: { cpuTimeMs: 10000, memoryBytes: 134217728, maximumProcesses: 1, writeBytes: 1048576 },
      processTimeoutMs: 10000, requestTimeoutMs: 5000, outputLimitBytes: 65536, expectedProviderId: "neutral", expectedProviderVersion: "1.0.0" });
    const timer = setInterval(() => { if (fs.existsSync(join(root, "executing"))) checkpoint("executing"); }, 10);
    try { return await client.callTool("neutral.observe", input, context); }
    finally { clearInterval(timer); await client.close(); }
  },
}]), { async authorize() { return { decision: "approved" }; } }, receipts, {
  allowedRisks: ["read_only"], permissionLayers: () => [{ source: "neutral-test", profile: permissions }],
}, undefined, bindings);

const recovery = mode === "crash" ? null : bindings.recoverInterrupted();
const runRecovery = mode === "crash" ? null : new ScenarioRunRecoveryService(runtime, events, new SqliteWorkerRegistry(sqlite)).recoverAll(later);
let state = runtime.load("run");
if (mode !== "crash" && state.workItems[0].status === "queued") state = claim(`lease-${process.pid}`);
const work = state.workItems[0];
const request = { worker: { id: "worker", roles: ["observer"], capabilities: ["observe"], maxConcurrentWork: 1, status: "online", heartbeatAt: now() },
  assignment: { runId: "run", leaseId: work.leaseId ?? "lost", leaseExpiresAt: work.leaseExpiresAt ?? at, runRevision: state.revision,
    runContext: { caseId: "case", goal: "Observe", scopeRef: "scope", activePhaseId: "observe", directives: [] }, work },
  invocation: { id: "call", tool: "neutral.observe", input: {}, rationale: "Observe" }, idempotencyKey: "effect:call" };
let outcome;
try { const result = await gateway.execute(request); outcome = { status: result.status, summary: result.summary }; }
catch (error) { outcome = { error: error.name, message: error.message }; }
if (mode === "crash") {
  if (outcome.status !== "succeeded") throw new Error(JSON.stringify(outcome));
  checkpoint("binding-completed");
  throw new Error(`Missing checkpoint ${phase}`);
}
fs.writeSync(1, `${JSON.stringify({ recovery, runRecovery, outcome, launches,
  processObservations: sqlite.prepare("SELECT observation_json FROM execution_process_journal").all().map((row) => {
    const observation = JSON.parse(row.observation_json); return { status: observation.status, cleanup: observation.cleanup };
  }), binding: bindings.get("effect:call")?.status,
  execution: bindings.execution("effect:call")?.status, protected: await bindings.hasOpenBindings("managed.neutral", "1.0.0"),
  integrity: sqlite.pragma("integrity_check", { simple: true }), effects: fs.existsSync(join(root, "effects.log")) ? fs.readFileSync(join(root, "effects.log"), "utf8").trim().split("\n").length : 0 })}\n`);
sqlite.close();
