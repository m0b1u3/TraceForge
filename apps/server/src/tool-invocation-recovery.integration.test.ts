import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import {
  createExecutionToolRegistry, PolicyExecutionToolGateway, ToolInvocationRecoveryRequiredError,
  type ToolExecutionResult, type WorkerAssignment,
} from "@traceforge/worker-runtime";
import type { WorkerDescriptor } from "@traceforge/orchestration-core";
import { createDb, getSqliteClient } from "./db/client.js";
import { SqliteToolInvocationBindingStore, SqliteToolReceiptStore } from "./worker-execution-adapters.js";
import { SqliteScenarioEventStore } from "./scenario-event-store.js";

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const at = "2026-08-30T00:00:00.000Z";
function assignment(): { worker: WorkerDescriptor; assignment: WorkerAssignment } {
  const worker: WorkerDescriptor = { id: "worker_1", roles: ["researcher"], capabilities: ["evidence.read"], maxConcurrentWork: 1, status: "online", heartbeatAt: at };
  return { worker, assignment: {
    runId: "run_1", leaseId: "lease_1", leaseExpiresAt: "2099-01-01T00:00:00.000Z", runRevision: 1,
    runContext: { caseId: "case_1", goal: "Observe", scopeRef: "scope_1", activePhaseId: "phase_1", directives: [] },
    work: {
      id: "work_1", runId: "run_1", phaseId: "phase_1", kind: "research", title: "Observe", objective: "Observe", priority: 1,
      status: "running", allowedWorkerRoles: ["researcher"], requiredCapabilities: ["evidence.read"], hypothesisIds: [], evidenceRefs: [],
      workerId: worker.id, leaseId: "lease_1", leaseExpiresAt: "2099-01-01T00:00:00.000Z", attempt: 1, maxAttempts: 3,
      idempotencyKey: "effect", latestCheckpoint: null, resumeFromCheckpoint: false, pendingApproval: null, approvalHistory: [],
      grantedActionKeys: [], resultSummary: null, error: null, createdAt: at, startedAt: at, finishedAt: null,
    },
  } };
}
const result: ToolExecutionResult = { status: "succeeded", summary: "completed", raw: "", refs: [], retryable: false };
function fixture(execute: () => Promise<ToolExecutionResult> = async () => result, timeoutMs = 1000) {
  const sqlite = getSqliteClient(createDb(":memory:"));
  databases.push(sqlite);
  const bindings = new SqliteToolInvocationBindingStore(sqlite, () => at);
  const receipts = new SqliteToolReceiptStore(sqlite, () => at);
  const input = assignment();
  input.assignment.leaseExpiresAt = "2099-01-01T00:00:00.000Z";
  sqlite.prepare(`INSERT INTO scenario_event_streams
    (run_id, case_id, definition_kind, definition_version, status, active_phase_id, revision, created_at, updated_at)
    VALUES ('run_1', 'case_1', 'neutral', 1, 'running', 'phase_1', 0, ?, ?)`).run(at, at);
  sqlite.prepare(`INSERT INTO scenario_work_leases VALUES ('run_1', 'work_1', 'worker_1', 'lease_1', '2099-01-01T00:00:00.000Z', ?)`).run(at);
  const registry = createExecutionToolRegistry([{
    name: "neutral.observe", source: "managed.neutral", version: "1.0.0", priority: 100, description: "Observe",
    inputSchema: {}, providedCapabilities: ["evidence.read"], dependencyCapabilities: [], permissionRequirements: {}, risk: "read_only", timeoutMs, execute,
  }]);
  const gateway = new PolicyExecutionToolGateway(registry, { async authorize() { return { decision: "approved" }; } }, receipts, {
    allowedRisks: ["read_only"], permissionLayers: () => [{ source: "neutral-test", profile: {
      version: 1, platform: "linux", filesystem: { read: [], write: [], deny: [] }, network: "deny",
      process: { access: "deny", interactive: false, background: false }, secrets: "deny",
    } }],
  }, undefined, bindings);
  const request = { ...input, invocation: { id: "call_1", tool: "neutral.observe", input: {}, rationale: "observe" }, idempotencyKey: "effect:call_1" };
  return { sqlite, bindings, receipts, gateway, request, registry };
}

