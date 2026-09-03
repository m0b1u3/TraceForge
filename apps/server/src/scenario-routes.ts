import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  DurableScenarioRuntime,
  IdempotencyConflictError,
  RevisionConflictError,
  RunLifecycleConflictError,
  ScenarioDefinitionRegistry,
  type ScenarioCommand,
  type ScenarioOutput,
} from "@traceforge/orchestration-core";
import { ScenarioControlPlane, type ControlPlaneOptions } from "./scenario-control-plane.js";
import { SqliteScenarioEventStore, SqliteWorkerRegistry } from "./scenario-event-store.js";
import { SqliteScenarioAuthorizationService, AuthorizationRecoveryRequired } from "./scenario-authorization.js";
import type { BlackboardChangeBus } from "@traceforge/cognitive-runtime";
import {
  parseScenarioScope,
  ScenarioPackageBindingError,
  ScenarioPackageRegistry,
  type ScenarioEvidencePort,
} from "@traceforge/scenario-sdk";

const workerRole = z.string().min(1);
const workerStatus = z.enum(["online", "draining", "offline"]);
const workKind = z.string().min(1);
const outputKind = z.string().min(1);
const commandBase = z.object({ commandId: z.string().min(1), expectedRevision: z.number().int().nonnegative() });
const workerActionBase = commandBase.extend({ workerId: z.string().min(1), leaseId: z.string().min(1) });
const actionRisk = z.enum(["read_only", "bounded_write", "privileged", "destructive"]);

const workerRegistration = z.object({
  id: z.string().min(1),
  roles: z.array(workerRole).min(1),
  capabilities: z.array(z.string().min(1)),
  maxConcurrentWork: z.number().int().min(1).max(100),
  status: workerStatus.default("online"),
});

const startRun = z.object({
  commandId: z.string().min(1),
  runId: z.string().min(1),
  caseId: z.string().min(1),
  goal: z.string().min(1),
  scopeRef: z.string().min(1),
  scenarioKind: z.string().min(1),
  definitionVersion: z.number().int().positive(),
});

const scenarioAuthorization = z.object({
  id: z.string().min(1),
  caseId: z.string().min(1),
  scenarioKind: z.string().min(1),
  definitionVersion: z.number().int().positive().optional(),
  scope: z.unknown(),
  approvedBy: z.string().min(1),
  expiresAt: z.string().datetime(),
});

const proposeWork = commandBase.extend({
  proposal: z.object({
    id: z.string().min(1),
    kind: workKind,
    title: z.string().min(1),
    objective: z.string().min(1),
    priority: z.number().int().min(0).max(100).optional(),
    allowedWorkerRoles: z.array(workerRole).min(1).optional(),
    requiredCapabilities: z.array(z.string().min(1)).optional(),
    hypothesisIds: z.array(z.string().min(1)).optional(),
    evidenceRefs: z.array(z.string().min(1)).optional(),
    maxAttempts: z.number().int().min(1).max(20).optional(),
    idempotencyKey: z.string().min(1),
  }),
});

const output = z.object({
  id: z.string().min(1),
  kind: outputKind,
  summary: z.string().min(1),
  refs: z.array(z.string().min(1)),
});

export interface ScenarioRouteOptions {
  definitions?: ScenarioDefinitionRegistry;
  packages?: ScenarioPackageRegistry;
  now?: () => string;
  createId?: () => string;
  controlPlane?: Partial<ControlPlaneOptions>;
  autoScheduleIntervalMs?: number;
  changeBus?: BlackboardChangeBus;
  evidence?: ScenarioEvidencePort;
}

function sendError(reply: FastifyReply, error: unknown) {
  if(error instanceof AuthorizationRecoveryRequired)return reply.code(409).send({error:error.message,recoveryRequired:true});
  if (error instanceof z.ZodError) return reply.code(400).send({ error: "invalid request", issues: error.issues });
  if (error instanceof RevisionConflictError) {
    return reply.code(409).send({ error: error.message, expectedRevision: error.expectedRevision, actualRevision: error.actualRevision });
  }
  if (error instanceof IdempotencyConflictError) return reply.code(409).send({ error: error.message });
  if (error instanceof ScenarioPackageBindingError) {
    return reply.code(409).send({ error: error.message, recoveryRequired: true });
  }
  if (error instanceof RunLifecycleConflictError || error instanceof WorkerLeaseConflictError) {
    return reply.code(409).send({ error: error.message });
  }
  return reply.code(400).send({ error: error instanceof Error ? error.message : "scenario command failed" });
}

