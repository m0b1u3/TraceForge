import type Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { ScenarioDefinitionRegistry, type ScenarioCommand, type WorkerDescriptor } from "@traceforge/orchestration-core";
import { CapabilityProviderRegistry } from "@traceforge/tool-resolver";
import { BoundedOutputDistiller, JsonFileCheckpointStore, WorkerHost, PolicyExecutionToolGateway,
  executionToolContractFingerprint, toolInvocationInputFingerprint,
  type ExecutionToolAdapter, type WorkerAssignment, type WorkerCheckpointDocument, type WorkerCheckpointStore, type WorkerControlPlaneClient,
  type WorkerModel, type WorkerRunResult } from "@traceforge/worker-runtime";
import { ScenarioWorkContinuationControl, registerScenarioWorkContinuationRoutes, type ScenarioWorkContinuationAuthorizer } from "./scenario-work-continuation.js";
import { SqliteToolReceiptStore } from "./worker-execution-adapters.js";
import { SqliteWorkerCheckpointStore } from "./worker-checkpoint-store.js";
import { at, controls, database, definition, evidence, initialize, signEvidence } from "./test-fixtures/execution-recovery.js";

const databases: Database.Database[] = []; const roots: string[] = [];
afterEach(async () => { databases.splice(0).forEach((db) => { if (db.open) db.close(); }); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const allow: ScenarioWorkContinuationAuthorizer = { async authorize() { return { decision: "allowed", authorizationRef: "test-grant", expiresAt: "2099-01-01T00:00:00.000Z" }; } };
const spec = { name: "observe", source: "neutral", version: "1", priority: 1, description: "Observe",
  inputSchema: { type: "object" }, providedCapabilities: ["observe"], dependencyCapabilities: [], permissionRequirements: {},
  risk: "read_only" as const, timeoutMs: 1000 };
const invocation = { id: "first", tool: "observe", input: { candidate: "first" }, rationale: "Observe" };
const result = { status: "succeeded" as const, summary: "Observation saved", raw: "Observation", refs: ["evidence:first"], retryable: false };
const worker: WorkerDescriptor = { id: "worker", roles: ["observer"], capabilities: ["observe"], status: "online", maxConcurrentWork: 1, heartbeatAt: at };

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "traceforge-continuation-")); roots.push(root);
  const path = join(root, "state.db"); const sqlite = database(path); databases.push(sqlite);
  const c = initialize(sqlite); const store = new JsonFileCheckpointStore(join(root, "checkpoints"));
  const command = (id: string, command: ScenarioCommand) => c.runtime.execute({ runId: "run", commandId: id,
    expectedRevision: c.runtime.load("run")!.revision, command }).state;
  const checkpoint: WorkerCheckpointDocument = { version: 2, workerId: "worker", runId: "run", workId: "work", caseId: "case", workKey: "effect",
    leaseId: "lease", turn: 0, transcript: [], steering: [], completedInvocationIds: [], consecutiveFailures: 0, savedAt: at,
    pendingInvocation: { turn: 1, invocation, risk: spec.risk, contractFingerprint: executionToolContractFingerprint(spec) } };
  const save = async () => {
    const ref = await store.save(checkpoint);
    command(`checkpoint:${c.runtime.load("run")!.revision}`, { type: "checkpoint_work", workId: "work", leaseId: "lease",
      checkpointId: `snapshot:${c.runtime.load("run")!.revision}`, progressSummary: "Pending", payloadRef: ref, at });
    return ref;
  };
  const bind = async (id = "first") => c.bindings.prepare({ idempotencyKey: `effect:${id}`, invocationId: id,
    tool: { name: spec.name, source: spec.source, version: spec.version, contractFingerprint: executionToolContractFingerprint(spec) },
    inputFingerprint: toolInvocationInputFingerprint(spec.name, invocation.input), attribution: { caseId: "case", runId: "run", workId: "work" } });
  const continuation = (authorizer = allow, db = sqlite) => new ScenarioWorkContinuationControl(db, new ScenarioDefinitionRegistry([definition]),
    new JsonFileCheckpointStore(join(root, "checkpoints")), undefined, authorizer, undefined, () => at);
  const input = () => ({ runId: "run", workId: "work", commandId: "continue", actor: "operator", reason: "Continue confirmed progress",
    expectedRevision: c.runtime.load("run")!.revision, checkpointRef: c.runtime.load("run")!.workItems[0]!.latestCheckpoint!.payloadRef });
  const claim = (leaseId = "fresh") => command(`claim:${leaseId}`, { type: "claim_work", workId: "work", leaseId, workerId: "worker",
    workerRoles: ["observer"], workerCapabilities: ["observe"], workerCurrentWork: 0, workerMaxConcurrentWork: 1,
    leaseExpiresAt: "2099-01-01T00:00:00.000Z", at });
  return { ...c, root, path, store, checkpoint, command, bind, save, continuation, input, claim };
}

