import type Database from "better-sqlite3";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { DurableScenarioRuntime, ScenarioDefinitionRegistry, type ScenarioCommand, type ScenarioDefinition } from "@traceforge/orchestration-core";
import { createDb, getSqliteClient } from "./db/client.js";
import { SqliteScenarioEventStore } from "./scenario-event-store.js";
import { SqliteToolInvocationBindingStore } from "./worker-execution-adapters.js";
import { ScenarioWorkRetryControl, registerScenarioWorkRetryRoutes, type ScenarioWorkRetryAuthorizer } from "./scenario-work-retry.js";
import { ToolInvocationReconciliationControl } from "./tool-invocation-reconciliation.js";

const databases: Database.Database[] = [];
afterEach(() => { databases.splice(0).forEach((db) => db.close()); });
const at = "2026-08-30T00:00:00.000Z";
const definition: ScenarioDefinition = {
  kind: "neutral", version: 1, title: "Neutral", authorizationActions: ["observe"], requiredCapabilities: ["observe"],
  workKinds: [{ id: "observe", defaultWorkerRoles: ["observer"] }], initialPhaseId: "observe",
  agentTopology: {
    planner: { enabled: false, pollIntervalMs: 1000, maximumGraphNodes: 1, maximumRecentEvents: 1, maximumRunItems: 1, maximumProposalsPerEvaluation: 1 },
    observer: { enabled: false, pollIntervalMs: 1000, maximumGraphNodes: 1, maximumRecentEvents: 1, maximumRunItems: 1 },
    workerPools: [{ id: "neutral", role: "observer", workKinds: ["observe"], activation: "on_demand", minimumInstances: 0, maximumInstances: 1, maxConcurrentWork: 1, capabilities: ["observe"] }],
  },
  phases: [{ id: "observe", title: "Observe", objective: "Observe", allowedWorkKinds: ["observe"], maxParallelWork: 1,
    requiredCapabilities: ["observe"], transitions: [{ to: "complete", allOf: [{ kind: "decision" }] }] }],
};
const allowed: ScenarioWorkRetryAuthorizer = { async authorize() { return { decision: "allowed", authorizationRef: "grant", expiresAt: "2099-01-01T00:00:00.000Z" }; } };
function setup(authorizer: ScenarioWorkRetryAuthorizer = allowed) {
  const sqlite = getSqliteClient(createDb(":memory:")); databases.push(sqlite);
  const definitions = new ScenarioDefinitionRegistry([definition]);
  const events = new SqliteScenarioEventStore(sqlite);
  const runtime = new DurableScenarioRuntime(events, definitions);
  const command = (id: string, command: ScenarioCommand) => runtime.execute({ runId: "run", commandId: id,
    expectedRevision: events.load("run").revision, definitionKind: "neutral", definitionVersion: 1, command }).state;
  command("start", { type: "start_run", runId: "run", caseId: "case", goal: "Observe", scopeRef: "scope", scenarioPackage: { id: "neutral", version: "1.0.0", schemaRevision: 1 }, availableCapabilities: ["observe"], at });
  command("propose", { type: "propose_work", proposal: { id: "work", kind: "observe", title: "Observe", objective: "Observe", idempotencyKey: "effect" }, at });
  const claim = (workId: string, leaseId: string) => command(`claim:${workId}:${leaseId}`, { type: "claim_work", workId, leaseId,
    workerId: "worker", workerRoles: ["observer"], workerCapabilities: ["observe"], workerCurrentWork: 0, workerMaxConcurrentWork: 1,
    leaseExpiresAt: "2099-01-01T00:00:00.000Z", at });
  claim("work", "lease");
  command("block", { type: "block_work", workId: "work", leaseId: "lease", reason: "interrupted", at });
  const input = { runId: "run", workId: "work", commandId: "retry", actor: "operator", reason: "verified safe", expectedRevision: 4 };
  const control = new ScenarioWorkRetryControl(sqlite, definitions, undefined, authorizer, undefined, () => at);
  return { sqlite, definitions, runtime, events, command, claim, control, input };
}
async function bind(context: ReturnType<typeof setup>) {
  const bindings = new SqliteToolInvocationBindingStore(context.sqlite, () => at);
  await bindings.prepare({ idempotencyKey: "call", invocationId: "first", tool: { name: "observe", source: "neutral", version: "1", contractFingerprint: "a".repeat(64) },
    inputFingerprint: "b".repeat(64), attribution: { caseId: "case", runId: "run", workId: "work" } });
  return bindings;
}

