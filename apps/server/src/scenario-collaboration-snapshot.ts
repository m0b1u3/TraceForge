import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { EvidenceGraphState, KnowledgeNode } from "@traceforge/evidence-graph";
import type {
  DurableScenarioRuntime,
  ScenarioDefinition,
  ScenarioDefinitionRegistry,
  ScenarioRunState,
  WorkerDescriptor,
} from "@traceforge/orchestration-core";
import type { SqliteEvidenceGraphStore } from "./evidence-graph-store.js";
import type { PlannerEvaluationRecord, SqliteRunPlannerStore } from "./run-planner.js";
import type { ObserverEvaluationRecord, SqliteRunObserverStore } from "./run-observer.js";
import type { ScenarioWorkLeaseRow, SqliteWorkerRegistry } from "./scenario-event-store.js";

export type CognitiveAgentStatus = "disabled" | "unavailable" | "awaiting_state" | "applying" | "observing";
export type WorkerHealth = "healthy" | "stale" | "draining" | "offline";

export interface ScenarioCollaborationSnapshot {
  runId: string;
  caseId: string;
  capturedAt: string;
  runRevision: number;
  graphRevision: number;
  agents: {
    planner: { status: CognitiveAgentStatus; evaluationCount: number; evaluations: PlannerEvaluationRecord[] };
    observer: { status: CognitiveAgentStatus; evaluationCount: number; evaluations: ObserverEvaluationRecord[] };
  };
  workerPools: Array<{
    id: string;
    role: string;
    activation: string;
    registeredCount: number;
    healthyCount: number;
    queuedWork: number;
    runningWork: number;
    activeLeases: number;
    maximumInstances: number;
  }>;
  workers: Array<{
    id: string;
    roles: string[];
    capabilities: string[];
    status: WorkerDescriptor["status"];
    health: WorkerHealth;
    heartbeatAt: string;
    heartbeatAgeMs: number | null;
    maxConcurrentWork: number;
    activeWork: number;
    availableSlots: number;
    runLeases: Array<ScenarioWorkLeaseRow & { expired: boolean; expiresInMs: number }>;
  }>;
  knowledge: {
    totalNodes: number;
    totalEdges: number;
    countsByKind: Record<string, number>;
    countsByStatus: Record<string, number>;
    nodes: Array<Pick<KnowledgeNode, "id" | "runId" | "kind" | "title" | "summary" | "status" | "confidence" | "updatedAt">>;
    edges: EvidenceGraphState["edges"];
    truncated: boolean;
  };
  workLinks: Array<{
    workId: string;
    hypothesisNodeIds: string[];
    evidenceNodeIds: string[];
    outputIds: string[];
    linkedNodeIds: string[];
    externalRefs: string[];
  }>;
}

export interface ScenarioCollaborationSnapshotOptions {
  heartbeatTimeoutMs: number;
  evaluationLimit: number;
  nodeLimit: number;
  cognitiveAgentsReady: () => boolean;
  now: () => string;
}

const defaults: ScenarioCollaborationSnapshotOptions = {
  heartbeatTimeoutMs: 30_000,
  evaluationLimit: 20,
  nodeLimit: 100,
  cognitiveAgentsReady: () => true,
  now: () => new Date().toISOString(),
};

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function agentStatus(enabled: boolean, ready: boolean, evaluationCount: number, latestApplied?: boolean): CognitiveAgentStatus {
  if (!enabled) return "disabled";
  if (!ready) return "unavailable";
  if (evaluationCount === 0) return "awaiting_state";
  return latestApplied === false ? "applying" : "observing";
}

export function workerHealth(worker: WorkerDescriptor, capturedAt: string, heartbeatTimeoutMs: number): { health: WorkerHealth; ageMs: number | null } {
  const ageMs = Date.parse(capturedAt) - Date.parse(worker.heartbeatAt);
  const validAge = Number.isFinite(ageMs) && ageMs >= 0 ? ageMs : null;
  if (worker.status === "offline") return { health: "offline", ageMs: validAge };
  if (worker.status === "draining") return { health: "draining", ageMs: validAge };
  return validAge !== null && validAge <= heartbeatTimeoutMs
    ? { health: "healthy", ageMs: validAge }
    : { health: "stale", ageMs: validAge };
}

function normalizedNodeRef(ref: string, nodeIds: Set<string>): string | null {
  const candidate = ref.startsWith("knowledge-node:") ? ref.slice("knowledge-node:".length) : ref;
  return nodeIds.has(candidate) ? candidate : null;
}

