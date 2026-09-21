import { resolve } from "node:path";
import { ConversationWorkspaces } from "./conversation-workspaces.js";
import { executionDisplay } from "@traceforge/worker-runtime";
import { desktopToolReceiptReference } from "./desktop-record-evidence.js";
import { RunToolPolicy } from "./run-tool-policy.js";
import type { DesktopBrowserSessions } from "./desktop-browser-sessions.js";

import { DesktopApprovalPreference } from "./desktop-approval-preference.js";
import { readRunForensics } from "./scenario-run-disposal.js";
import type Database from "better-sqlite3";
import type { SqliteScenarioAuthorizationService } from "./scenario-authorization.js";
import type { ContextCompactionPolicy } from "@traceforge/cognitive-runtime";
import type { FastifyInstance } from "fastify";
import type { LlmProvider } from "@traceforge/llm";
import { EXECUTION_PROTOCOL_VERSION, type ExecutionNode } from "@traceforge/execution-node";
import {
  DurableScenarioRuntime,
  ScenarioDefinitionRegistry,
  type ScenarioDefinition,
  type PermissionProfile,
  type ScenarioRunState,
  type ScenarioRunBindingValidator,
  type ScenarioWorkerPoolDefinition,
  type WorkerDescriptor,
} from "@traceforge/orchestration-core";
import {
  BoundedOutputDistiller,
  ExecutionToolDiscoveryRuntime,
  HttpWorkerControlPlaneClient,
  JsonFileCheckpointStore,
  WorkerHost,
  LoopGuardObserver,
  PolicyExecutionToolGateway,
  ToolProviderFairScheduler,
  WorkerSupervisor,
  RunWorkspace,
  workspaceExecutionSeconds,
  type ExecutionToolAdapter,
  type ExecutionToolDiscoverySource,
  type ProviderCapabilityHost,
  type ToolProviderRecoverySnapshot,
  type WorkerModelContextPolicy,
  type ToolExecutionContext,
  type WorkspaceProject,
} from "@traceforge/worker-runtime";
import { StructuredWorkerModel } from "@traceforge/cognitive-runtime";
import { ExecutionNodeProcessTool, SqliteToolInvocationBindingStore, SqliteToolReceiptStore } from "./worker-execution-adapters.js";
import { EvidenceGraphMutateTool, EvidenceGraphSnapshotTool } from "./evidence-graph-tools.js";
import type { SqliteEvidenceGraphStore } from "./evidence-graph-store.js";
import { SqliteScenarioEventStore, SqliteWorkerRegistry } from "./scenario-event-store.js";
import type { BlackboardChangeBus } from "@traceforge/cognitive-runtime";
import type { SqliteCognitiveSnapshotStore } from "./cognitive-context-snapshots.js";
import type { ModelExecutionRuntime } from "./model-execution-runtime.js";
import type { ScenarioAgentEventWriter } from "./scenario-agent-event-stream.js";
import { registerExecutionToolRuntimeRoutes } from "./execution-tool-runtime-routes.js";
import {
  createToolProviderRuntimeBinding,
  registerToolProviderControlRoutes,
  SqliteToolProviderControlStore,
  ToolProviderControlPlane,
  type ToolProviderInstallation,
} from "./tool-provider-control-plane.js";
import { ManagedToolProviderPackageStore } from "./tool-provider-package-store.js";
import { createManagedToolProviderSourceFactory } from "./managed-tool-provider-source.js";
import { SqliteToolProviderRecoveryStateStore } from "./tool-provider-recovery-adapter.js";
import { SqliteExecutionToolDiscoveryStateStore } from "./tool-discovery-state-adapter.js";
import { ToolProviderRecoveryReconciler } from "./tool-provider-recovery-reconciler.js";
import { recoverToolRuntimeStartup } from "./tool-runtime-startup-recovery.js";
import { SqliteToolProviderDiagnosticStore } from "./tool-provider-diagnostic-adapter.js";
import { SqliteToolProviderSchedulingAuditStore } from "./tool-provider-scheduling-adapter.js";
import { ManagedExecutionCapacity, registerManagedExecutionCapacityRoutes } from "./managed-execution-capacity.js";
import type { ProcessExecutionCapacity } from "./process-execution-capacity.js";
import type { FoundationHostControl } from "./foundation-host-control.js";
import { ToolProviderGarbageCollector } from "./tool-provider-garbage-collector.js";
import {
  registerToolProviderArchiveImportRoutes,
  ToolProviderArchiveImportService,
  type ToolProviderArchiveImportAuthorizer,
} from "./tool-provider-archive-import.js";
import {
  registerToolProviderRefreshRoutes,
  ToolProviderRefreshControl,
  type ToolProviderRefreshAuthorizer,
} from "./tool-provider-refresh-control.js";
import {
  registerToolInvocationReconciliationRoutes,
  ToolInvocationReconciliationControl,
  type ToolInvocationReconciliationAuthorizer,
  type ToolInvocationReconciliationEvidenceVerifier,
} from "./tool-invocation-reconciliation.js";
import { SignedToolRecoveryEvidenceVerifier, type RecoveryEvidenceAuthority } from "./tool-recovery-evidence.js";
import { ToolExecutionRecoveryControl, registerToolExecutionRecoveryRoutes } from "./tool-execution-recovery.js";
import type { ScenarioWorkRetryControl } from "./scenario-work-retry.js";
import { SqliteWorkerCheckpointStore } from "./worker-checkpoint-store.js";
import type { ExtensionAssemblyControl } from "./extension-assembly.js";

