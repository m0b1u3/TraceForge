import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import type { LlmProvider } from "@traceforge/llm";
import type { ScenarioAgentEvent } from "@traceforge/shared";
import type { ExecutionNode } from "@traceforge/execution-node";
import type { ExecutionToolDiscoverySource } from "@traceforge/worker-runtime";
import { registerEmbeddedWorkers } from "./embedded-workers.js";
import { registerScenarioRoutes } from "./scenario-routes.js";
import { ExecutionSessionGateway, loadOrCreateVaultKey, SqliteEncryptedSecretVault } from "./execution-session-gateway.js";
import { registerExecutionSessionRoutes } from "./execution-session-routes.js";
import { SqliteEvidenceGraphStore } from "./evidence-graph-store.js";
import { registerEvidenceGraphRoutes } from "./evidence-graph-routes.js";
import { DurableScenarioRuntime, ScenarioDefinitionRegistry, WEB_BLACKBOX_SCENARIO } from "@traceforge/orchestration-core";
import { SqliteScenarioEventStore, SqliteWorkerRegistry } from "./scenario-event-store.js";
import { registerRunObserverRoutes, RunObserverSupervisor, SqliteRunObserverStore, StructuredRunObserverModel } from "./run-observer.js";
import { registerRunPlannerRoutes, RunPlannerSupervisor, SqliteRunPlannerStore, StructuredRunPlannerModel } from "./run-planner.js";
import { BlackboardChangeBus } from "./blackboard-change-bus.js";
import { SqliteCognitiveContextCursorStore } from "./cognitive-context-distiller.js";
import { registerCognitiveSnapshotRoutes, SqliteCognitiveSnapshotStore } from "./cognitive-context-snapshots.js";
import {
  DEFAULT_MODEL_ROLE_POLICIES,
  ModelExecutionRuntime,
  registerModelExecutionRoutes,
  SqliteModelExecutionStore,
  type CognitiveModelRole,
  type ModelRolePolicy,
} from "./model-execution-runtime.js";
import {
  DEFAULT_MODEL_RESOURCE_POLICY,
  ModelAdmissionController,
  registerModelAdmissionRoutes,
  SqliteModelAdmissionStore,
  type ModelResourcePolicy,
  type ModelResourcePolicyOverrides,
} from "./model-admission-controller.js";
import { registerScenarioAgentEventRoutes, SqliteScenarioAgentEventStream } from "./scenario-agent-event-stream.js";
import { registerScenarioCollaborationRoutes, ScenarioCollaborationSnapshotService } from "./scenario-collaboration-snapshot.js";
import { registerScenarioRunRecoveryRoutes, ScenarioRunRecoveryService } from "./scenario-run-recovery.js";
import type { ToolProviderInstallation } from "./tool-provider-control-plane.js";

export interface SecurityAgentFoundationOptions {
  autoScheduleIntervalMs?: number;
  modelRoutes?: ReadonlyMap<string, LlmProvider>;
  modelPolicies?: Partial<Record<CognitiveModelRole, Partial<ModelRolePolicy>>>;
  modelResourcePolicy?: ModelResourcePolicyOverrides;
  onAgentEvent?: (event: ScenarioAgentEvent) => void;
  executionNode?: ExecutionNode;
  toolDiscoverySources?: readonly ExecutionToolDiscoverySource[];
  toolProviderTrustRoots?: ReadonlyMap<string, string>;
  toolProviderSourceFactory?: (installation: ToolProviderInstallation) => Promise<ExecutionToolDiscoverySource> | ExecutionToolDiscoverySource;
}

/**
 * The standalone security-agent runtime composition root.
 *
 * Keep this module free of the retired chat-oriented AgentRuntime and its tool
 * registry. Scenario state, leases, checkpoints, approvals and Worker tools
 * are assembled exclusively through orchestration-core and worker-runtime.
 */