function visibleGraph(run: ScenarioRunState, graph: EvidenceGraphState, nodeLimit: number) {
  const eligible = graph.nodes.filter((node) => node.runId === null || node.runId === run.id);
  const nodeIds = new Set(eligible.map((node) => node.id));
  const referencedIds = new Set(run.workItems.flatMap((work) => [
    ...work.hypothesisIds,
    ...work.evidenceRefs,
    ...run.outputs.filter((output) => output.producedByWorkId === work.id).flatMap((output) => output.refs),
  ]).map((ref) => normalizedNodeRef(ref, nodeIds)).filter((id): id is string => Boolean(id)));
  const nodes = [...eligible].sort((left, right) => {
    const referenceOrder = Number(referencedIds.has(right.id)) - Number(referencedIds.has(left.id));
    if (referenceOrder) return referenceOrder;
    const runOrder = Number(right.runId === run.id) - Number(left.runId === run.id);
    if (runOrder) return runOrder;
    return right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id);
  }).slice(0, nodeLimit);
  const visibleIds = new Set(nodes.map((node) => node.id));
  const edges = graph.edges.filter((edge) => visibleIds.has(edge.sourceId) && visibleIds.has(edge.targetId));
  return { eligible, nodeIds, nodes, edges };
}

function buildWorkLinks(run: ScenarioRunState, nodeIds: Set<string>): ScenarioCollaborationSnapshot["workLinks"] {
  return run.workItems.map((work) => {
    const outputs = run.outputs.filter((output) => output.producedByWorkId === work.id);
    const allRefs = [...work.hypothesisIds, ...work.evidenceRefs, ...outputs.flatMap((output) => output.refs)];
    const linkedNodeIds = [...new Set(allRefs.map((ref) => normalizedNodeRef(ref, nodeIds)).filter((id): id is string => Boolean(id)))];
    return {
      workId: work.id,
      hypothesisNodeIds: [...new Set(work.hypothesisIds.map((ref) => normalizedNodeRef(ref, nodeIds)).filter((id): id is string => Boolean(id)))],
      evidenceNodeIds: [...new Set(work.evidenceRefs.map((ref) => normalizedNodeRef(ref, nodeIds)).filter((id): id is string => Boolean(id)))],
      outputIds: outputs.map((output) => output.id),
      linkedNodeIds,
      externalRefs: [...new Set(allRefs.filter((ref) => normalizedNodeRef(ref, nodeIds) === null))],
    };
  });
}

export class ScenarioCollaborationSnapshotService {
  private readonly options: ScenarioCollaborationSnapshotOptions;

  constructor(
    private readonly runtime: DurableScenarioRuntime,
    private readonly definitions: ScenarioDefinitionRegistry,
    private readonly graphs: SqliteEvidenceGraphStore,
    private readonly planner: SqliteRunPlannerStore,
    private readonly observer: SqliteRunObserverStore,
    private readonly workers: SqliteWorkerRegistry,
    options: Partial<ScenarioCollaborationSnapshotOptions> = {},
  ) {
    this.options = { ...defaults, ...options };
    if (this.options.heartbeatTimeoutMs < 1 || this.options.evaluationLimit < 1 || this.options.nodeLimit < 1) {
      throw new Error("Collaboration snapshot limits must be positive");
    }
  }