/** Production kernel, ledger, gateway and file store; only transport/model/provider are local fixtures. */
function executor(sqlite: Database.Database, store: WorkerCheckpointStore, model: WorkerModel, options: {
  tool?: ExecutionToolAdapter; failResultCheckpoint?: boolean;
} = {}) {
  const c = controls(sqlite); const registry = new CapabilityProviderRegistry<ExecutionToolAdapter>();
  if (options.tool) registry.register(options.tool);
  const assignment = (): WorkerAssignment => {
    const state = c.runtime.load("run")!; const work = state.workItems[0]!;
    return { runId: state.id, runRevision: state.revision, leaseId: work.leaseId!, leaseExpiresAt: work.leaseExpiresAt!, work,
      runContext: { caseId: state.caseId, goal: state.goal, scopeRef: state.scopeRef, activePhaseId: state.activePhaseId, directives: [] } };
  };
  const execute = (commandId: string, command: ScenarioCommand, expectedRevision: number) => c.runtime.execute({ runId: "run", commandId, expectedRevision, command });
  const control: WorkerControlPlaneClient = {
    async register() {}, async heartbeat() {}, async assignments() { return [assignment()]; }, async refresh() { return assignment(); }, async renew() { return assignment(); },
    async checkpoint(a, input) {
      if (options.failResultCheckpoint && input.commandId.endsWith(":committed")) throw new Error("injected checkpoint transport failure");
      execute(input.commandId, { type: "checkpoint_work", workId: a.work.id, leaseId: a.leaseId, ...input, at }, a.runRevision);
      return assignment();
    },
    async complete(a, id, summary, outputs) { execute(id, { type: "complete_work", workId: a.work.id, leaseId: a.leaseId, summary,
      outputs: outputs.map((output) => ({ ...output, createdAt: at })), at }, a.runRevision); },
    async block(a, id, reason) { execute(id, { type: "block_work", workId: a.work.id, leaseId: a.leaseId, reason, at }, a.runRevision); },
    async fail(a, id, error) { execute(id, { type: "fail_work", workId: a.work.id, leaseId: a.leaseId, error, at }, a.runRevision); },
    async requestApproval(a, input) { execute(input.commandId, { type: "request_work_approval", workId: a.work.id, leaseId: a.leaseId, ...input, at }, a.runRevision); },
  };
  const gateway = new PolicyExecutionToolGateway(registry, { async authorize() { return { decision: "pending", approvalRef: "approval:first" }; } },
    new SqliteToolReceiptStore(sqlite, () => at), { allowedRisks: ["read_only", "privileged"], permissionLayers: () => [{ source: "fixture", profile: {
      version: 1, platform: "darwin", filesystem: { read: [], write: [], deny: [] }, network: "deny",
      process: { access: "deny", interactive: false, background: false }, secrets: "handles_only",
    } }] }, undefined, c.bindings);
  const runtime = new WorkerHost(worker, control, model, gateway, { async review() { return { action: "continue" }; } }, store,
    new BoundedOutputDistiller(), {}, () => at);
  return { run: (): Promise<WorkerRunResult> => runtime.execute(assignment()), c };
}
const finish: WorkerModel = { async decide(request) {
  expect(request.transcript.some((entry) => entry.refs.includes("evidence:first"))).toBe(true);
  return { type: "complete", summary: "Done", outputs: [{ id: "output", kind: "evidence", summary: "Observation", refs: ["evidence:first"] }] };
} };