export interface EmbeddedBrowserServices {
  sessions: DesktopBrowserSessions;
  allowsTool(definition: ScenarioDefinition, tool: import("@traceforge/worker-runtime").ExecutionToolSpec): boolean;
}

function serverBaseUrl(app: FastifyInstance): string {
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("Embedded workers require a TCP server address");
  return `http://127.0.0.1:${address.port}`;
}

function executorPlatform(): PermissionProfile["platform"] {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "darwin";
  return "linux";
}

export function desiredWorkerCount(pool: ScenarioWorkerPoolDefinition, runs: ScenarioRunState[]): number {
  const supportedWorkKinds = new Set(pool.workKinds);
  const demand = runs.reduce((count, run) => count + run.workItems.filter((work) =>
    supportedWorkKinds.has(work.kind) && ["queued", "running"].includes(work.status)).length, 0);
  if (demand === 0) return pool.activation === "resident" ? pool.minimumInstances : 0;
  return Math.min(pool.maximumInstances, Math.max(pool.minimumInstances, demand));
}

class EmbeddedScenarioWorkerPool {
  private readonly supervisors = new Map<string, { workerId: string; supervisor: WorkerSupervisor; pool: ScenarioWorkerPoolDefinition; revoke:()=>void }>();
  private reconcilePromise: Promise<void> | undefined;

  constructor(
    private readonly app: FastifyInstance,
    private readonly sqlite: Database.Database,
    private readonly provider: LlmProvider,
    private readonly projectRoot: string,
    private readonly cognitiveSnapshots: SqliteCognitiveSnapshotStore,
    private readonly modelRuntime: ModelExecutionRuntime,
    private readonly agentEvents: ScenarioAgentEventWriter,
    private readonly toolRuntime: ExecutionToolDiscoveryRuntime,
    private readonly definitions: ScenarioDefinitionRegistry,
    private readonly bindingValidator: ScenarioRunBindingValidator,
    private readonly invocationBindings: SqliteToolInvocationBindingStore,
    private readonly contextPolicy?: WorkerModelContextPolicy,
    private readonly compaction?: ContextCompactionPolicy,
    private readonly hostControl?: FoundationHostControl,
    private readonly authorization?: SqliteScenarioAuthorizationService,
    private readonly workspace?: RunWorkspace,
    private readonly plannerReady:()=>boolean=()=>false,
    private readonly workspaceJobs?: WorkspaceJobs,
    private readonly browser?: EmbeddedBrowserServices,
  ) {}

  reconcile(): Promise<void> {
    if (this.reconcilePromise) return this.reconcilePromise;
    this.reconcilePromise = this.reconcileOnce().finally(() => { this.reconcilePromise = undefined; });
    return this.reconcilePromise;
  }

  reconcileOwnership(runId: string): void {
    // Cancellation consumes durable ownership facts, never package code or a grant to execute.
    const run = readRunForensics(this.sqlite, runId);
    if (run) for (const managed of this.supervisors.values()) managed.supervisor.reconcileRun(run);
  }

  async stop(): Promise<void> {
    await this.reconcilePromise;
    const registry = new SqliteWorkerRegistry(this.sqlite);
    await Promise.all([...this.supervisors.values()].map(async (managed) => {
      managed.revoke();
      await managed.supervisor.stop();
      registry.setStatus(managed.workerId, "offline", new Date().toISOString());
    }));
    this.supervisors.clear();
  }

  private async reconcileOnce(): Promise<void> {
    const eventStore = new SqliteScenarioEventStore(this.sqlite);
    const runtime = new DurableScenarioRuntime(eventStore, this.definitions, this.bindingValidator);
    const runs: ScenarioRunState[] = [];
    for (const summary of eventStore.listRuns().filter((candidate) => candidate.status === "running")) {
      try {
        const run = runtime.load(summary.runId);
        if (run) runs.push(run);
      } catch (error) {
        this.app.log.warn({ runId: summary.runId, err: error }, "Skipping Scenario Run that requires Package recovery");
      }
    }
    for (const definition of this.definitions.list()) {
      const definitionRuns = runs.filter((run) => run.definitionKind === definition.kind && run.definitionVersion === definition.version);
      for (const pool of definition.agentTopology.workerPools) {
        await this.resize(definition, pool, desiredWorkerCount(pool, definitionRuns));
      }
    }
  }

