import { resolve } from "node:path";
import { readRunForensics } from "./scenario-run-disposal.js";
import type Database from "better-sqlite3";
import type { SqliteScenarioAuthorizationService } from "./scenario-authorization.js";
import type { ContextCompactionPolicy } from "@traceforge/cognitive-runtime";
import type { FastifyInstance } from "fastify";
import type { LlmProvider } from "@traceforge/llm";
import type { ExecutionNode } from "@traceforge/execution-node";
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
  LeaseWorkerRuntime,
  LoopGuardObserver,
  PolicyExecutionToolGateway,
  ToolProviderFairScheduler,
  WorkerSupervisor,
  type ExecutionToolAdapter,
  type ExecutionToolDiscoverySource,
  type ProviderCapabilityHost,
  type ToolProviderRecoverySnapshot,
  type WorkerModelContextPolicy,
} from "@traceforge/worker-runtime";
import { StructuredWorkerModel } from "./structured-worker-model.js";
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
    const model = new StructuredWorkerModel(this.provider, undefined, this.cognitiveSnapshots, undefined, this.modelRuntime, this.contextPolicy, this.compaction);
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
    const gateway = new PolicyExecutionToolGateway(
      this.toolRuntime.registry,
      { async authorize(input) { return { decision: "pending", approvalRef: `approval:${input.invocation.id}` }; } },
      receipts,
      {
        allowedRisks: ["read_only", "bounded_write", "privileged", "destructive"],
        assertAuthorized: ({assignment,worker}) => {
          if(!this.authorization)return;
          const state=new DurableScenarioRuntime(new SqliteScenarioEventStore(this.sqlite),this.definitions,this.bindingValidator).load(assignment.runId);
          const work=state?.workItems.find(w=>w.id===assignment.work.id);
          if(!state || state.status!=="running" || state.caseId!==assignment.runContext.caseId || state.scopeRef!==assignment.runContext.scopeRef
            || work?.status!=="running" || work.workerId!==worker.id || work.leaseId!==assignment.leaseId
            || !work.leaseExpiresAt || !(Date.parse(work.leaseExpiresAt)>Date.now()))throw new Error("Tool dispatch requires current Work ownership");
          this.authorization.requireRun(state);
        },
        permissionLayers: () => {
          const platform = executorPlatform();
          return [
            {
              source: "platform",
              profile: {
                version: 1,
                platform,
                filesystem: {
                  read: [{ path: this.projectRoot, scope: "tree" }],
                  write: [{ path: this.projectRoot, scope: "tree" }],
                  deny: [],
                },
                network: "brokered",
                process: { access: "sandboxed", interactive: false, background: false },
                secrets: "plaintext",
              },
            },
            {
              source: `scenario:${definition.kind}@${definition.version}`,
              profile: {
                version: 1,
                platform,
                filesystem: { read: [], write: [], deny: [] },
                network: "brokered",
                process: { access: "deny", interactive: false, background: false },
                secrets: "handles_only",
              },
            },
          ];
        },
      },
      this.toolRuntime,
      this.invocationBindings,
    );
    const runtime = new LeaseWorkerRuntime(
      worker,
      control,
      model,
      gateway,
      new LoopGuardObserver(),
      new SqliteWorkerCheckpointStore(this.sqlite, new JsonFileCheckpointStore(resolve(this.projectRoot, "data", "worker-checkpoints"),
        resolve(this.projectRoot, "data", "worker-checkpoints", worker.id))),
      new BoundedOutputDistiller(),
      {
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
            status: event.type === "tool_started" ? "inProgress" as const : event.status,
            risk: event.risk,
            summary: event.type === "tool_started" ? null : event.summary,
            refs: event.type === "tool_started" ? [] : event.refs,
          };
          this.agentEvents.append({
            method: event.type === "tool_started" ? "item/started" : "item/completed",
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
): void {
  const builtinTools: ExecutionToolAdapter[] = [
    new EvidenceGraphSnapshotTool(evidenceGraph),
    new EvidenceGraphMutateTool(sqlite, evidenceGraph),
    ...(executionNode ? [new ExecutionNodeProcessTool(executionNode,processCapacity)] : []),
  ];
  const toolRuntime = new ExecutionToolDiscoveryRuntime([
    { source: "traceforge.builtin", async discover() { return builtinTools; } },
    ...scenarioToolSources,
    ...externalToolSources,
  ], 30_000, 3, () => new Date(), new SqliteExecutionToolDiscoveryStateStore(sqlite));
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
    invocationBindings, contextPolicy, compaction,hostControl,authorization,
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
    await toolRuntime.close();
    startupState = "stopped";
  });
}