  capture(runId: string, limits: { evaluationLimit?: number; nodeLimit?: number } = {}): ScenarioCollaborationSnapshot | undefined {
    const run = this.runtime.load(runId);
    if (!run) return undefined;
    const definition = this.definitions.require(run.definitionKind, run.definitionVersion);
    const capturedAt = this.options.now();
    const graph = this.graphs.load(run.caseId) ?? {
      caseId: run.caseId,
      revision: 0,
      nodes: [],
      edges: [],
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    };
    const evaluationLimit = limits.evaluationLimit ?? this.options.evaluationLimit;
    const nodeLimit = limits.nodeLimit ?? this.options.nodeLimit;
    const plannerEvaluations = this.planner.list(run.id);
    const observerEvaluations = this.observer.list(run.id);
    const allLeases = this.workers.listLeases();
    const runLeases = allLeases.filter((lease) => lease.runId === run.id);
    const healthByWorker = new Map<string, ReturnType<typeof workerHealth>>();
    const workerViews = this.workers.list().map((worker) => {
      const health = workerHealth(worker, capturedAt, this.options.heartbeatTimeoutMs);
      healthByWorker.set(worker.id, health);
      const activeWork = allLeases.filter((lease) => lease.workerId === worker.id).length;
      return {
        ...worker,
        health: health.health,
        heartbeatAgeMs: health.ageMs,
        activeWork,
        availableSlots: Math.max(0, worker.maxConcurrentWork - activeWork),
        runLeases: runLeases.filter((lease) => lease.workerId === worker.id).map((lease) => {
          const expiresInMs = Date.parse(lease.leaseExpiresAt) - Date.parse(capturedAt);
          return { ...lease, expired: !Number.isFinite(expiresInMs) || expiresInMs <= 0, expiresInMs };
        }),
      };
    });
    const graphView = visibleGraph(run, graph, nodeLimit);
    const ready = this.options.cognitiveAgentsReady();
    return {
      runId: run.id,
      caseId: run.caseId,
      capturedAt,
      runRevision: run.revision,
      graphRevision: graph.revision,
      agents: {
        planner: {
          status: agentStatus(
            definition.agentTopology.planner.enabled,
            ready,
            plannerEvaluations.length,
            plannerEvaluations.at(-1)?.applied,
          ),
          evaluationCount: plannerEvaluations.length,
          evaluations: plannerEvaluations.slice(-evaluationLimit).reverse(),
        },
        observer: {
          status: agentStatus(
            definition.agentTopology.observer.enabled,
            ready,
            observerEvaluations.length,
            observerEvaluations.at(-1)?.applied,
          ),
          evaluationCount: observerEvaluations.length,
          evaluations: observerEvaluations.slice(-evaluationLimit).reverse(),
        },
      },
      workerPools: this.poolViews(definition, run, workerViews, runLeases, healthByWorker),
      workers: workerViews,
      knowledge: {
        totalNodes: graphView.eligible.length,
        totalEdges: graph.edges.filter((edge) => graphView.nodeIds.has(edge.sourceId) && graphView.nodeIds.has(edge.targetId)).length,
        countsByKind: countBy(graphView.eligible.map((node) => node.kind)),
        countsByStatus: countBy(graphView.eligible.map((node) => node.status)),
        nodes: graphView.nodes.map(({ id, runId: nodeRunId, kind, title, summary, status, confidence, updatedAt }) => ({
          id, runId: nodeRunId, kind, title, summary, status, confidence, updatedAt,
        })),
        edges: graphView.edges,
        truncated: graphView.eligible.length > graphView.nodes.length,
      },
      workLinks: buildWorkLinks(run, graphView.nodeIds),
    };
  }

  private poolViews(
    definition: ScenarioDefinition,
    run: ScenarioRunState,
    workers: ScenarioCollaborationSnapshot["workers"],
    runLeases: ScenarioWorkLeaseRow[],
    healthByWorker: Map<string, ReturnType<typeof workerHealth>>,
  ): ScenarioCollaborationSnapshot["workerPools"] {
    const kindByRole: Record<string, ScenarioRunState["workItems"][number]["kind"]> = {
      researcher: "research", validator: "validation", reviewer: "review", reporter: "report",
    };
    return definition.agentTopology.workerPools.map((pool) => {
      const registered = workers.filter((worker) => worker.roles.includes(pool.role));
      const kind = kindByRole[pool.role];
      return {
        id: pool.id,
        role: pool.role,
        activation: pool.activation,
        registeredCount: registered.length,
        healthyCount: registered.filter((worker) => healthByWorker.get(worker.id)?.health === "healthy").length,
        queuedWork: run.workItems.filter((work) => work.kind === kind && work.status === "queued").length,
        runningWork: run.workItems.filter((work) => work.kind === kind && work.status === "running").length,
        activeLeases: runLeases.filter((lease) => registered.some((worker) => worker.id === lease.workerId)).length,
        maximumInstances: pool.maximumInstances,
      };
    });
  }
}

export function registerScenarioCollaborationRoutes(app: FastifyInstance, service: ScenarioCollaborationSnapshotService): void {
  app.get("/api/scenarios/runs/:runId/collaboration", async (request, reply) => {
    try {
      const { runId } = z.object({ runId: z.string().min(1) }).parse(request.params);
      const query = z.object({
        evaluationLimit: z.coerce.number().int().min(1).max(100).optional(),
        nodeLimit: z.coerce.number().int().min(1).max(500).optional(),
      }).parse(request.query);
      const snapshot = service.capture(runId, query);
      if (!snapshot) return reply.code(404).send({ error: `Unknown scenario run ${runId}` });
      return snapshot;
    } catch (error) {
      return sendSnapshotError(reply, error);
    }
  });
}

function sendSnapshotError(reply: FastifyReply, error: unknown) {
  if (error instanceof z.ZodError) return reply.code(400).send({ error: "invalid request", issues: error.issues });
  return reply.code(400).send({ error: error instanceof Error ? error.message : "collaboration snapshot failed" });
}