  private async resize(definition: ScenarioDefinition, pool: ScenarioWorkerPoolDefinition, desired: number): Promise<void> {
    const poolKey = `${definition.kind}@${definition.version}:${pool.id}`;
    const current = [...this.supervisors.entries()]
      .filter(([key]) => key.startsWith(`${poolKey}:`))
      .sort(([left], [right]) => left.localeCompare(right));
    for (let index = current.length + 1; index <= desired; index += 1) {
      const workerId = `embedded-${definition.kind}-${pool.id}-${index}`.replace(/[^a-zA-Z0-9_-]/g, "-");
      const {supervisor,revoke} = this.createSupervisor(workerId, definition, pool);
      try { await supervisor.start(); }
      catch(error){revoke();await supervisor.stop();throw error;}
      this.supervisors.set(`${poolKey}:${workerId}`, { workerId, supervisor, pool, revoke });
    }
    if (current.length <= desired) return;
    const registry = new SqliteWorkerRegistry(this.sqlite);
    for (const [key, managed] of current.slice(desired).reverse()) {
      const active = this.sqlite.prepare("SELECT 1 FROM scenario_work_leases WHERE worker_id = ? LIMIT 1").get(managed.workerId);
      if (active) continue;
      managed.revoke();
      await managed.supervisor.stop();
      registry.setStatus(managed.workerId, "offline", new Date().toISOString());
      this.supervisors.delete(key);
    }
  }

