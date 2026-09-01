import { join } from "node:path";
import { ScenarioDefinitionRegistry } from "@traceforge/orchestration-core";
import { CapabilityProviderRegistry } from "@traceforge/tool-resolver";
import { JsonFileCheckpointStore, LeaseWorkerRuntime, PolicyExecutionToolGateway, BoundedOutputDistiller } from "@traceforge/worker-runtime";
import { database, initialize, controls, definition, at } from "../src/test-fixtures/execution-recovery.ts";
import { SqliteToolReceiptStore } from "../src/worker-execution-adapters.ts";
import { ScenarioWorkContinuationControl } from "../src/scenario-work-continuation.ts";

const [root, mode, phase] = process.argv.slice(2);
const sqlite = database(join(root, "state.db"));
const c = mode === "crash" ? initialize(sqlite) : controls(sqlite);
sqlite.exec("CREATE TABLE IF NOT EXISTS fixture_effects (id TEXT PRIMARY KEY)");
const store = new JsonFileCheckpointStore(join(root, "checkpoints"));
const worker = { id: "worker", roles: ["observer"], capabilities: ["observe"], status: "online", maxConcurrentWork: 1, heartbeatAt: at };
const assignment = () => {
  const state = c.runtime.load("run"); const work = state.workItems[0];
  return { runId: "run", runRevision: state.revision, leaseId: work.leaseId, leaseExpiresAt: work.leaseExpiresAt, work,
    runContext: { caseId: "case", goal: state.goal, scopeRef: "scope", activePhaseId: state.activePhaseId, directives: [] } };
};
const command = (commandId, command, expectedRevision = c.runtime.load("run").revision) => c.runtime.execute({ runId: "run", commandId, expectedRevision, command });
function stop(boundary) {
  if (mode !== "crash" || phase !== boundary) return Promise.resolve();
  process.stdout.write(JSON.stringify({ boundary }) + "\n");
  setInterval(() => {}, 1000);
  return new Promise(() => {});
}
const control = {
  async register() {}, async heartbeat() {}, async assignments() { return [assignment()]; }, async refresh() { return assignment(); }, async renew() { return assignment(); },
  async checkpoint(a, input) {
    if (input.commandId.endsWith(":committed")) await stop("receipt-before-checkpoint");
    command(input.commandId, { type: "checkpoint_work", workId: "work", leaseId: a.leaseId, ...input, at }, a.runRevision);
    await stop(input.commandId.endsWith(":pending") ? "pending-committed" : "result-committed");
    return assignment();
  },
  async complete(a, id, summary, outputs) { command(id, { type: "complete_work", workId: "work", leaseId: a.leaseId, summary, outputs, at }, a.runRevision); },
  async fail(a, id, error) { command(id, { type: "fail_work", workId: "work", leaseId: a.leaseId, error, at }, a.runRevision); },
  async block(a, id, reason) { command(id, { type: "block_work", workId: "work", leaseId: a.leaseId, reason, at }, a.runRevision); },
  async requestApproval() { throw new Error("Fixture has no approval action"); },
};
const registry = new CapabilityProviderRegistry();
registry.register({ name: "observe", source: "neutral", version: "1", priority: 1, description: "Observe", inputSchema: { type: "object" },
  providedCapabilities: ["observe"], dependencyCapabilities: [], permissionRequirements: {}, risk: "read_only", timeoutMs: 1000,
  async execute() {
    sqlite.prepare("INSERT INTO fixture_effects VALUES ('first')").run();
    return { status: "succeeded", summary: "Saved", raw: "Observation", refs: ["evidence:first"], retryable: false };
  },
});
const gateway = new PolicyExecutionToolGateway(registry, { async authorize() { return { decision: "approved" }; } }, new SqliteToolReceiptStore(sqlite),
  { allowedRisks: ["read_only"], permissionLayers: () => [{ source: "fixture", profile: { version: 1, platform: "darwin",
    filesystem: { read: [], write: [], deny: [] }, network: "deny", process: { access: "deny", interactive: false, background: false }, secrets: "handles_only" } }] },
  undefined, c.bindings);
if (mode === "recover") {
  c.bindings.recoverInterrupted();
  const work = c.runtime.load("run").workItems[0];
  if (work.status === "running") {
    command("recovery-block", { type: "block_work", workId: "work", leaseId: work.leaseId, reason: "Interrupted host", at });
    const continuation = new ScenarioWorkContinuationControl(sqlite, new ScenarioDefinitionRegistry([definition]), store, undefined,
      { async authorize() { return { decision: "allowed", authorizationRef: "test-only grant", expiresAt: "2099-01-01T00:00:00.000Z" }; } }, undefined, () => at);
    const continued = await continuation.continue({ runId: "run", workId: "work", commandId: "continue", actor: "operator", reason: "Recover after interruption",
      expectedRevision: c.runtime.load("run").revision, checkpointRef: work.latestCheckpoint.payloadRef });
    if (continued.audit.outcome !== "queued") throw new Error(JSON.stringify(continued));
    command("fresh-claim", { type: "claim_work", workId: "work", leaseId: "fresh", workerId: "worker", workerRoles: ["observer"], workerCapabilities: ["observe"],
      workerCurrentWork: 0, workerMaxConcurrentWork: 1, leaseExpiresAt: "2099-01-01T00:00:00.000Z", at });
  }
}
let modelCalls = 0;
const runtime = new LeaseWorkerRuntime(worker, control, { async decide(request) {
  modelCalls++;
  if (mode === "crash") return { type: "invoke_tool", invocation: { id: "first", tool: "observe", input: {}, rationale: "Observe" } };
  if (!request.transcript.some((entry) => entry.refs.includes("evidence:first"))) throw new Error("Confirmed result not restored before model");
  return { type: "complete", summary: "Done", outputs: [] };
} }, gateway, { async review() { return { action: "continue" }; } }, store, new BoundedOutputDistiller(), {}, () => at);
const outcome = c.runtime.load("run").workItems[0].status === "completed" ? { outcome: "completed" } : await runtime.execute(assignment());
process.stdout.write(JSON.stringify({ outcome: outcome.outcome, modelCalls, effects: sqlite.prepare("SELECT count(*) AS count FROM fixture_effects").get().count,
  workCount: c.runtime.load("run").workItems.length, integrity: sqlite.pragma("integrity_check", { simple: true }) }) + "\n");
sqlite.close();