describe("Tool Invocation execution ownership and recovery", () => {
  it("rolls back the binding if its initial execution journal cannot be persisted", async () => {
    let calls = 0;
    const context = fixture(async () => { calls++; return result; });
    context.sqlite.exec(`CREATE TEMP TRIGGER fail_journal BEFORE INSERT ON tool_invocation_executions
      BEGIN SELECT RAISE(ABORT, 'journal unavailable'); END`);
    await expect(context.gateway.execute(context.request)).rejects.toThrow("journal unavailable");
    expect(context.bindings.get(context.request.idempotencyKey)).toBeUndefined();
    expect(calls).toBe(0);
  });

  it.each(["prepared", "released"])("treats a pre-journal %s binding as uncertain instead of assuming it never executed", async (status) => {
    const context = fixture();
    const begin = context.bindings.beginExecution.bind(context.bindings);
    context.bindings.beginExecution = async () => { throw new Error("before execution"); };
    await expect(context.gateway.execute(context.request)).rejects.toThrow("before execution");
    context.bindings.beginExecution = begin;
    context.sqlite.exec("DELETE FROM tool_invocation_executions");
    if (status === "released") await context.bindings.release(context.request.idempotencyKey, "legacy terminal Work");
    const restarted = new SqliteToolInvocationBindingStore(context.sqlite, () => at);
    expect(restarted.recoverInterrupted()).toEqual({ completed: 0, uncertain: 1 });
    expect(restarted.execution(context.request.idempotencyKey)).toMatchObject({ status: "uncertain", reason: expect.stringContaining("Legacy") });
    if (status === "prepared") await expect(context.gateway.execute(context.request)).rejects.toBeInstanceOf(ToolInvocationRecoveryRequiredError);
    expect(await restarted.hasOpenBindings("managed.neutral", "1.0.0")).toBe(true);
  });

  it("checks the admission fence again after preparation and before executing", async () => {
    let calls = 0;
    const context = fixture(async () => { calls++; return result; });
    const prepare = context.bindings.prepare.bind(context.bindings);
    context.bindings.prepare = async (input) => {
      const binding = await prepare(input);
      await context.bindings.closeAdmission(input.tool.source, input.tool.version, "version quarantined");
      return binding;
    };
    await expect(context.gateway.execute(context.request)).rejects.toThrow("admission closed before execution");
    expect(calls).toBe(0);
  });
  it("atomically claims one execution and rejects a concurrent call for the same Work", async () => {
    let release!: () => void;
    let started!: () => void;
    const begun = new Promise<void>((resolve) => { started = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const context = fixture(async () => { calls++; started(); await blocked; return result; });
    const first = context.gateway.execute(context.request);
    await Promise.race([begun, first]);
    await expect(context.gateway.execute(context.request)).rejects.toBeInstanceOf(ToolInvocationRecoveryRequiredError);
    await expect(context.gateway.execute({ ...context.request, idempotencyKey: "effect:second", invocation: { ...context.request.invocation, id: "second" } }))
      .rejects.toBeInstanceOf(ToolInvocationRecoveryRequiredError);
    release();
    await first;
    expect(calls).toBe(1);
    expect(context.bindings.execution(context.request.idempotencyKey)?.status).toBe("completed");
  });

  it.each(["case", "run", "work", "invocation", "input", "tool"])("rejects receipt replay with a changed %s identity", async (field) => {
    const context = fixture();
    await context.gateway.execute(context.request);
    const request = structuredClone(context.request);
    if (field === "case") request.assignment.runContext.caseId = "other";
    if (field === "run") request.assignment.runId = "other";
    if (field === "work") request.assignment.work.id = "other";
    if (field === "invocation") request.invocation.id = "other";
    if (field === "input") request.invocation.input = { changed: true };
    if (field === "tool") request.invocation.tool = "other";
    await expect(context.gateway.execute(request)).rejects.toThrow("receipt identity");
    context.registry.drainSource("managed.neutral");
    await expect(context.gateway.execute(context.request)).resolves.toMatchObject({ status: "succeeded" });
  });

  it.each(["worker", "lease", "expired", "paused"])("does not execute with %s ownership", async (field) => {
    let calls = 0;
    const context = fixture(async () => { calls++; return result; });
    if (field === "worker") context.request.worker.id = "other";
    if (field === "lease") context.request.assignment.leaseId = "other";
    if (field === "expired") context.sqlite.exec("UPDATE scenario_work_leases SET lease_expires_at = '2020-01-01T00:00:00.000Z'");
    if (field === "paused") context.sqlite.exec("UPDATE scenario_event_streams SET status = 'paused'");
    await expect(context.gateway.execute(context.request)).rejects.toThrow("current Work lease");
    expect(calls).toBe(0);
    expect(context.bindings.execution(context.request.idempotencyKey)?.status).toBe("prepared");
  });

  it.each([false, true])("preserves uncertainty when receipt persistence fails (audit failure=%s)", async (auditFailure) => {
    let calls = 0;
    const context = fixture(async () => { calls++; return result; });
    context.sqlite.exec(`CREATE TEMP TRIGGER fail_receipt BEFORE INSERT ON worker_tool_receipts
      BEGIN SELECT RAISE(ABORT, 'receipt write failed'); END`);
    if (auditFailure) context.sqlite.exec(`CREATE TEMP TRIGGER fail_uncertainty BEFORE UPDATE ON tool_invocation_executions
      WHEN NEW.status = 'uncertain' BEGIN SELECT RAISE(ABORT, 'audit write failed'); END`);
    await expect(context.gateway.execute(context.request)).rejects.toBeInstanceOf(ToolInvocationRecoveryRequiredError);
    expect(context.bindings.execution(context.request.idempotencyKey)?.status).toBe(auditFailure ? "executing" : "uncertain");
    await expect(context.gateway.execute(context.request)).rejects.toBeInstanceOf(ToolInvocationRecoveryRequiredError);
    expect(calls).toBe(1);
    await expect(context.bindings.complete(context.request.idempotencyKey)).rejects.toThrow("without a durable receipt");
  });

  it("holds uncertainty after timeout even when the adapter ignores cancellation and returns late", async () => {
    let release!: () => void;
    const operation = new Promise<void>((resolve) => { release = resolve; });
    const context = fixture(async () => { await operation; return result; }, 10);
    await expect(context.gateway.execute(context.request)).rejects.toThrow("outcome requires reconciliation");
    release();
    await Promise.resolve();
    expect(await context.receipts.get(context.request.idempotencyKey)).toBeUndefined();
    expect(context.bindings.execution(context.request.idempotencyKey)?.status).toBe("uncertain");
    await expect(context.gateway.catalog(context.request.worker, context.request.assignment)).rejects.toBeInstanceOf(ToolInvocationRecoveryRequiredError);
    new SqliteScenarioEventStore(context.sqlite).append({ runId: "run_1", commandId: "block", fingerprint: "block",
      expectedRevision: 0, events: [{ type: "work_blocked", workId: "work_1", leaseId: "lease_1", reason: "reconciliation required", at }] });
    expect(context.bindings.get(context.request.idempotencyKey)?.status).toBe("released");
    expect(await context.bindings.hasOpenBindings("managed.neutral", "1.0.0")).toBe(true);
  });

  it("does not convert an exception after an external effect into a retryable failure receipt", async () => {
    let effects = 0;
    const context = fixture(async () => { effects++; throw new Error("transport disconnected after dispatch"); });
    await expect(context.gateway.execute(context.request)).rejects.toBeInstanceOf(ToolInvocationRecoveryRequiredError);
    await expect(context.gateway.execute(context.request)).rejects.toBeInstanceOf(ToolInvocationRecoveryRequiredError);
    expect(effects).toBe(1);
    expect(await context.receipts.get(context.request.idempotencyKey)).toBeUndefined();
    expect(context.bindings.execution(context.request.idempotencyKey)?.status).toBe("uncertain");
  });

  it("completes a durable receipt interrupted before binding completion and never invokes again", async () => {
    let calls = 0;
    const context = fixture(async () => { calls++; return result; });
    context.sqlite.exec(`CREATE TEMP TRIGGER fail_complete BEFORE UPDATE ON tool_invocation_executions
      WHEN NEW.status = 'completed' BEGIN SELECT RAISE(ABORT, 'completion interrupted'); END`);
    await expect(context.gateway.execute(context.request)).rejects.toThrow("completion interrupted");
    expect(context.bindings.get(context.request.idempotencyKey)?.status).toBe("prepared");
    context.sqlite.exec("DROP TRIGGER fail_complete");
    const restarted = new SqliteToolInvocationBindingStore(context.sqlite, () => at);
    expect(restarted.recoverInterrupted()).toEqual({ completed: 1, uncertain: 0 });
    expect(restarted.recoverInterrupted()).toEqual({ completed: 0, uncertain: 0 });
    await context.gateway.execute(context.request);
    expect(calls).toBe(1);
  });

  it("does not declare a malformed receipt completed during startup", async () => {
    const context = fixture();
    context.sqlite.exec(`CREATE TEMP TRIGGER fail_complete BEFORE UPDATE ON tool_invocation_executions
      WHEN NEW.status = 'completed' BEGIN SELECT RAISE(ABORT, 'completion interrupted'); END`);
    await expect(context.gateway.execute(context.request)).rejects.toThrow("completion interrupted");
    context.sqlite.exec("DROP TRIGGER fail_complete");
    context.sqlite.exec("UPDATE worker_tool_receipts SET result_json = '{}'");
    expect(() => new SqliteToolInvocationBindingStore(context.sqlite).recoverInterrupted()).toThrow("invalid tool result");
    expect(context.bindings.get(context.request.idempotencyKey)?.status).toBe("prepared");
  });
});