  private createSupervisor(workerId: string, definition: ScenarioDefinition, pool: ScenarioWorkerPoolDefinition): {supervisor:WorkerSupervisor;revoke:()=>void} {
    const contextPolicy: WorkerModelContextPolicy = {
      prepare: async request => {
        const projection = this.contextPolicy ? await this.contextPolicy.prepare(request) : { request, manifest: {} };
        projection.request={...projection.request,plannerAvailable:definition.agentTopology.planner.enabled&&this.plannerReady()};
        const run = new SqliteScenarioEventStore(this.sqlite).loadState(request.assignment.runId);
        const current = run && this.authorization?.requireRun(run);
        if (current && current.scope.payload && typeof current.scope.payload === "object" && !Array.isArray(current.scope.payload)
          && "form" in current.package.authorizationPolicy && current.package.authorizationPolicy.form) {
          projection.request = { ...projection.request, permissionContext: {
            scope: current.scope.payload as Record<string, unknown>, form: current.package.authorizationPolicy.form, expiresAt: current.row.expires_at,
            allowedActions: [...current.scope.allowedActions], deniedActions: [...current.scope.deniedActions],
            capabilityAuthorization: (current.package.definition.toolPolicies ?? []).map(({ source, capability, authorizationAction }) => ({ source, capability, authorizationAction })),
          } };
        }
        return projection;
      },
      recordDecision: this.contextPolicy?.recordDecision?.bind(this.contextPolicy),
    };
    const model = new StructuredWorkerModel(this.provider, undefined, this.cognitiveSnapshots, undefined, this.modelRuntime, contextPolicy, this.compaction);
    const receipts = new SqliteToolReceiptStore(this.sqlite);
    const worker: WorkerDescriptor = {
      id: workerId,
      roles: [pool.role],
      capabilities: pool.capabilities,
      maxConcurrentWork: pool.maxConcurrentWork,
      status: "online",
      heartbeatAt: new Date().toISOString(),
    };
    if(!this.hostControl)throw new Error("Embedded Workers require host-scoped control channels");
    const channel=this.hostControl.worker(worker,definition.kind,definition.version);
    const control=new HttpWorkerControlPlaneClient(serverBaseUrl(this.app),channel.fetch);
    const approvalPreference = new DesktopApprovalPreference(this.sqlite);
    const toolPolicy = new RunToolPolicy(definition, this.authorization, this.workspace, executorPlatform(),
      () => approvalPreference.read().routineApprovalRequired, tool => this.browser?.allowsTool(definition, tool) === true);
    const gateway = new PolicyExecutionToolGateway(
      this.toolRuntime.registry,
      { async authorize(input) { return toolPolicy.approval(input.assignment, input.tool) ?? { decision: "pending", approvalRef: `approval:${input.invocation.id}` }; } },
      receipts,
      {
        allowedRisks: ["read_only", "bounded_write", "privileged", "destructive"],
        requiresApproval: ({ assignment, tool }) => toolPolicy.requiresApproval(assignment, tool),
        approvalPolicyRef: () => `desktop-approval:${approvalPreference.read().revision}`,
        assertAuthorized: ({assignment,worker}) => {
          if(!this.authorization)return;
          const state=new DurableScenarioRuntime(new SqliteScenarioEventStore(this.sqlite),this.definitions,this.bindingValidator).load(assignment.runId);
          const work=state?.workItems.find(w=>w.id===assignment.work.id);
          if(!state || state.status!=="running" || state.caseId!==assignment.runContext.caseId || state.scopeRef!==assignment.runContext.scopeRef
            || work?.status!=="running" || work.workerId!==worker.id || work.leaseId!==assignment.leaseId
            || !work.leaseExpiresAt || !(Date.parse(work.leaseExpiresAt)>Date.now()))throw new Error("Tool dispatch requires current Work ownership");
          this.authorization.requireRun(state);
        },
        permissionLayers: ({ assignment, tool }) => toolPolicy.layers(assignment, tool),
      },
      this.toolRuntime,
      this.invocationBindings,
    );
    const runtime = new WorkerHost(
      worker,
      control,
      model,
      gateway,
      new LoopGuardObserver(),
      new SqliteWorkerCheckpointStore(this.sqlite, new JsonFileCheckpointStore(resolve(this.projectRoot, "data", "worker-checkpoints"),
        resolve(this.projectRoot, "data", "worker-checkpoints", worker.id))),
      new BoundedOutputDistiller(),
      {
        repeatableReadCapabilities: ["workspace.poll"],
        executionHoldReason: assignment => this.browser?.sessions.manualControlPending(assignment.runId, assignment.work.id)
          ? "User is controlling an owned browser; wait for handback without another model call." : undefined,
        completionBlockReason: assignment => this.workspaceJobs?.pending(assignment.runId, assignment.work.id)
          ? "An owned script is unfinished or uncertain. Poll its handle and confirm its terminal result before completing this Work; unknown execution requires reconciliation." : undefined,
        longTaskPolicy: assignment => {
          if (!this.authorization) return undefined;
          let grant;
          try { grant = this.authorization.requireAction(assignment.runContext.scopeRef, assignment.runContext.caseId, "scope.read"); }
          catch { return undefined; } // Existing Scenarios need not declare this optional capability.
          const payload = grant.scopePayload as Record<string, unknown>;
          if (payload?.continuousExecution !== true) return undefined;
          const turns = payload.maximumWorkTurns, minutes = payload.maximumWorkMinutes;
          if (turns !== undefined && (typeof turns !== "number" || !Number.isSafeInteger(turns)) || minutes !== undefined && (typeof minutes !== "number" || !Number.isSafeInteger(minutes))) throw new Error("Invalid long task authorization budgets");
          return { segmentTurns: 24, ...(typeof turns === "number" ? { maximumTurns: turns } : {}), ...(typeof minutes === "number" ? { maximumDurationMs: minutes * 60000 } : {}) };
        },
        onLifecycleEvent: (event) => {
          if (event.type === "turn_progress") {
            this.agentEvents.append({
              method: "turn/progress", runId: event.assignment.runId, caseId: event.assignment.runContext.caseId,
              workId: event.assignment.work.id, turnId: event.turnId, role: "worker",
              params: { phase: event.phase, summary: event.summary, refs: event.refs },
            });
            return;
          }
          if (event.type === "turn_completed") {
            this.agentEvents.append({
              method: "turn/completed", runId: event.assignment.runId, caseId: event.assignment.runContext.caseId,
              workId: event.assignment.work.id, turnId: event.turnId, role: "worker",
              params: { status: event.status, outcome: event.outcome, checkpointRef: event.checkpointRef, error: event.error },
            });
            return;
          }
          const item = {
            type: "toolCall" as const,
            id: event.invocationId,
            tool: event.tool,
            status: event.type === "tool_started" || event.type === "tool_progress" ? "inProgress" as const : event.status,
            risk: event.risk,
            summary: event.type === "tool_completed" ? executionDisplay(event.summary, 4000).text : null,
            refs: event.type === "tool_completed" ? [...new Set([...event.refs,
              ...desktopToolReceiptReference(this.sqlite, event.assignment.runContext.caseId, event.assignment.runId,
                `${event.assignment.work.idempotencyKey}:${event.invocationId}`)])] : [],
            ...(event.type === "tool_started" ? { inputPreview: executionDisplay(event.input).text, rationale: executionDisplay(event.rationale ?? "", 2000).text, dispatchState: "requested" as const } : {
              outputPreview: executionDisplay(event.output ?? "", 12000).text,
              ...(event.type === "tool_progress" && event.command ? { commandPreview: executionDisplay(event.command).text } : {}),
              previewTruncated: executionDisplay(event.output ?? "", 12000).truncated,
              dispatchState: event.type === "tool_progress" ? "dispatched" as const : event.replayed ? "replayed" as const : event.status === "waitingApproval" ? "requested" as const : "returned" as const,
            }),
          };
          this.agentEvents.append({
            method: event.type === "tool_started" ? "item/started" : event.type === "tool_progress" ? "item/updated" : "item/completed",
            runId: event.assignment.runId,
            caseId: event.assignment.runContext.caseId,
            workId: event.assignment.work.id,
            turnId: event.turnId,
            role: "worker",
            params: { item },
          });
        },
      },
    );
    return {revoke:channel.revoke,supervisor:new WorkerSupervisor(runtime, {
      pollIntervalMs: 1_000,
      errorBackoffMs: 5_000,
      onEvent: (event) => {
        if (event.type === "poll_failed") this.app.log.error({ workerId: worker.id, error: event.error }, "Embedded worker poll failed");
        if (event.type === "work_finished") this.app.log.info({ workerId: worker.id, result: event.result }, "Embedded worker finished work");
      },
    })};
  }
}

