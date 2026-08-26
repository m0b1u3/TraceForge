import { resolve } from "node:path";
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import type { LlmProvider } from "@traceforge/llm";
import type { ExecutionNode } from "@traceforge/execution-node";
import {
  DurableScenarioRuntime,
  ScenarioDefinitionRegistry,
  WEB_BLACKBOX_SCENARIO,
  type ExecutionWorkerRole,
  type PermissionProfile,
  type ScenarioRunState,
  type ScenarioWorkerPoolDefinition,
  type WorkerDescriptor,
} from "@traceforge/orchestration-core";
import {
  BoundedOutputDistiller,
  HttpWorkerControlPlaneClient,
  JsonFileCheckpointStore,
  LeaseWorkerRuntime,
  LoopGuardObserver,
  PolicyExecutionToolGateway,
  WorkerSupervisor,
  type ExecutionToolAdapter,
} from "@traceforge/worker-runtime";
import { StructuredWorkerModel } from "./structured-worker-model.js";
import { ExecutionNodeProcessTool, SqliteToolReceiptStore } from "./worker-execution-adapters.js";
import {
  ScenarioAuthorizationGuard,
  ScenarioBrowserObserveTool,
  ScenarioHttpRequestTool,
  ScenarioSessionOpenTool,
  ScenarioScopeSnapshotTool,
  ScenarioTrafficSnapshotTool,
} from "./scenario-web-tools.js";
import type { ExecutionSessionGateway } from "./execution-session-gateway.js";
import { EvidenceGraphMutateTool, EvidenceGraphSnapshotTool } from "./evidence-graph-tools.js";
import type { SqliteEvidenceGraphStore } from "./evidence-graph-store.js";
import { SqliteScenarioEventStore, SqliteWorkerRegistry } from "./scenario-event-store.js";
import type { BlackboardChangeBus } from "./blackboard-change-bus.js";
import type { SqliteCognitiveSnapshotStore } from "./cognitive-context-snapshots.js";
import type { ModelExecutionRuntime } from "./model-execution-runtime.js";
import type { ScenarioAgentEventWriter } from "./scenario-agent-event-stream.js";

function serverBaseUrl(app: FastifyInstance): string {
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("Embedded workers require a TCP server address");
  return `http://127.0.0.1:${address.port}`;
}

const workKindByRole: Record<ExecutionWorkerRole, ScenarioRunState["workItems"][number]["kind"]> = {
  researcher: "research",
  validator: "validation",
  reviewer: "review",
  reporter: "report",
};

function executorPlatform(): PermissionProfile["platform"] {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "darwin";
  return "linux";
}

export function desiredWorkerCount(pool: ScenarioWorkerPoolDefinition, runs: ScenarioRunState[]): number {
  const kind = workKindByRole[pool.role];
  const demand = runs.reduce((count, run) => count + run.workItems.filter((work) =>
    work.kind === kind && ["queued", "running"].includes(work.status)).length, 0);
  if (demand === 0) return pool.activation === "resident" ? pool.minimumInstances : 0;
  return Math.min(pool.maximumInstances, Math.max(pool.minimumInstances, demand));
}

class EmbeddedScenarioWorkerPool {
  private readonly supervisors = new Map<string, { supervisor: WorkerSupervisor; pool: ScenarioWorkerPoolDefinition }>();
  private reconcilePromise: Promise<void> | undefined;

  constructor(
    private readonly app: FastifyInstance,
    private readonly sqlite: Database.Database,
    private readonly provider: LlmProvider,
    private readonly projectRoot: string,
    private readonly sessions: ExecutionSessionGateway,
    private readonly evidenceGraph: SqliteEvidenceGraphStore,
    private readonly cognitiveSnapshots: SqliteCognitiveSnapshotStore,
    private readonly modelRuntime: ModelExecutionRuntime,
    private readonly agentEvents: ScenarioAgentEventWriter,
    private readonly executionNode?: ExecutionNode,
  ) {}

  reconcile(): Promise<void> {
    if (this.reconcilePromise) return this.reconcilePromise;
    this.reconcilePromise = this.reconcileOnce().finally(() => { this.reconcilePromise = undefined; });
    return this.reconcilePromise;
  }

  async stop(): Promise<void> {
    await this.reconcilePromise;
    const registry = new SqliteWorkerRegistry(this.sqlite);
    await Promise.all([...this.supervisors.entries()].map(async ([workerId, managed]) => {
      await managed.supervisor.stop();
      registry.setStatus(workerId, "offline", new Date().toISOString());
    }));
    this.supervisors.clear();
  }