describe("Authorized partial Work continuation", () => {
  it("blocks before provider dispatch when the production checkpoint pool is full", async () => {
    const c = await setup(); const store = new SqliteWorkerCheckpointStore(c.sqlite);
    await store.save(c.checkpoint);
    c.sqlite.exec("UPDATE execution_storage_policies SET maximum_records = 1 WHERE kind = 'checkpoint'");
    let calls = 0;
    const runtime = executor(c.sqlite, store, { async decide() { return { type: "invoke_tool", invocation }; } }, {
      tool: { ...spec, async execute() { calls++; return result; } },
    });
    expect(await runtime.run()).toMatchObject({ outcome: "failed", reason: expect.stringContaining("capacity exhausted") });
    expect(calls).toBe(0); expect(c.sqlite.prepare("SELECT * FROM worker_tool_receipts").all()).toHaveLength(0);
  });

  it("continues a partially completed Work using the production SQLite checkpoint store", async () => {
    const c = await setup(); const store = new SqliteWorkerCheckpointStore(c.sqlite); let calls = 0;
    const first = executor(c.sqlite, store, { async decide() { return { type: "invoke_tool", invocation }; } }, {
      tool: { ...spec, async execute() { calls++; return result; } }, failResultCheckpoint: true,
    });
    expect((await first.run()).outcome).toBe("failed");
    const continuation = new ScenarioWorkContinuationControl(c.sqlite, new ScenarioDefinitionRegistry([definition]), store, undefined, allow, undefined, () => at);
    expect((await continuation.continue(c.input())).audit.outcome).toBe("queued"); c.claim();
    expect((await executor(c.sqlite, store, finish).run()).outcome).toBe("completed"); expect(calls).toBe(1);
  });
  it("survives receipt commit followed by checkpoint failure and a host restart, without redispatch or model replanning", async () => {
    const c = await setup(); let calls = 0;
    const first = executor(c.sqlite, c.store, { async decide() { return { type: "invoke_tool", invocation }; } }, {
      tool: { ...spec, async execute() { calls++; return result; } }, failResultCheckpoint: true,
    });
    expect(await first.run()).toMatchObject({ outcome: "failed", reason: "injected checkpoint transport failure" }); expect(calls).toBe(1);
    const request = c.input(); const saved = await c.store.load(request.checkpointRef);
    expect(saved).toMatchObject({ turn: 0, completedInvocationIds: [], pendingInvocation: { invocation } });
    c.sqlite.close(); const fresh = database(c.path); databases.push(fresh);
    const resumed = executor(fresh, new JsonFileCheckpointStore(join(c.root, "checkpoints")), finish);
    resumed.c.bindings.recoverInterrupted();
    const control = c.continuation(allow, fresh);
    expect((await control.continue(request)).audit.outcome).toBe("queued");
    expect((await control.continue(request)).replayed).toBe(true);
    const queued = resumed.c.runtime.load("run")!;
    expect(queued.workItems).toHaveLength(1);
    expect(queued.workItems[0]).toMatchObject({ id: "work", idempotencyKey: "effect", attempt: 1, resumeFromCheckpoint: true });
    const claim = (leaseId: string) => resumed.c.runtime.execute({ runId: "run", commandId: `claim:${leaseId}`, expectedRevision: queued.revision,
      command: { type: "claim_work", workId: "work", leaseId, workerId: "worker", workerRoles: ["observer"], workerCapabilities: ["observe"],
        workerCurrentWork: 0, workerMaxConcurrentWork: 1, leaseExpiresAt: "2099-01-01T00:00:00.000Z", at } });
    expect(() => claim("lease")).toThrow("new lease"); claim("fresh");
    expect((await resumed.run()).outcome).toBe("completed"); expect(calls).toBe(1);
    expect(resumed.c.runtime.load("run")!.workItems[0]!.attempt).toBe(1);
  });

  it("reopens only the saved never-started binding after explicit authorization", async () => {
    const c = await setup(); await c.save(); await c.bind(); c.block();
    expect(c.bindings.get("effect:first")?.status).toBe("released");
    expect((await c.continuation().continue(c.input())).audit.outcome).toBe("queued"); c.claim();
    let calls = 0;
    const runtime = executor(c.sqlite, c.store, finish, { tool: { ...spec, async execute(input) {
      expect(input).toEqual(invocation.input); calls++; return result;
    } } });
    expect(await runtime.run()).toMatchObject({ outcome: "completed" }); expect(calls).toBe(1);
  });

  it("blocks uncertain effects, then uses signed no-effect reconciliation without reviving the old key", async () => {
    const c = await setup(); await c.save(); await c.bind(); await c.bindings.beginExecution("effect:first", "lease", "worker");
    await c.bindings.markUncertain("effect:first", "Interrupted"); c.block();
    expect((await c.continuation().continue(c.input())).audit.outcome).toBe("rejected");
    const proof = signEvidence(evidence(c, "effect:first"));
    expect((await c.reconciliation.reconcile({ idempotencyKey: "effect:first", commandId: "no-effect", actor: "operator",
      reason: "Independent proof", resolution: "confirmed_no_effect", evidence: proof })).audit.outcome).toBe("resolved");
    expect((await c.continuation().continue({ ...c.input(), commandId: "continue-confirmed" })).audit.outcome).toBe("queued"); c.claim();
    const runtime = executor(c.sqlite, c.store, { async decide(request) {
      expect(request.transcript.some((entry) => entry.summary.includes("no effect"))).toBe(true);
      return { type: "complete", summary: "No effect confirmed", outputs: [] };
    } });
    expect((await runtime.run()).outcome).toBe("completed");
    expect(c.bindings.get("effect:first")?.status).toBe("released");
    expect(await new SqliteToolReceiptStore(c.sqlite).get("effect:first")).toBeUndefined();
  });

  it("restores the exact approved invocation without asking the model to repeat it", async () => {
    const c = await setup(); let modelCalls = 0; let toolCalls = 0;
    const tool: ExecutionToolAdapter = { ...spec, risk: "privileged", async execute() { toolCalls++; return result; } };
    const first = executor(c.sqlite, c.store, { async decide() { modelCalls++; return { type: "invoke_tool", invocation }; } }, { tool });
    expect(await first.run()).toMatchObject({ outcome: "waiting_approval" }); expect(toolCalls).toBe(0);
    c.command("approve", { type: "resolve_work_approval", workId: "work", approvalId: "approval:first", approved: true, reason: "Approved", at });
    c.claim(); const next = executor(c.sqlite, c.store, finish, { tool });
    expect((await next.run()).outcome).toBe("completed"); expect(modelCalls).toBe(1); expect(toolCalls).toBe(1);
  });

  it.each(["unknown-action", "missing-receipt", "wrong-input", "wrong-contract", "wrong-case", "turn-budget", "failure-budget", "legacy"])("rejects %s checkpoint/ledger disagreement", async (kind) => {
    const c = await setup();
    if (kind === "unknown-action") await c.bind("second");
    if (kind === "missing-receipt") { await c.bind(); c.checkpoint.pendingInvocation = null; c.checkpoint.completedInvocationIds = ["first"]; }
    if (kind === "wrong-input" || kind === "wrong-contract") {
      await c.bind(); c.checkpoint.pendingInvocation = structuredClone(c.checkpoint.pendingInvocation!);
      if (kind === "wrong-input") c.checkpoint.pendingInvocation!.invocation.input = { candidate: "second" };
      else c.checkpoint.pendingInvocation!.contractFingerprint = "b".repeat(64);
    }
    if (kind === "wrong-case") c.checkpoint.caseId = "other";
    if (kind === "turn-budget") { c.checkpoint.turn = 24; c.checkpoint.pendingInvocation = null; }
    if (kind === "failure-budget") c.checkpoint.consecutiveFailures = 3;
    if (kind === "legacy") { c.checkpoint.version = 1; delete c.checkpoint.pendingInvocation; }
    await c.save(); c.block();
    expect((await c.continuation().continue(c.input())).audit.outcome).toBe("rejected");
    expect(c.runtime.load("run")!.workItems[0]!.status).toBe("blocked");
  });

  it.each(["denied", "expired", "throws"])("fails closed for %s authorization", async (kind) => {
    const c = await setup(); await c.save(); c.block();
    const control = c.continuation({ async authorize() {
      if (kind === "throws") throw new Error("unavailable");
      return kind === "denied" ? { decision: "denied" } : { decision: "allowed", authorizationRef: "grant", expiresAt: at };
    } });
    expect((await control.continue(c.input())).audit.outcome).toBe(kind === "expired" ? "rejected" : "denied");
  });

  it("rolls back queueing and binding reopening when audit capacity is exhausted; same request can resume", async () => {
    const c = await setup(); await c.save(); await c.bind(); c.block(); const request = c.input();
    c.sqlite.exec("UPDATE execution_storage_policies SET maximum_bytes = 1 WHERE kind = 'retry'");
    await expect(c.continuation().continue(request)).rejects.toThrow("capacity exhausted");
    expect(c.runtime.load("run")!.workItems[0]!.status).toBe("blocked");
    expect(c.bindings.get("effect:first")?.status).toBe("released");
    c.sqlite.exec("UPDATE execution_storage_policies SET maximum_bytes = 134217728 WHERE kind = 'retry'");
    expect((await c.continuation().continue(request)).audit.outcome).toBe("queued");
  });

  it("keeps checkpoint read I/O failure resumable and returns 503 without a rejected audit", async () => {
    const c = await setup(); await c.save(); c.block(); const request = c.input(); let fail = true;
    const control = new ScenarioWorkContinuationControl(c.sqlite, new ScenarioDefinitionRegistry([definition]), {
      save: (document) => c.store.save(document), async load(ref) {
        if (fail) throw Object.assign(new Error("injected read failure"), { code: "EIO" });
        return c.store.load(ref);
      },
    }, undefined, allow, undefined, () => at);
    const app = Fastify(); registerScenarioWorkContinuationRoutes(app, control);
    try {
      const { runId, workId, ...payload } = request;
      expect((await app.inject({ method: "POST", url: `/api/scenarios/runs/${runId}/work/${workId}/continue`, payload })).statusCode).toBe(503);
      expect(c.sqlite.prepare("SELECT * FROM scenario_work_retry_audits").all()).toHaveLength(0);
      fail = false; expect((await control.continue(request)).audit.outcome).toBe("queued");
    } finally { await app.close(); }
  });

  it("never replans a legacy/unrepresented receipt during automatic lease recovery", async () => {
    const c = await setup(); await c.bind(); await new SqliteToolReceiptStore(c.sqlite).put("effect:first", result);
    let modelCalls = 0;
    const resumed = executor(c.sqlite, c.store, { async decide() { modelCalls++; return { type: "complete", summary: "Done", outputs: [] }; } });
    expect(await resumed.run()).toMatchObject({ outcome: "blocked", reason: expect.stringContaining("absent from the checkpoint") });
    expect(modelCalls).toBe(0);
  });

  it("serializes different commands and rejects changed content under the same command", async () => {
    const c = await setup(); await c.save(); c.block(); const request = c.input(); const control = c.continuation();
    const results = await Promise.all([control.continue(request), control.continue({ ...request, commandId: "second" })]);
    expect(results.map((entry) => entry.audit.outcome).sort()).toEqual(["queued", "rejected"]);
    await expect(control.continue({ ...request, reason: "changed" })).rejects.toThrow("conflicts");
    expect(c.sqlite.prepare("SELECT * FROM scenario_work_retry_audits").all()).toHaveLength(2);
  });

  it("denies by default through HTTP, rejects stale revision and reuses the immutable recovery audit budget", async () => {
    const c = await setup(); await c.save(); c.block(); const request = c.input(); const app = Fastify();
    registerScenarioWorkContinuationRoutes(app, new ScenarioWorkContinuationControl(c.sqlite, new ScenarioDefinitionRegistry([definition]), c.store));
    try {
      const { runId, workId, ...payload } = request;
      expect((await app.inject({ method: "POST", url: `/api/scenarios/runs/${runId}/work/${workId}/continue`, payload })).statusCode).toBe(403);
      expect((await c.continuation().continue({ ...request, commandId: "stale", expectedRevision: 0 })).audit.outcome).toBe("rejected");
      expect(() => c.sqlite.exec("DELETE FROM scenario_work_retry_audits")).toThrow("immutable");
      expect(c.sqlite.prepare("SELECT records FROM execution_storage_usage WHERE kind = 'retry'").get()).toEqual({ records: 2 });
    } finally { await app.close(); }
  });
});