export function registerEmbeddedWorkers(
  app: FastifyInstance,
  sqlite: Database.Database,
  provider: LlmProvider,
  projectRoot: string,
  providerReady: () => boolean,
  evidenceGraph: SqliteEvidenceGraphStore,
  changes: BlackboardChangeBus,
  cognitiveSnapshots: SqliteCognitiveSnapshotStore,
  modelRuntime: ModelExecutionRuntime,
  agentEvents: ScenarioAgentEventWriter,
  definitions: ScenarioDefinitionRegistry,
  bindingValidator: ScenarioRunBindingValidator,
  executionNode?: ExecutionNode,
  scenarioToolSources: readonly ExecutionToolDiscoverySource[] = [],
  externalToolSources: readonly ExecutionToolDiscoverySource[] = [],
  toolProviderTrustRoots: ReadonlyMap<string, string> = new Map(),
  toolProviderSourceFactory?: (installation: ToolProviderInstallation) => Promise<ExecutionToolDiscoverySource> | ExecutionToolDiscoverySource,
  providerCapabilityHost?: ProviderCapabilityHost,
  toolProviderArchiveImportAuthorizer?: ToolProviderArchiveImportAuthorizer,
  toolProviderRefreshAuthorizer?: ToolProviderRefreshAuthorizer,
  toolInvocationReconciliationAuthorizer?: ToolInvocationReconciliationAuthorizer,
  toolInvocationReconciliationEvidenceVerifier?: ToolInvocationReconciliationEvidenceVerifier,
  workRetry?: ScenarioWorkRetryControl,
  recoveryAuthority?: (keyId: string) => RecoveryEvidenceAuthority | undefined,
  contextPolicy?: WorkerModelContextPolicy,
  compaction?: ContextCompactionPolicy,
  processCapacity?: ProcessExecutionCapacity,
  hostControl?: FoundationHostControl,
  authorization?: SqliteScenarioAuthorizationService,
  extensionAssembly?: ExtensionAssemblyControl,
  onToolRuntime?: (runtime: ExecutionToolDiscoveryRuntime) => void,
  workspaceProject?: (context: ToolExecutionContext, id: string) => Promise<WorkspaceProject>,
  browser?: EmbeddedBrowserServices,
): () => ReturnType<ExecutionToolDiscoveryRuntime["snapshot"]> {
  let workspaceJobs: WorkspaceJobs | undefined;
  const conversationWorkspaces = new ConversationWorkspaces(sqlite,projectRoot);
  const workspaceProcess = executionNode ? new ExecutionNodeProcessTool(executionNode, processCapacity, undefined, undefined, {
    started: (context, access) => workspaceJobs?.started(context, access), output: (context, text) => workspaceJobs?.output(context, text),
  }) : undefined;
  const workspace = executionNode && authorization ? new RunWorkspace(resolve(projectRoot, "data", "run-workspaces"),
    { ...workspaceProcess!, execute: async (input, context) => {
      const result = await workspaceProcess!.execute(input, context);
      const networkReceipts = readWorkspaceNetworkReceipts(sqlite, context);
      return networkReceipts.length ? { ...result, metadata: { ...result.metadata, networkReceipts } } : result;
    } }, (context, action) => {
      const state = new DurableScenarioRuntime(new SqliteScenarioEventStore(sqlite), definitions, bindingValidator).load(context.runId);
      const work = state?.workItems.find(item => item.id === context.workId);
      if (!state || state.status !== "running" || state.caseId !== context.caseId || state.scopeRef !== context.scopeRef
        || work?.status !== "running" || work.workerId !== context.workerId || work.leaseId !== context.leaseId
        || !work.leaseExpiresAt || Date.parse(work.leaseExpiresAt) <= Date.now()) throw new Error("Workspace requires current Work ownership");
      authorization.requireRun(state);
      authorization.requireAction(context.scopeRef, context.caseId, action);
    }, async () => {
      await executionNode.handshake({ clientId: "run-workspace", protocol: EXECUTION_PROTOCOL_VERSION, requiredCapabilities: ["process.spawn", "process.stdio"] });
    }, workspaceProject, context => workspaceExecutionSeconds(authorization.requireAction(context.scopeRef, context.caseId, "workspace.execute").scopePayload),
    (caseId,runId) => conversationWorkspaces.key(caseId,runId)) : undefined;
  if (workspace && executionNode && authorization) workspaceJobs = new WorkspaceJobs(sqlite, workspace, (context, start) => {
    const state = new DurableScenarioRuntime(new SqliteScenarioEventStore(sqlite), definitions, bindingValidator).load(context.runId);
    const work = state?.workItems.find(item => item.id === context.workId);
    if (!state || state.status !== "running" || state.scopeRef !== context.scopeRef || state.caseId !== context.caseId
      || work?.status !== "running" || work.leaseId !== context.leaseId || work.workerId !== context.workerId
      || !work.leaseExpiresAt || Date.parse(work.leaseExpiresAt) <= Date.now()) throw new Error("Script ownership is no longer active");
    authorization.requireRun(state);
    const grant = authorization.requireAction(context.scopeRef, context.caseId, "workspace.execute");
    if (start && (grant.scopePayload as Record<string, unknown>)?.asynchronousWorkspace !== true) throw new Error("Asynchronous script execution requires explicit consent");
  }, access => executionNode.terminateProcess({ ...access, operationId: `workspace-stop:${access.processId}`, force: true }),
    (key, handle) => {
      try {
        if (!sqlite.prepare("SELECT 1 FROM tool_invocation_executions WHERE idempotency_key=? AND status='completed'").get(key)) return false;
        const row = readExecutionRow<{ result_json: string }>(sqlite, "receipt", key);
        if (!row) return false;
        const receipt = JSON.parse(row.result_json), view = JSON.parse(receipt.raw);
        return receipt.status === "succeeded" && view.handle === handle && view.hasMoreOutput === false && !!view.terminalResult;
      } catch { return false; }
    }, async (access, context, input) => {
      const operationId = `workspace-input:${context.idempotencyKey}`;
      if (input.interrupt) await executionNode.signalProcess({ ...access, operationId, signal: "interrupt" });
      else if (input.columns !== undefined) await executionNode.resizeProcessTerminal({ ...access, operationId, columns: input.columns, rows: input.rows! });
      else await executionNode.writeProcessInput({ ...access, operationId, dataBase64: Buffer.from(input.text ?? "").toString("base64"), closeAfterWrite: input.eof === true });
    }, (context, view) => {
      const output = executionDisplay(view.output, 12000);
      agentEvents.append({
        method: view.terminal ? "item/completed" : "item/updated",
        caseId: context.caseId, runId: context.runId, workId: context.workId,
        turnId: `workspace-process:${view.handle}`, role: "worker",
        params: { item: {
          type: "toolCall", id: view.handle, tool: "workspace process", risk: "privileged",
          status: view.terminal ? view.terminal.status === "succeeded" ? "completed" : "failed" : "inProgress",
          commandPreview: executionDisplay(view.command).text, outputPreview: output.text,
          previewTruncated: output.truncated, dispatchState: view.terminal ? "returned" : "dispatched",
          summary: view.terminal ? executionDisplay(view.terminal.summary, 4000).text : null,
          refs: view.terminal?.refs ?? [],
        } },
      });
    });
  const builtinTools: ExecutionToolAdapter[] = [
    new EvidenceGraphSnapshotTool(evidenceGraph),
    new EvidenceGraphMutateTool(sqlite, evidenceGraph),
    ...(executionNode ? [new ExecutionNodeProcessTool(executionNode,processCapacity)] : []),
    ...(workspace?.tools() ?? []),
    ...(workspaceJobs?.tools() ?? []),
  ];
  const toolRuntime = new ExecutionToolDiscoveryRuntime([
    { source: "traceforge.builtin", async discover() { return builtinTools; } },
    ...scenarioToolSources,
    ...externalToolSources,
  ], 30_000, 3, () => new Date(), new SqliteExecutionToolDiscoveryStateStore(sqlite));
  onToolRuntime?.(toolRuntime);
  let startupState: "not_started" | "starting" | "ready" | "failed" | "stopping" | "stopped" = "not_started";
  registerExecutionToolRuntimeRoutes(app, toolRuntime, () => startupState);
  const providerRecoveryState = new SqliteToolProviderRecoveryStateStore(sqlite);
  const providerDiagnostics = new SqliteToolProviderDiagnosticStore(sqlite);
  const providerScheduler = processCapacity?.scheduler ?? new ToolProviderFairScheduler({}, new SqliteToolProviderSchedulingAuditStore(sqlite));
  const invocationBindings = new SqliteToolInvocationBindingStore(sqlite);
  const invocationRecovery = invocationBindings.recoverInterrupted();
  const executionCapacity = new ManagedExecutionCapacity(sqlite,providerScheduler,invocationBindings);
  processCapacity?.restoreLegacy();
  if (invocationRecovery.completed || invocationRecovery.uncertain) {
    app.log.info({ invocationRecovery }, "Tool Invocation startup reconciliation completed");
  }
  const reconciliationAuthorizer = toolInvocationReconciliationAuthorizer ?? {
    async authorize() { return { decision: "denied" as const, reason: "No Tool Invocation reconciliation authorizer is configured" }; },
  };
  const reconciliationVerifier = toolInvocationReconciliationEvidenceVerifier ?? new SignedToolRecoveryEvidenceVerifier(sqlite, recoveryAuthority ?? (() => undefined));
  registerManagedExecutionCapacityRoutes(app,executionCapacity,reconciliationAuthorizer,reconciliationVerifier);
  const reconcileCapacity=()=>{try{executionCapacity.reconcile();}catch(error){app.log.warn({error},"External execution occupancy remains fenced");}};
  reconcileCapacity();
  const capacityTimer=setInterval(reconcileCapacity,1000);capacityTimer.unref();
  const invocationReconciliation = new ToolInvocationReconciliationControl(
    sqlite,
    invocationBindings,
    reconciliationAuthorizer,
    reconciliationVerifier,
  );
  registerToolInvocationReconciliationRoutes(app, invocationReconciliation);
  if (workRetry) registerToolExecutionRecoveryRoutes(app, new ToolExecutionRecoveryControl(sqlite, invocationBindings, invocationReconciliation, workRetry));
  let projectRecoveryQuarantine = (_snapshot: ToolProviderRecoverySnapshot) => undefined;
  const managedSourceFactory = toolProviderSourceFactory
    ?? (executionNode ? createManagedToolProviderSourceFactory(
      executionNode,
      resolve(projectRoot, "data/tool-providers/work"),
      providerCapabilityHost,
      {
        state: providerRecoveryState,
        diagnostics: providerDiagnostics,
        scheduler: providerScheduler,
        capacity: executionCapacity,
        onQuarantined: (snapshot) => { projectRecoveryQuarantine(snapshot); },
      },
    ) : undefined);
  const providerControlStore = new SqliteToolProviderControlStore(sqlite);
  extensionAssembly?.attachManagedProviderInventory(() => providerControlStore.list());
  const providerPackageStore = new ManagedToolProviderPackageStore(resolve(projectRoot, "data/tool-providers/packages"));
  const providerWorkRoot = resolve(projectRoot, "data/tool-providers/work");
  const providerControl = new ToolProviderControlPlane(
    providerControlStore,
    toolProviderTrustRoots,
    createToolProviderRuntimeBinding(
      (source) => toolRuntime.activateSource(source),
      (source) => toolRuntime.deactivateSource(source),
      (source) => { toolRuntime.drainSource(source); },
      managedSourceFactory,
    ),
    providerPackageStore,
    () => new Date().toISOString(),
    invocationBindings,
    () => extensionAssembly?.reconcileManagedProviders(providerControlStore.list()),
  );
  const providerGarbageCollector = new ToolProviderGarbageCollector(
    sqlite, providerControlStore, providerPackageStore, providerWorkRoot, () => toolRuntime.snapshot(),
  );
  projectRecoveryQuarantine = (snapshot) => {
    queueMicrotask(() => {
      void providerControl.quarantine(
        snapshot.identity.providerId,
        snapshot.identity.version,
        snapshot.quarantineReason ?? "Provider recovery failure budget exhausted",
        "provider-recovery-supervisor",
        `provider-recovery:${snapshot.identity.providerId}:${snapshot.identity.version}:${snapshot.revision}`,
      ).catch((error) => app.log.error({ err: error, provider: snapshot.identity }, "Tool Provider quarantine projection failed"));
    });
  };
  const providerRecoveryReconciler = new ToolProviderRecoveryReconciler(providerRecoveryState, providerControl);
  registerToolProviderControlRoutes(app, providerControl);
  const providerArchiveImports = new ToolProviderArchiveImportService(
    sqlite,
    providerControl,
    providerControlStore,
    toolProviderTrustRoots,
    resolve(projectRoot, "data/tool-providers/imports"),
    toolProviderArchiveImportAuthorizer ?? {
      async authorize() { return { decision: "denied", reason: "No Tool Provider archive import authorizer is configured" }; },
    },
  );
  const archiveRecovery = providerArchiveImports.recoverInterrupted();
  if (archiveRecovery.installed || archiveRecovery.rejected || archiveRecovery.orphaned || archiveRecovery.cleanupFailures) {
    app.log.info({ report: archiveRecovery }, "Tool Provider archive import recovery completed");
  }
  registerToolProviderArchiveImportRoutes(app, providerArchiveImports);
  const providerRefresh = new ToolProviderRefreshControl(
    sqlite,
    providerControl,
    toolRuntime,
    toolProviderRefreshAuthorizer ?? {
      async authorize() { return { decision: "denied", reason: "No Tool Provider refresh authorizer is configured" }; },
    },
  );
  const interruptedRefreshes = providerRefresh.recoverInterrupted();
  if (interruptedRefreshes) app.log.info({ interruptedRefreshes }, "Tool Provider refresh recovery completed");
  registerToolProviderRefreshRoutes(app, providerRefresh);
  const pool = new EmbeddedScenarioWorkerPool(
    app, sqlite, provider, projectRoot, cognitiveSnapshots, modelRuntime, agentEvents, toolRuntime, definitions, bindingValidator,
    invocationBindings, contextPolicy, compaction,hostControl,authorization,workspace,providerReady,workspaceJobs,browser,
  );
  let listening = false;
  let startup: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let lastGarbageCollectionAt = 0;
  const reconcile = () => {
    if (!listening || startupState !== "ready" || !providerReady()) return;
    pool.reconcile().catch((error) => app.log.error({ err: error }, "Embedded Worker pool reconciliation failed"));
  };
  const maintainProviderDiagnostics = () => {
    if (!listening) return;
    try {
      const report = providerDiagnostics.cleanup(new Date().toISOString(), "scheduled");
      if (report.purgedRecords || !report.capacitySatisfied) {
        app.log.info({ report }, "Tool Provider diagnostic retention maintenance completed");
      }
    } catch (error) {
      app.log.error({ err: error }, "Tool Provider diagnostic retention maintenance failed");
    }
  };
  const collectProviderGarbage = (force = false) => {
    if (!listening) return;
    const current = Date.now();
    if (!force && current - lastGarbageCollectionAt < 60 * 60 * 1_000) return;
    lastGarbageCollectionAt = current;
    try {
      const report = providerGarbageCollector.collect({ dryRun: false });
      if (report.deleted || report.failures) app.log.info({ report }, "Tool Provider garbage collection completed");
    } catch (error) {
      app.log.error({ err: error }, "Tool Provider garbage collection failed");
    }
  };
  const unsubscribeChanges = changes.subscribe((change) => {
    if (change.kind === "run") pool.reconcileOwnership(change.runId);
    reconcile();
  });
  app.addHook("onListen", () => {
    listening = true;
    startupState = "starting";
    startup = recoverToolRuntimeStartup(toolRuntime, providerRecoveryReconciler, providerControl)
      .then((report) => {
        if (!listening) return;
        if (report.reconciliation.projectedToControl.length || report.reconciliation.projectedToRecovery.length) {
          app.log.info({ report: report.reconciliation }, "Tool Provider recovery quarantine reconciliation completed");
        }
        if (report.providers.enabled.length || report.providers.failed.length) {
          app.log.info({ report: report.providers }, "Tool Provider startup recovery completed");
        }
        collectProviderGarbage(true);
        startupState = "ready";
        reconcile();
      })
      .catch((error) => {
        if (listening) startupState = "failed";
        app.log.error({ err: error }, "Tool runtime startup recovery failed");
      });
    timer = setInterval(() => {
      reconcile();
      maintainProviderDiagnostics();
      collectProviderGarbage();
    }, 30_000);
    timer.unref();
  });
  app.addHook("onClose", async () => {
    listening = false;
    startupState = "stopping";
    unsubscribeChanges();
    if (timer) clearInterval(timer);
    clearInterval(capacityTimer);
    // Do not let a late startup activation recreate a Provider after the runtime was closed.
    await startup;
    await pool.stop();
    await workspaceJobs?.close();
    await toolRuntime.close();
    startupState = "stopped";
  });
  return () => toolRuntime.snapshot();
}
import { readWorkspaceNetworkReceipts } from "./workspace-network-host.js";
import { WorkspaceJobs } from "./workspace-jobs.js";
import { readExecutionRow } from "./db/execution-archive.js";