  private async reconcileOnce(): Promise<void> {
    const definitions = new ScenarioDefinitionRegistry([WEB_BLACKBOX_SCENARIO]);
    const eventStore = new SqliteScenarioEventStore(this.sqlite);
    const runtime = new DurableScenarioRuntime(eventStore, definitions);
    const runs = eventStore.listRuns()
      .filter((summary) => summary.status === "running")
      .map((summary) => runtime.load(summary.runId))
      .filter((run): run is ScenarioRunState => Boolean(run));
    for (const pool of WEB_BLACKBOX_SCENARIO.agentTopology.workerPools) {
      await this.resize(pool, desiredWorkerCount(pool, runs));
    }
  }

  private async resize(pool: ScenarioWorkerPoolDefinition, desired: number): Promise<void> {
    const current = [...this.supervisors.entries()]
      .filter(([, managed]) => managed.pool.id === pool.id)
      .sort(([left], [right]) => left.localeCompare(right));
    for (let index = current.length + 1; index <= desired; index += 1) {
      const workerId = `embedded-${pool.id}-${index}`;
      const supervisor = this.createSupervisor(workerId, pool);
      await supervisor.start();
      this.supervisors.set(workerId, { supervisor, pool });
    }
    if (current.length <= desired) return;
    const registry = new SqliteWorkerRegistry(this.sqlite);
    for (const [workerId, managed] of current.slice(desired).reverse()) {
      const active = this.sqlite.prepare("SELECT 1 FROM scenario_work_leases WHERE worker_id = ? LIMIT 1").get(workerId);
      if (active) continue;
      await managed.supervisor.stop();
      registry.setStatus(workerId, "offline", new Date().toISOString());
      this.supervisors.delete(workerId);
    }
  }

  private createSupervisor(workerId: string, pool: ScenarioWorkerPoolDefinition): WorkerSupervisor {
    const control = new HttpWorkerControlPlaneClient(serverBaseUrl(this.app));
    const model = new StructuredWorkerModel(this.provider, undefined, this.cognitiveSnapshots, undefined, undefined, this.modelRuntime);
    const receipts = new SqliteToolReceiptStore(this.sqlite);
    const authorizationGuard = new ScenarioAuthorizationGuard(this.sqlite);
    const tools: ExecutionToolAdapter[] = [
      new EvidenceGraphSnapshotTool(this.evidenceGraph),
      new EvidenceGraphMutateTool(this.sqlite, this.evidenceGraph),
      new ScenarioScopeSnapshotTool(authorizationGuard),
      new ScenarioTrafficSnapshotTool(this.sqlite, authorizationGuard),
      new ScenarioSessionOpenTool(authorizationGuard, this.sessions),
      new ScenarioHttpRequestTool(this.sqlite, authorizationGuard, this.sessions),
      new ScenarioBrowserObserveTool(this.sqlite, authorizationGuard, this.sessions),
      ...(this.executionNode ? [new ExecutionNodeProcessTool(this.executionNode)] : []),
    ];
    const worker: WorkerDescriptor = {
      id: workerId,
      roles: [pool.role],
      capabilities: pool.capabilities,
      maxConcurrentWork: pool.maxConcurrentWork,
      status: "online",
      heartbeatAt: new Date().toISOString(),
    };
    const gateway = new PolicyExecutionToolGateway(
      tools,
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
                network: "direct",
                process: { access: "sandboxed", interactive: false, background: false },
                secrets: "plaintext",
              },
            },
            {
              source: `scenario:${WEB_BLACKBOX_SCENARIO.kind}@${WEB_BLACKBOX_SCENARIO.version}`,
              profile: {
                version: 1,
                platform,
                filesystem: { read: [], write: [], deny: [] },
                network: "direct",
                process: { access: "deny", interactive: false, background: false },
                secrets: "handles_only",
              },
            },
          ];
        },
      },
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
  sessions: ExecutionSessionGateway,
  evidenceGraph: SqliteEvidenceGraphStore,
  changes: BlackboardChangeBus,
  cognitiveSnapshots: SqliteCognitiveSnapshotStore,
  modelRuntime: ModelExecutionRuntime,
  agentEvents: ScenarioAgentEventWriter,
  executionNode?: ExecutionNode,
): void {
  const pool = new EmbeddedScenarioWorkerPool(
    app, sqlite, provider, projectRoot, sessions, evidenceGraph, cognitiveSnapshots, modelRuntime, agentEvents, executionNode,
  );
  let listening = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const reconcile = () => {
    if (!listening || !providerReady()) return;
    pool.reconcile().catch((error) => app.log.error({ err: error }, "Embedded Worker pool reconciliation failed"));
  };
  const unsubscribeChanges = changes.subscribe(() => { reconcile(); });
  app.addHook("onListen", () => {
    listening = true;
    reconcile();
    timer = setInterval(reconcile, 30_000);
    timer.unref();
  });
  app.addHook("onClose", async () => {
    listening = false;
    unsubscribeChanges();
    if (timer) clearInterval(timer);
    await pool.stop();
  });
}
