import { resolve } from "node:path";
import type Database from "better-sqlite3";
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
import { ToolProviderGarbageCollector } from "./tool-provider-garbage-collector.js";
import {
  registerToolProviderArchiveImportRoutes,
  ToolProviderArchiveImportService,
  type ToolProviderArchiveImportAuthorizer,
} from "./tool-provider-archive-import.js";

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
  private readonly supervisors = new Map<string, { workerId: string; supervisor: WorkerSupervisor; pool: ScenarioWorkerPoolDefinition }>();
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
  ) {}

  reconcile(): Promise<void> {
    if (this.reconcilePromise) return this.reconcilePromise;
    this.reconcilePromise = this.reconcileOnce().finally(() => { this.reconcilePromise = undefined; });
    return this.reconcilePromise;
  }

  async stop(): Promise<void> {
    await this.reconcilePromise;
    const registry = new SqliteWorkerRegistry(this.sqlite);
    await Promise.all([...this.supervisors.values()].map(async (managed) => {
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
      const supervisor = this.createSupervisor(workerId, definition, pool);
      await supervisor.start();
      this.supervisors.set(`${poolKey}:${workerId}`, { workerId, supervisor, pool });
    }
    if (current.length <= desired) return;
    const registry = new SqliteWorkerRegistry(this.sqlite);
    for (const [key, managed] of current.slice(desired).reverse()) {
      const active = this.sqlite.prepare("SELECT 1 FROM scenario_work_leases WHERE worker_id = ? LIMIT 1").get(managed.workerId);
      if (active) continue;
      await managed.supervisor.stop();
      registry.setStatus(managed.workerId, "offline", new Date().toISOString());
      this.supervisors.delete(key);
    }
  }

  private createSupervisor(workerId: string, definition: ScenarioDefinition, pool: ScenarioWorkerPoolDefinition): WorkerSupervisor {
    const control = new HttpWorkerControlPlaneClient(serverBaseUrl(this.app));
    const model = new StructuredWorkerModel(this.provider, undefined, this.cognitiveSnapshots, undefined, this.modelRuntime);
    const receipts = new SqliteToolReceiptStore(this.sqlite);
    const worker: WorkerDescriptor = {
      id: workerId,
      roles: [pool.role],
      capabilities: pool.capabilities,
      maxConcurrentWork: pool.maxConcurrentWork,
      status: "online",
      heartbeatAt: new Date().toISOString(),
    };
    const gateway = new PolicyExecutionToolGateway(
      this.toolRuntime.registry,
      { async authorize(input) { return { decision: "pending", approvalRef: `approval:${input.invocation.id}` }; } },
      receipts,
      {
        allowedRisks: ["read_only", "bounded_write", "privileged", "destructive"],
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
      new JsonFileCheckpointStore(resolve(this.projectRoot, "data", "worker-checkpoints", worker.id)),
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
    return new WorkerSupervisor(runtime, {
      pollIntervalMs: 1_000,
      errorBackoffMs: 5_000,
      onEvent: (event) => {
        if (event.type === "poll_failed") this.app.log.error({ workerId: worker.id, error: event.error }, "Embedded worker poll failed");
        if (event.type === "work_finished") this.app.log.info({ workerId: worker.id, result: event.result }, "Embedded worker finished work");
      },
    });
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
): void {
  const builtinTools: ExecutionToolAdapter[] = [
    new EvidenceGraphSnapshotTool(evidenceGraph),
    new EvidenceGraphMutateTool(sqlite, evidenceGraph),
    ...(executionNode ? [new ExecutionNodeProcessTool(executionNode)] : []),
  ];
  const toolRuntime = new ExecutionToolDiscoveryRuntime([
    { source: "traceforge.builtin", async discover() { return builtinTools; } },
    ...scenarioToolSources,
    ...externalToolSources,
  ], 30_000, 3, () => new Date(), new SqliteExecutionToolDiscoveryStateStore(sqlite));
  registerExecutionToolRuntimeRoutes(app, toolRuntime);
  const providerRecoveryState = new SqliteToolProviderRecoveryStateStore(sqlite);
  const providerDiagnostics = new SqliteToolProviderDiagnosticStore(sqlite);
  const providerScheduler = new ToolProviderFairScheduler({}, new SqliteToolProviderSchedulingAuditStore(sqlite));
  const invocationBindings = new SqliteToolInvocationBindingStore(sqlite);
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
  const pool = new EmbeddedScenarioWorkerPool(
    app, sqlite, provider, projectRoot, cognitiveSnapshots, modelRuntime, agentEvents, toolRuntime, definitions, bindingValidator,
    invocationBindings,
  );
  let listening = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let lastGarbageCollectionAt = 0;
  const reconcile = () => {
    if (!listening || !providerReady()) return;
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
  const unsubscribeChanges = changes.subscribe(() => { reconcile(); });
  app.addHook("onListen", () => {
    listening = true;
    void recoverToolRuntimeStartup(toolRuntime, providerRecoveryReconciler, providerControl)
      .then((report) => {
        if (report.reconciliation.projectedToControl.length || report.reconciliation.projectedToRecovery.length) {
          app.log.info({ report: report.reconciliation }, "Tool Provider recovery quarantine reconciliation completed");
        }
        if (report.providers.enabled.length || report.providers.failed.length) {
          app.log.info({ report: report.providers }, "Tool Provider startup recovery completed");
        }
        collectProviderGarbage(true);
      })
      .catch((error) => app.log.error({ err: error }, "Tool runtime startup recovery failed"));
    reconcile();
    timer = setInterval(() => {
      reconcile();
      maintainProviderDiagnostics();
      collectProviderGarbage();
    }, 30_000);
    timer.unref();
  });
  app.addHook("onClose", async () => {
    listening = false;
    unsubscribeChanges();
    if (timer) clearInterval(timer);
    await pool.stop();
    await toolRuntime.close();
  });
}