describe("Authorized blocked Work retry", () => {
  it("preserves the blocked Work, resets checkpoint/approvals, uses a new key and rejects the old lease", async () => {
    const c = setup();
    const result = await c.control.retry(c.input);
    expect(result.audit.outcome).toBe("queued");
    const state = c.runtime.load("run")!;
    expect(state.workItems[0]).toMatchObject({ status: "blocked", attempt: 1, error: "interrupted" });
    expect(state.workItems[1]).toMatchObject({ retryOf: "work", status: "queued", attempt: 1, latestCheckpoint: null, grantedActionKeys: [] });
    expect(state.workItems[1].idempotencyKey).not.toBe("effect");
    expect(() => c.claim(state.workItems[1].id, "lease")).toThrow("new lease");
    expect(c.claim(state.workItems[1].id, "fresh").workItems[1].attempt).toBe(2);
    expect(c.events.load("run").events.some((event) => event.type === "work_blocked")).toBe(true);
    expect((await c.control.retry(c.input)).replayed).toBe(true);
    await expect(c.control.retry({ ...c.input, reason: "changed" })).rejects.toThrow("conflicts");
  });

  it.each(["executing", "uncertain", "completed", "legacy", "receipt"])("rejects retry with %s effects", async (kind) => {
    const c = setup(); await bind(c);
    if (kind === "legacy") c.sqlite.exec("DELETE FROM tool_invocation_executions");
    else if (kind !== "receipt") c.sqlite.prepare("UPDATE tool_invocation_executions SET status = ?").run(kind);
    else c.sqlite.prepare("INSERT INTO worker_tool_receipts VALUES ('call', '{}', ?)").run(at);
    expect((await c.control.retry(c.input)).audit).toMatchObject({ outcome: "rejected", failure: expect.stringContaining("external effects") });
    expect(c.runtime.load("run")!.workItems).toHaveLength(1);
  });

  it("atomically releases a never-started binding and permits a new Work", async () => {
    const c = setup(); const bindings = await bind(c);
    expect((await c.control.retry(c.input)).audit.outcome).toBe("queued");
    expect(bindings.get("call")?.status).toBe("released");
    await expect(bindings.beginExecution("call", "lease", "worker")).rejects.toThrow("not prepared");
  });

  it("accepts actual authorized no-effect reconciliation but does not erase the original audit", async () => {
    const c = setup(); const bindings = await bind(c);
    c.sqlite.exec("UPDATE tool_invocation_executions SET status = 'uncertain'");
    const reconcile = new ToolInvocationReconciliationControl(c.sqlite, bindings,
      { async authorize() { return { decision: "allowed", reason: "grant" }; } },
      { async verify(input) { return { schemaVersion: 1, identity: input.expectedIdentity,
        executionOwnership: input.expectedExecutionOwnership, outcome: "no_effect_confirmed", resultFingerprint: null,
        cleanup: { status: "not_started", evidenceRef: "test-proof" }, issuedAt: at, expiresAt: "2099-01-01T00:00:00.000Z" }; } }, () => at);
    await reconcile.reconcile({ idempotencyKey: "call", commandId: "reconcile", actor: "operator", reason: "no effect",
      resolution: "confirmed_no_effect", evidence: "test-only trusted proof" });
    expect((await c.control.retry(c.input)).audit.outcome).toBe("queued");
    expect(reconcile.listAudits()).toHaveLength(1);
  });

  it.each(["denied", "throws", "expired"])("fails closed for %s authorization", async (kind) => {
    const c = setup({ async authorize() {
      if (kind === "throws") throw new Error("private detail");
      return kind === "denied" ? { decision: "denied" } : { decision: "allowed", authorizationRef: "expired", expiresAt: at };
    } });
    expect((await c.control.retry(c.input)).audit.outcome).toBe(kind === "expired" ? "rejected" : "denied");
    expect(c.runtime.load("run")!.revision).toBe(4);
  });

  it("serializes racing commands through revision and source-lineage checks", async () => {
    const c = setup();
    const results = await Promise.all([c.control.retry(c.input), c.control.retry({ ...c.input, commandId: "second" })]);
    expect(results.map((result) => result.audit.outcome)).toEqual(["queued", "rejected"]);
    expect(c.runtime.load("run")!.workItems).toHaveLength(2);
    expect((await c.control.retry({ ...c.input, commandId: "third", expectedRevision: 5 })).audit.outcome).toBe("rejected");
  });

  it("rolls back events and binding release when the success audit fails", async () => {
    const c = setup(); const bindings = await bind(c);
    c.sqlite.exec(`CREATE TEMP TRIGGER fail_retry_audit BEFORE INSERT ON scenario_work_retry_audits
      WHEN json_extract(NEW.audit_json, '$.outcome') = 'queued' BEGIN SELECT RAISE(ABORT, 'injected audit failure'); END`);
    expect((await c.control.retry(c.input)).audit.outcome).toBe("rejected");
    expect(c.runtime.load("run")!.revision).toBe(4);
    expect(bindings.get("call")?.status).toBe("prepared");
  });

  it("enforces immutable retry audits and default denial through the control API", async () => {
    const c = setup(); const app = Fastify();
    registerScenarioWorkRetryRoutes(app, new ScenarioWorkRetryControl(c.sqlite, c.definitions));
    const { runId, workId, ...body } = c.input;
    try {
      expect((await app.inject({ method: "POST", url: `/api/scenarios/runs/${runId}/work/${workId}/retry`, payload: body })).statusCode).toBe(403);
      expect(() => c.sqlite.exec("DELETE FROM scenario_work_retry_audits")).toThrow("immutable");
    } finally { await app.close(); }
  });
});