export function registerSecurityAgentFoundation(
  app: FastifyInstance,
  sqlite: Database.Database,
  provider: LlmProvider,
  projectRoot: string,
  providerReady: () => boolean,
  options: SecurityAgentFoundationOptions = {},
): void {
  const sessions = new ExecutionSessionGateway(
    sqlite,
    new SqliteEncryptedSecretVault(sqlite, loadOrCreateVaultKey(projectRoot)),
  );
  const changes = new BlackboardChangeBus();
  const evidenceGraph = new SqliteEvidenceGraphStore(sqlite, changes);
  const definitions = new ScenarioDefinitionRegistry([WEB_BLACKBOX_SCENARIO]);
  const scenarioEvents = new SqliteScenarioEventStore(sqlite, changes);
  const workers = new SqliteWorkerRegistry(sqlite);
  const scenarioRuntime = new DurableScenarioRuntime(scenarioEvents, definitions);
  const observerStore = new SqliteRunObserverStore(sqlite);
  const cognitiveCursors = new SqliteCognitiveContextCursorStore(sqlite);
  const agentEvents = new SqliteScenarioAgentEventStream(sqlite, options.onAgentEvent);
  const cognitiveSnapshots = new SqliteCognitiveSnapshotStore(sqlite, agentEvents);
  cognitiveSnapshots.recoverPrepared(new Date().toISOString());
  const modelExecutionStore = new SqliteModelExecutionStore(sqlite);
  const modelAdmissionStore = new SqliteModelAdmissionStore(sqlite);
  const modelRoutes = new Map<string, LlmProvider>([["primary", provider], ...(options.modelRoutes?.entries() ?? [])]);
  const modelPolicies = Object.fromEntries(
    (Object.keys(DEFAULT_MODEL_ROLE_POLICIES) as CognitiveModelRole[]).map((role) => [
      role,
      { ...DEFAULT_MODEL_ROLE_POLICIES[role], ...options.modelPolicies?.[role] },
    ]),
  ) as Record<CognitiveModelRole, ModelRolePolicy>;
  const modelResourcePolicy: ModelResourcePolicy = {
    ...DEFAULT_MODEL_RESOURCE_POLICY,
    ...options.modelResourcePolicy,
    roleConcurrency: { ...DEFAULT_MODEL_RESOURCE_POLICY.roleConcurrency, ...options.modelResourcePolicy?.roleConcurrency },
    rolePriorities: { ...DEFAULT_MODEL_RESOURCE_POLICY.rolePriorities, ...options.modelResourcePolicy?.rolePriorities },
  };
  const modelAdmissions = new ModelAdmissionController(modelResourcePolicy, modelAdmissionStore, undefined, undefined, undefined, agentEvents);
  const modelRuntime = new ModelExecutionRuntime(modelRoutes, modelPolicies, modelExecutionStore, modelAdmissions, undefined, undefined, agentEvents);
  agentEvents.reconcileFromProjections();
  const observer = new RunObserverSupervisor(
    scenarioRuntime,
    definitions,
    scenarioEvents,
    evidenceGraph,
    observerStore,
    new StructuredRunObserverModel(provider, undefined, cognitiveSnapshots, undefined, modelRuntime),
    undefined,
    undefined,
    undefined,
    (error) => app.log.error({ err: error }, "Run Observer evaluation failed"),
    cognitiveCursors,
  );
  const plannerStore = new SqliteRunPlannerStore(sqlite);
  const planner = new RunPlannerSupervisor(
    scenarioRuntime,
    definitions,
    scenarioEvents,
    evidenceGraph,
    plannerStore,
    new StructuredRunPlannerModel(provider, undefined, cognitiveSnapshots, undefined, modelRuntime),
    4,
    undefined,
    undefined,
    (error) => app.log.error({ err: error }, "Run Planner evaluation failed"),
  );
  registerScenarioRoutes(app, sqlite, { autoScheduleIntervalMs: options.autoScheduleIntervalMs ?? 1_000, changeBus: changes });
  registerExecutionSessionRoutes(app, sessions);
  registerEvidenceGraphRoutes(app, sqlite, evidenceGraph);
  registerRunObserverRoutes(app, observerStore);
  registerRunPlannerRoutes(app, plannerStore);
  const runRecovery = new ScenarioRunRecoveryService(scenarioRuntime, scenarioEvents, workers);
  registerScenarioCollaborationRoutes(app, new ScenarioCollaborationSnapshotService(
    scenarioRuntime,
    definitions,
    evidenceGraph,
    plannerStore,
    observerStore,
    workers,
    { cognitiveAgentsReady: providerReady },
  ));
  registerScenarioRunRecoveryRoutes(app, runRecovery);
  registerCognitiveSnapshotRoutes(app, cognitiveSnapshots, provider, providerReady);
  registerModelExecutionRoutes(app, modelExecutionStore);
  registerModelAdmissionRoutes(app, modelAdmissions, modelAdmissionStore);
  registerScenarioAgentEventRoutes(app, agentEvents);
  registerEmbeddedWorkers(
    app, sqlite, provider, projectRoot, providerReady, sessions, evidenceGraph, changes,
    cognitiveSnapshots, modelRuntime, agentEvents, options.executionNode, options.toolDiscoverySources,
    options.toolProviderTrustRoots, options.toolProviderSourceFactory,
  );
  const publishControlEvents = (change: Extract<Parameters<Parameters<typeof changes.subscribe>[0]>[0], { kind: "run" }>) => {
    const run = scenarioRuntime.load(change.runId);
    if (!run) return;
    const committed = scenarioEvents.load(change.runId).events.slice(change.revision - change.eventTypes.length, change.revision);
    committed.forEach((event, index) => {
      const revision = change.revision - committed.length + index + 1;
      const eventAt = event.type === "run_started" ? event.state.updatedAt : event.at;
      if (event.type === "work_approval_requested") {
        const turnId = `approval:${event.approval.id}`;
        agentEvents.append({
          method: "turn/started", runId: run.id, caseId: run.caseId, workId: event.workId, turnId, role: "system",
          createdAt: event.at, params: { agentInstanceId: "approval-gate", sourceRunRevision: revision, sourceGraphRevision: null },
        });
        agentEvents.append({
          method: "item/started", runId: run.id, caseId: run.caseId, workId: event.workId, turnId, role: "system",
          createdAt: event.at,
          params: { item: { type: "approval", id: event.approval.id, tool: event.approval.toolName, status: "pending", risk: event.approval.risk, reason: null } },
        });
        return;
      }
      if (event.type === "work_approval_resolved") {
        const row = sqlite.prepare(`SELECT tool_name, risk, status, resolution_reason FROM scenario_work_approvals WHERE id = ?`)
          .get(event.approvalId) as { tool_name: string; risk: "read_only" | "bounded_write" | "privileged" | "destructive"; status: "approved" | "rejected" | "cancelled"; resolution_reason: string | null } | undefined;
        if (!row) return;
        const turnId = `approval:${event.approvalId}`;
        agentEvents.append({
          method: "item/completed", runId: run.id, caseId: run.caseId, workId: event.workId, turnId, role: "system", createdAt: event.at,
          params: { item: { type: "approval", id: event.approvalId, tool: row.tool_name, status: row.status, risk: row.risk, reason: row.resolution_reason } },
        });
        agentEvents.append({
          method: "turn/completed", runId: run.id, caseId: run.caseId, workId: event.workId, turnId, role: "system", createdAt: event.at,
          params: { status: row.status === "cancelled" ? "cancelled" : "completed", outcome: row.status === "approved" ? "continue" : "blocked", checkpointRef: null, error: null },
        });
        return;
      }
      if (event.type === "work_cancelled" || event.type === "run_cancelled") {
        const cancelledApprovals = (event.type === "work_cancelled"
          ? sqlite.prepare(`
              SELECT id, work_id, tool_name, risk, resolution_reason
              FROM scenario_work_approvals
              WHERE run_id = ? AND work_id = ? AND status = 'cancelled' AND resolved_at = ?
            `).all(run.id, event.workId, event.at)
          : sqlite.prepare(`
              SELECT id, work_id, tool_name, risk, resolution_reason
              FROM scenario_work_approvals
              WHERE run_id = ? AND status = 'cancelled' AND resolved_at = ?
            `).all(run.id, event.at)) as Array<{
              id: string; work_id: string; tool_name: string;
              risk: "read_only" | "bounded_write" | "privileged" | "destructive";
              resolution_reason: string | null;
            }>;
        for (const approval of cancelledApprovals) {
          const turnId = `approval:${approval.id}`;
          agentEvents.append({
            method: "item/completed", runId: run.id, caseId: run.caseId, workId: approval.work_id, turnId, role: "system", createdAt: event.at,
            params: { item: { type: "approval", id: approval.id, tool: approval.tool_name, status: "cancelled", risk: approval.risk, reason: approval.resolution_reason } },
          });
          agentEvents.append({
            method: "turn/completed", runId: run.id, caseId: run.caseId, workId: approval.work_id, turnId, role: "system", createdAt: event.at,
            params: { status: "cancelled", outcome: "blocked", checkpointRef: null, error: null },
          });
        }
      }
      const control = (() => {
        if (event.type === "run_started") return { workId: null, summary: `Run started: ${event.state.goal}`, refs: [] };
        if (event.type === "work_completed") return { workId: event.workId, summary: event.summary, refs: event.outputs.flatMap((output) => output.refs) };
        if (event.type === "work_failed") return { workId: event.workId, summary: event.error, refs: [] };
        if (event.type === "work_requeued") return { workId: event.workId, summary: event.reason, refs: [] };
        if (event.type === "work_blocked" || event.type === "work_cancelled") return { workId: event.workId, summary: event.reason, refs: [] };
        if (event.type === "directive_issued") return { workId: event.directive.targetWorkId, summary: event.directive.instruction, refs: [`run-directive:${event.directive.id}`] };
        if (event.type === "phase_advanced") return { workId: null, summary: `Phase advanced from ${event.from} to ${event.to}`, refs: [] };
        if (event.type === "run_completed") return { workId: null, summary: "Run completed", refs: [] };
        if (event.type === "run_paused") return { workId: null, summary: event.reason, refs: [] };
        if (event.type === "run_resumed") return { workId: null, summary: event.reason, refs: [] };
        if (event.type === "run_cancelled") return { workId: null, summary: event.reason, refs: [] };
        return null;
      })();
      if (!control) return;
      const turnId = `control:${run.id}:${revision}`;
      agentEvents.append({
        method: "turn/started", runId: run.id, caseId: run.caseId, workId: control.workId, turnId, role: "system",
        createdAt: eventAt, params: { agentInstanceId: "scenario-control-plane", sourceRunRevision: revision, sourceGraphRevision: null },
      });
      agentEvents.append({
        method: "item/completed", runId: run.id, caseId: run.caseId, workId: control.workId, turnId, role: "system", createdAt: eventAt,
        params: { item: { type: "controlChange", id: `${run.id}:${revision}`, status: "completed", eventType: event.type, summary: control.summary, refs: control.refs } },
      });
      agentEvents.append({
        method: "turn/completed", runId: run.id, caseId: run.caseId, workId: control.workId, turnId, role: "system", createdAt: eventAt,
        params: {
          status: event.type.includes("cancelled") ? "cancelled" : event.type === "work_failed" ? "failed" : "completed",
          outcome: event.type === "work_blocked" ? "blocked" : event.type === "work_completed" || event.type === "run_completed" ? "finish" : "continue",
          checkpointRef: null, error: event.type === "work_failed" ? event.error : null,
        },
      });
    });
  };
  const unsubscribeChanges = changes.subscribe((change) => {
    if (change.kind === "run") publishControlEvents(change);
    if (change.kind === "run" && (change.eventTypes.includes("run_cancelled") || change.eventTypes.includes("run_paused"))) {
      modelRuntime.cancelRun(change.runId, change.eventTypes.includes("run_paused")
        ? "Run paused by the control plane"
        : "Run cancelled by the control plane");
    } else if (change.kind === "run" && change.eventTypes.includes("work_cancelled")) {
      const run = scenarioRuntime.load(change.runId);
      for (const work of run?.workItems ?? []) {
        if (work.status === "cancelled") modelRuntime.cancelWork(change.runId, work.id, "Work cancelled by the control plane");
      }
    }
    observer.wake();
    planner.wake();
  });
  const recoveryReport = runRecovery.recoverAll(new Date().toISOString());
  if (recoveryReport.actions.length || recoveryReport.issues.length) {
    app.log.info({ recoveryReport }, "Scenario Run startup recovery completed");
  }
  let cognitiveAgentsStarted = false;
  let listening = false;
  const startCognitiveAgents = () => {
    if (!listening || cognitiveAgentsStarted || !providerReady()) return;
    observer.start();
    planner.start();
    cognitiveAgentsStarted = true;
  };
  const readinessTimer = setInterval(startCognitiveAgents, 1_000);
  readinessTimer.unref();
  app.addHook("onListen", () => { listening = true; startCognitiveAgents(); });
  app.addHook("onClose", async () => {
    listening = false;
    unsubscribeChanges();
    clearInterval(readinessTimer);
    modelRuntime.shutdown();
    await observer.stop();
    await planner.stop();
  });
}