class WorkerLeaseConflictError extends Error {
  constructor(workerId: string, workId: string) {
    super(`Worker ${workerId} does not own work ${workId}`);
    this.name = "WorkerLeaseConflictError";
  }
}

export function registerScenarioRoutes(app: FastifyInstance, sqlite: Database.Database, options: ScenarioRouteOptions = {}): void {
  const now = options.now ?? (() => new Date().toISOString());
  const createId = options.createId ?? randomUUID;
  const store = new SqliteScenarioEventStore(sqlite, options.changeBus);
  const workers = new SqliteWorkerRegistry(sqlite);
  const definitions = options.definitions ?? new ScenarioDefinitionRegistry();
  const packages = options.packages ?? new ScenarioPackageRegistry();
  const authorizationService = new SqliteScenarioAuthorizationService(sqlite,packages,()=>Date.parse(now()));
  const runtime = new DurableScenarioRuntime(store, definitions, packages);
  const controlPlaneOptions: ControlPlaneOptions = {
    leaseDurationMs: options.controlPlane?.leaseDurationMs ?? 60_000,
    heartbeatTimeoutMs: options.controlPlane?.heartbeatTimeoutMs ?? 30_000,
    concurrencyRetries: options.controlPlane?.concurrencyRetries ?? 4,
  };
  const controlPlane = new ScenarioControlPlane(runtime, definitions, workers, controlPlaneOptions, createId);

  const requireRun = (runId: string) => {
    const state = runtime.load(runId);
    if (!state) throw new Error(`Unknown scenario run ${runId}`);
    return state;
  };
  const authorizationIsActive = (scopeRef: string, caseId: string, scenarioKind: string, at: string) => {
    const authorization = sqlite.prepare(`
      SELECT expires_at FROM scenario_authorizations
      WHERE id = ? AND case_id = ? AND scenario_kind = ? AND status = 'active'
    `).get(scopeRef, caseId, scenarioKind) as { expires_at: string } | undefined;
    return Boolean(authorization && Date.parse(authorization.expires_at) > Date.parse(at));
  };
  const enforceAuthorization = (runId: string, at: string) => {
    const state = requireRun(runId);
    if (authorizationIsActive(state.scopeRef, state.caseId, state.definitionKind, at)) {authorizationService.requireRun(state);return state;}
    if (state.status !== "running" && state.status !== "paused") return state;
    return runtime.execute({
      commandId: `authorization-closed:${state.scopeRef}`,
      runId,
      expectedRevision: state.revision,
      command: { type: "cancel_run", reason: `Scope authorization ${state.scopeRef} is no longer active`, at },
    }).state;
  };
  const requireWorkerLease = (runId: string, workId: string, workerId: string, leaseId: string) => {
    const state = requireRun(runId);
    const work = state.workItems.find((candidate) => candidate.id === workId);
    if (!work) throw new Error(`Unknown work item ${workId}`);
    if (work.workerId !== workerId || work.leaseId !== leaseId) throw new WorkerLeaseConflictError(workerId, workId);
    return state;
  };
  const execute = (runId: string, commandId: string, expectedRevision: number, command: ScenarioCommand) =>
    runtime.execute({ commandId, runId, expectedRevision, command });

  app.get("/api/scenarios/runs", async (request) => {
    const query = z.object({ caseId: z.string().min(1).optional() }).parse(request.query);
    return store.listRuns(query.caseId).map((run) => {
      const availability = packages.bindingStatus(run.scenarioPackage, run.definitionKind, run.definitionVersion);
      return {
        ...run,
        packageAvailability: availability.status,
        packageDiagnostic: availability.status === "recovery_required" ? availability.reason : null,
      };
    });
  });

  app.get("/api/scenarios/definitions", async () => definitions.list());

  app.get("/api/scenarios/authorizations", async (request) => {
    const query = z.object({ caseId: z.string().min(1) }).parse(request.query);
    const rows = sqlite.prepare(`
      SELECT id, case_id, scenario_kind, scope_json, approved_by, status, expires_at, created_at, updated_at
      FROM scenario_authorizations WHERE case_id = ? ORDER BY created_at DESC
    `).all(query.caseId) as Array<{
      id: string; case_id: string; scenario_kind: string; scope_json: string; approved_by: string;
      status: string; expires_at: string; created_at: string; updated_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      caseId: row.case_id,
      scenarioKind: row.scenario_kind,
      scope: JSON.parse(row.scope_json),
      approvedBy: row.approved_by,
      status: row.status,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      policyBinding: authorizationService.diagnostic(row.id,row.case_id),
    }));
  });

  app.post("/api/scenarios/authorizations", async (request, reply) => {
    try {
      const body = scenarioAuthorization.parse(request.body);
      if (!sqlite.prepare("SELECT 1 FROM cases WHERE id = ?").get(body.caseId)) {
        return reply.code(404).send({ error: `Unknown case ${body.caseId}` });
      }
      const scenarioPackage = packages.requireForScenario(body.scenarioKind,body.definitionVersion);
      const parsedScope = parseScenarioScope(scenarioPackage.authorizationPolicy,body.scope);
      const declaredActions = new Set(scenarioPackage.definition.authorizationActions);
      const unknownActions = [...parsedScope.allowedActions, ...parsedScope.deniedActions].filter((action) => !declaredActions.has(action));
      if (unknownActions.length) return reply.code(400).send({ error: `Authorization contains undeclared actions: ${[...new Set(unknownActions)].join(", ")}` });
      const at = now();
      if (Date.parse(body.expiresAt) <= Date.parse(at)) return reply.code(400).send({ error: "Authorization expiry must be in the future" });
      sqlite.transaction(()=>{sqlite.prepare(`
        INSERT INTO scenario_authorizations
          (id, case_id, scenario_kind, scope_json, approved_by, status, expires_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)
      `).run(body.id, body.caseId, body.scenarioKind, JSON.stringify(parsedScope.payload), body.approvedBy, body.expiresAt, at, at);
        authorizationService.pin(body.id,body.caseId,packages.bindingFor(scenarioPackage),0);
      })();
      return reply.code(201).send({ ...body, scope: parsedScope.payload, status: "active", createdAt: at, updatedAt: at,policyBinding:authorizationService.diagnostic(body.id,body.caseId) });
    } catch (error) { return sendError(reply, error); }
  });

  app.post("/api/scenarios/authorizations/:authorizationId/revoke", async (request, reply) => {
    try {
      const { authorizationId } = z.object({ authorizationId: z.string().min(1) }).parse(request.params);
      const at = now();
      const result = sqlite.prepare(
        "UPDATE scenario_authorizations SET status = 'revoked', updated_at = ? WHERE id = ? AND status = 'active'",
      ).run(at, authorizationId);
      if (result.changes !== 1) return reply.code(404).send({ error: `No active authorization ${authorizationId}` });
      sqlite.prepare(`
        UPDATE execution_sessions SET status = 'frozen', updated_at = ?
        WHERE scope_ref = ? AND status = 'active'
      `).run(at, authorizationId);
      const cancelledRunIds: string[] = [];
      for (const run of store.listRuns().filter((candidate) => candidate.status === "running" || candidate.status === "paused")) {
        if (packages.bindingStatus(run.scenarioPackage, run.definitionKind, run.definitionVersion).status !== "available") continue;
        const state = runtime.load(run.runId);
        if (state?.scopeRef !== authorizationId) continue;
        enforceAuthorization(run.runId, at);
        cancelledRunIds.push(run.runId);
      }
      return { id: authorizationId, status: "revoked", updatedAt: at, cancelledRunIds };
    } catch (error) { return sendError(reply, error); }
  });

  app.get("/api/scenarios/runs/:runId", async (request, reply) => {
    try {
      const { runId } = z.object({ runId: z.string().min(1) }).parse(request.params);
      const state = runtime.load(runId);
      return state ?? reply.code(404).send({ error: `Unknown scenario run ${runId}` });
    } catch (error) { return sendError(reply, error); }
  });

  app.get("/api/scenarios/approvals", async (request) => {
    const query = z.object({
      caseId: z.string().min(1).optional(),
      status: z.enum(["pending", "approved", "rejected", "cancelled"]).optional(),
    }).parse(request.query);
    return store.listApprovals(query);
  });

  app.post("/api/scenarios/approvals/:approvalId/resolve", async (request, reply) => {
    try {
      const { approvalId } = z.object({ approvalId: z.string().min(1) }).parse(request.params);
      const body = commandBase.extend({ approved: z.boolean(), reason: z.string().min(1) }).parse(request.body);
      const approval = store.listApprovals({ status: "pending" }).find((candidate) => candidate.id === approvalId);
      if (!approval) return reply.code(404).send({ error: `No pending approval ${approvalId}` });
      return execute(approval.runId, body.commandId, body.expectedRevision, {
        type: "resolve_work_approval",
        workId: approval.workId,
        approvalId,
        approved: body.approved,
        reason: body.reason,
        at: now(),
      });
    } catch (error) { return sendError(reply, error); }
  });

  app.post("/api/scenarios/runs", async (request, reply) => {
    try {
      const body = startRun.parse(request.body);
      const caseExists = sqlite.prepare("SELECT 1 FROM cases WHERE id = ?").get(body.caseId);
      if (!caseExists) return reply.code(404).send({ error: `Unknown case ${body.caseId}` });
      const at = now();
      const authorization = sqlite.prepare(`
        SELECT id, expires_at, scope_json FROM scenario_authorizations
        WHERE id = ? AND case_id = ? AND scenario_kind = ? AND status = 'active'
      `).get(body.scopeRef, body.caseId, body.scenarioKind) as { id: string; expires_at: string; scope_json: string } | undefined;
      if (!authorization || Date.parse(authorization.expires_at) <= Date.parse(at)) {
        return reply.code(403).send({ error: `Scope authorization ${body.scopeRef} is missing, expired, revoked, or mismatched` });
      }
      const scenarioPackage = packages.requireForScenario(body.scenarioKind, body.definitionVersion);
      const scenarioPackageBinding = packages.bindingFor(scenarioPackage);
      const {scope} = authorizationService.requireScope(body.scopeRef,body.caseId,scenarioPackage);
      const deniedActions = new Set(scope.deniedActions);
      const availableCapabilities = [...new Set([
        ...scope.allowedActions.filter((action) => !deniedActions.has(action)),
        ...workers.list().filter((worker) => worker.status !== "offline").flatMap((worker) => worker.capabilities),
      ])];
      const result = runtime.execute({
        commandId: body.commandId,
        runId: body.runId,
        expectedRevision: 0,
        definitionKind: body.scenarioKind,
        definitionVersion: body.definitionVersion,
        command: {
          type: "start_run",
          runId: body.runId,
          caseId: body.caseId,
          goal: body.goal,
          scopeRef: body.scopeRef,
          scenarioPackage: scenarioPackageBinding,
          availableCapabilities,
          at,
        },
      });
      return reply.code(result.idempotentReplay ? 200 : 201).send(result);
    } catch (error) { return sendError(reply, error); }
  });

  app.post("/api/scenarios/runs/:runId/work", async (request, reply) => {
    try {
      const { runId } = z.object({ runId: z.string().min(1) }).parse(request.params);
      const body = proposeWork.parse(request.body);
      return execute(runId, body.commandId, body.expectedRevision, { type: "propose_work", proposal: body.proposal, at: now() });
    } catch (error) { return sendError(reply, error); }
  });

  app.post("/api/scenarios/runs/:runId/tick", async (request, reply) => {
    try {
      const { runId } = z.object({ runId: z.string().min(1) }).parse(request.params);
      const at = now();
      const authorized = enforceAuthorization(runId, at);
      if (authorized.status !== "running") return { state: authorized, expiredLeaseIds: [], assignments: [] };
      return controlPlane.tick(runId, at);
    } catch (error) { return sendError(reply, error); }
  });

  app.post("/api/scenarios/runs/:runId/work/:workId/renew", async (request, reply) => {
    try {
      const { runId, workId } = z.object({ runId: z.string().min(1), workId: z.string().min(1) }).parse(request.params);
      const body = workerActionBase.parse(request.body);
      requireWorkerLease(runId, workId, body.workerId, body.leaseId);
      authorizationService.requireRun(requireRun(runId));
      return execute(runId, body.commandId, body.expectedRevision, {
        type: "renew_lease", workId, leaseId: body.leaseId,
        leaseExpiresAt: new Date(Date.parse(now()) + controlPlaneOptions.leaseDurationMs).toISOString(), at: now(),
      });
    } catch (error) { return sendError(reply, error); }
  });

  app.post("/api/scenarios/runs/:runId/work/:workId/checkpoint", async (request, reply) => {
    try {
      const { runId, workId } = z.object({ runId: z.string().min(1), workId: z.string().min(1) }).parse(request.params);
      const body = workerActionBase.extend({ checkpointId: z.string().min(1), progressSummary: z.string().min(1), payloadRef: z.string().min(1) }).parse(request.body);
      requireWorkerLease(runId, workId, body.workerId, body.leaseId);
      return execute(runId, body.commandId, body.expectedRevision, {
        type: "checkpoint_work", workId, leaseId: body.leaseId, checkpointId: body.checkpointId,
        progressSummary: body.progressSummary, payloadRef: body.payloadRef, at: now(),
      });
    } catch (error) { return sendError(reply, error); }
  });

  app.post("/api/scenarios/runs/:runId/work/:workId/complete", async (request, reply) => {
    try {
      const { runId, workId } = z.object({ runId: z.string().min(1), workId: z.string().min(1) }).parse(request.params);
      const body = workerActionBase.extend({ summary: z.string().min(1), outputs: z.array(output) }).parse(request.body);
      const state = requireWorkerLease(runId, workId, body.workerId, body.leaseId);
      const at = now();
      const work = state.workItems.find((candidate) => candidate.id === workId)!;
      const drafts: Omit<ScenarioOutput, "phaseId" | "producedByWorkId" | "schemaVersion">[] = body.outputs
        .map((value) => ({ ...value, createdAt: at }));
      const outputs = packages.prepareOutputs(state, drafts, work.phaseId, work.id);
      const result = execute(runId, body.commandId, body.expectedRevision, {
        type: "complete_work", workId, leaseId: body.leaseId, summary: body.summary, outputs, at,
      });
      if (!options.evidence && outputs.length) throw new Error("Scenario Evidence Port is unavailable");
      const evidenceRefs = options.evidence ? packages.mapOutputsToEvidence(result.state, outputs, options.evidence) : [];
      return { ...result, evidenceRefs };
    } catch (error) { return sendError(reply, error); }
  });

  app.post("/api/scenarios/runs/:runId/work/:workId/request-approval", async (request, reply) => {
    try {
      const { runId, workId } = z.object({ runId: z.string().min(1), workId: z.string().min(1) }).parse(request.params);
      const body = workerActionBase.extend({
        approvalId: z.string().min(1),
        actionKey: z.string().min(1),
        toolName: z.string().min(1),
        risk: actionRisk,
        rationale: z.string().min(1),
        inputRef: z.string().min(1),
      }).parse(request.body);
      requireWorkerLease(runId, workId, body.workerId, body.leaseId);
      return execute(runId, body.commandId, body.expectedRevision, {
        type: "request_work_approval",
        workId,
        leaseId: body.leaseId,
        approvalId: body.approvalId,
        actionKey: body.actionKey,
        toolName: body.toolName,
        risk: body.risk,
        rationale: body.rationale,
        inputRef: body.inputRef,
        at: now(),
      });
    } catch (error) { return sendError(reply, error); }
  });

  for (const action of ["fail", "block"] as const) {
    app.post(`/api/scenarios/runs/:runId/work/:workId/${action}`, async (request, reply) => {
      try {
        const { runId, workId } = z.object({ runId: z.string().min(1), workId: z.string().min(1) }).parse(request.params);
        const body = workerActionBase.extend({ reason: z.string().min(1) }).parse(request.body);
        requireWorkerLease(runId, workId, body.workerId, body.leaseId);
        const command: ScenarioCommand = action === "fail"
          ? { type: "fail_work", workId, leaseId: body.leaseId, error: body.reason, at: now() }
          : { type: "block_work", workId, leaseId: body.leaseId, reason: body.reason, at: now() };
        return execute(runId, body.commandId, body.expectedRevision, command);
      } catch (error) { return sendError(reply, error); }
    });
  }

  app.post("/api/scenarios/runs/:runId/advance", async (request, reply) => {
    try {
      const { runId } = z.object({ runId: z.string().min(1) }).parse(request.params);
      const body = commandBase.extend({ to: z.string().min(1) }).parse(request.body);
      return execute(runId, body.commandId, body.expectedRevision, { type: "advance_phase", to: body.to, at: now() });
    } catch (error) { return sendError(reply, error); }
  });

  app.post("/api/scenarios/runs/:runId/cancel", async (request, reply) => {
    try {
      const { runId } = z.object({ runId: z.string().min(1) }).parse(request.params);
      const body = commandBase.extend({ reason: z.string().min(1) }).parse(request.body);
      return execute(runId, body.commandId, body.expectedRevision, { type: "cancel_run", reason: body.reason, at: now() });
    } catch (error) { return sendError(reply, error); }
  });

  app.post("/api/scenarios/runs/:runId/pause", async (request, reply) => {
    try {
      const { runId } = z.object({ runId: z.string().min(1) }).parse(request.params);
      const body = commandBase.extend({ reason: z.string().min(1) }).parse(request.body);
      return execute(runId, body.commandId, body.expectedRevision, {
        type: "pause_run", reason: body.reason, requestedBy: "operator", at: now(),
      });
    } catch (error) { return sendError(reply, error); }
  });

  app.post("/api/scenarios/runs/:runId/resume", async (request, reply) => {
    try {
      const { runId } = z.object({ runId: z.string().min(1) }).parse(request.params);
      const body = commandBase.extend({ reason: z.string().min(1) }).parse(request.body);
      const state = requireRun(runId);
      const at = now();
      if (!authorizationIsActive(state.scopeRef, state.caseId, state.definitionKind, at)) {
        return reply.code(403).send({ error: `Scope authorization ${state.scopeRef} is not active; Run cannot resume` });
      }
      authorizationService.requireRun(state);
      return execute(runId, body.commandId, body.expectedRevision, {
        type: "resume_run", reason: body.reason, requestedBy: "operator", at,
      });
    } catch (error) { return sendError(reply, error); }
  });

  app.get("/api/scenarios/workers", async () => workers.list());

  app.get("/api/scenarios/workers/:workerId/assignments", async (request, reply) => {
    try {
      const { workerId } = z.object({ workerId: z.string().min(1) }).parse(request.params);
      if (!workers.list().some((worker) => worker.id === workerId)) return reply.code(404).send({ error: `Unknown worker ${workerId}` });
      const leaseQuery = sqlite.prepare(`
        SELECT run_id, work_id, lease_id, lease_expires_at FROM scenario_work_leases
        WHERE worker_id = ? ORDER BY updated_at ASC
      `);
      let leases = leaseQuery.all(workerId) as Array<{ run_id: string; work_id: string; lease_id: string; lease_expires_at: string }>;
      const at = now();
      for (const runId of new Set(leases.map((lease) => lease.run_id))) enforceAuthorization(runId, at);
      leases = leaseQuery.all(workerId) as typeof leases;
      return leases.map((lease) => {
        const state = requireRun(lease.run_id);
        const work = state.workItems.find((candidate) => candidate.id === lease.work_id);
        if (!work) throw new Error(`Lease ${lease.lease_id} references missing work ${lease.work_id}`);
        return {
          runId: lease.run_id,
          leaseId: lease.lease_id,
          leaseExpiresAt: lease.lease_expires_at,
          runRevision: state.revision,
          runContext: {
            caseId: state.caseId,
            goal: state.goal,
            scopeRef: state.scopeRef,
            activePhaseId: state.activePhaseId,
            directives: state.directives.filter((directive) => directive.targetWorkId === work.id),
          },
          work,
        };
      });
    } catch (error) { return sendError(reply, error); }
  });

  app.post("/api/scenarios/workers", async (request, reply) => {
    try {
      const body = workerRegistration.parse(request.body);
      const at = now();
      workers.upsert({ ...body, heartbeatAt: at }, at);
      return reply.code(201).send(workers.list().find((worker) => worker.id === body.id));
    } catch (error) { return sendError(reply, error); }
  });

  app.post("/api/scenarios/workers/:workerId/heartbeat", async (request, reply) => {
    try {
      const { workerId } = z.object({ workerId: z.string().min(1) }).parse(request.params);
      workers.heartbeat(workerId, now());
      return workers.list().find((worker) => worker.id === workerId);
    } catch (error) { return sendError(reply, error); }
  });

  app.post("/api/scenarios/workers/:workerId/status", async (request, reply) => {
    try {
      const { workerId } = z.object({ workerId: z.string().min(1) }).parse(request.params);
      const { status } = z.object({ status: workerStatus }).parse(request.body);
      workers.setStatus(workerId, status, now());
      return workers.list().find((worker) => worker.id === workerId);
    } catch (error) { return sendError(reply, error); }
  });

  if (options.autoScheduleIntervalMs !== undefined) {
    if (!Number.isInteger(options.autoScheduleIntervalMs) || options.autoScheduleIntervalMs < 100) {
      throw new Error("Automatic scenario scheduling interval must be at least 100ms");
    }
    const timer = setInterval(() => {
      const at = now();
      for (const run of store.listRuns().filter((candidate) => candidate.status === "running")) {
        try {
          const authorized = enforceAuthorization(run.runId, at);
          if (authorized.status !== "running") continue;
          controlPlane.tick(run.runId, at);
        } catch (error) {
          app.log.error({ err: error, runId: run.runId }, "Scenario control-plane tick failed");
        }
      }
    }, options.autoScheduleIntervalMs);
    timer.unref();
    app.addHook("onClose", async () => clearInterval(timer));
  }
}
