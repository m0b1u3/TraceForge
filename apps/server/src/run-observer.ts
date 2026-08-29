import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { LlmProvider } from "@traceforge/llm";
import {
  CognitiveContextDistiller,
  CognitiveEvaluationRunner,
  CognitiveLoopScheduler,
  CognitiveWakeGate,
  type CognitiveContextCursorPort,
  type CognitiveEvaluationSnapshotPort,
} from "@traceforge/cognitive-runtime";
import {
  RevisionConflictError,
  type DurableScenarioRuntime,
  type ScenarioDefinitionRegistry,
  type ScenarioEvent,
  type ScenarioRunState,
} from "@traceforge/orchestration-core";
import type { EvidenceGraphState } from "@traceforge/evidence-graph";
import type { SqliteEvidenceGraphStore } from "./evidence-graph-store.js";
import type { SqliteScenarioEventStore } from "./scenario-event-store.js";
import type { ModelExecutionRuntime } from "./model-execution-runtime.js";

const observerDecision = z.discriminatedUnion("action", [
  z.object({ action: z.literal("continue"), rationale: z.string().min(1) }),
  z.object({
    action: z.literal("steer"), workId: z.string().min(1), instruction: z.string().min(1), rationale: z.string().min(1),
  }),
  z.object({ action: z.literal("terminate_branch"), workId: z.string().min(1), reason: z.string().min(1) }),
  z.object({ action: z.literal("terminate_run"), reason: z.string().min(1) }),
]);

export type RunObserverDecision = z.infer<typeof observerDecision>;

export interface RunObserverSnapshot {
  contextId: string;
  run: ScenarioRunState;
  graph: EvidenceGraphState;
  recentEvents: ScenarioEvent[];
  maximumGraphNodes: number;
  maximumRunItems: number;
}

export interface RunObserverModel {
  evaluate(snapshot: RunObserverSnapshot): Promise<RunObserverDecision>;
}

const decisionSchema = {
  type: "object",
  oneOf: [
    { properties: { action: { const: "continue" }, rationale: { type: "string" } }, required: ["action", "rationale"], additionalProperties: false },
    { properties: { action: { const: "steer" }, workId: { type: "string" }, instruction: { type: "string" }, rationale: { type: "string" } }, required: ["action", "workId", "instruction", "rationale"], additionalProperties: false },
    { properties: { action: { const: "terminate_branch" }, workId: { type: "string" }, reason: { type: "string" } }, required: ["action", "workId", "reason"], additionalProperties: false },
    { properties: { action: { const: "terminate_run" }, reason: { type: "string" } }, required: ["action", "reason"], additionalProperties: false },
  ],
} satisfies Record<string, unknown>;

export class StructuredRunObserverModel implements RunObserverModel {
  private readonly evaluations: CognitiveEvaluationRunner;

  constructor(
    private readonly provider: LlmProvider,
    private readonly distiller = new CognitiveContextDistiller(),
    snapshots?: CognitiveEvaluationSnapshotPort,
    now: () => string = () => new Date().toISOString(),
    private readonly modelRuntime?: ModelExecutionRuntime,
  ) {
    this.evaluations = new CognitiveEvaluationRunner(snapshots, now);
  }

  async evaluate(snapshot: RunObserverSnapshot): Promise<RunObserverDecision> {
    const context = this.distiller.distillRun(snapshot.run, snapshot.graph, snapshot.recentEvents, {
      maximumGraphNodes: snapshot.maximumGraphNodes,
      maximumRecentEvents: snapshot.recentEvents.length || 1,
      maximumRunItems: snapshot.maximumRunItems,
    });
    const request = {
      system: [
        "You are the independent Run Observer of a security-agent control plane.",
        "You do not execute tools, create evidence, validate your own findings, or perform assigned Worker tasks.",
        "Assess global progress, repeated semantic actions, unsupported conclusions, evidence conflicts, authorization drift, and low-information branches.",
        "Prefer continue when evidence is insufficient. Steer only a non-terminal Work with a concrete state-based instruction.",
        "Terminate a branch or Run only when the supplied state provides a traceable reason. Never invent facts, identifiers, impact, or authorization.",
        "Return only the requested JSON decision and never expose private chain-of-thought.",
      ].join("\n"),
      user: JSON.stringify({
        run: {
          ...context.run,
        },
        graph: context.graph,
        recentEvents: context.recentEvents,
        contextManifest: context.manifest,
      }),
      schema: decisionSchema,
    };
    return this.evaluations.run({
      snapshot: {
        id: snapshot.contextId,
        consumer: "observer",
        runId: snapshot.run.id,
        caseId: snapshot.run.caseId,
        evaluationId: snapshot.contextId,
        sourceRunRevision: snapshot.run.revision,
        sourceGraphRevision: snapshot.graph.revision,
        semanticFingerprint: context.semanticFingerprint,
        request,
        contextManifest: context.manifest,
      },
      model: {
        extractJson: (modelRequest) => this.modelRuntime
          ? this.modelRuntime.extractJson({
              role: "observer", snapshotId: snapshot.contextId, runId: snapshot.run.id, caseId: snapshot.run.caseId,
            }, modelRequest)
          : this.provider.extractJson(modelRequest),
      },
      parse: (value) => observerDecision.parse(value),
      completion: (parsed) => ({
        decisionKind: parsed.action,
        outcome: parsed.action === "terminate_branch" || parsed.action === "terminate_run" ? "blocked" : "continue",
      }),
    });
  }
}

interface EvaluationRow {
  id: string;
  decision_json: string;
  applied: number;
  resulting_run_revision: number | null;
}

export interface ObserverEvaluationRecord {
  id: string;
  runId: string;
  caseId: string;
  observedRunRevision: number;
  observedGraphRevision: number;
  decision: RunObserverDecision;
  applied: boolean;
  resultingRunRevision: number | null;
  createdAt: string;
  appliedAt: string | null;
}

export class SqliteRunObserverStore {
  constructor(private readonly sqlite: Database.Database) {}

  cursor(runId: string): { runRevision: number; graphRevision: number } | undefined {
    const row = this.sqlite.prepare("SELECT run_revision, graph_revision FROM scenario_observer_cursors WHERE run_id = ?")
      .get(runId) as { run_revision: number; graph_revision: number } | undefined;
    return row ? { runRevision: row.run_revision, graphRevision: row.graph_revision } : undefined;
  }

  find(runId: string, runRevision: number, graphRevision: number): { id: string; decision: RunObserverDecision; applied: boolean; resultingRunRevision: number | null } | undefined {
    const row = this.sqlite.prepare(`
      SELECT id, decision_json, applied, resulting_run_revision FROM scenario_observer_evaluations
      WHERE run_id = ? AND observed_run_revision = ? AND observed_graph_revision = ?
    `).get(runId, runRevision, graphRevision) as EvaluationRow | undefined;
    return row ? { id: row.id, decision: observerDecision.parse(JSON.parse(row.decision_json)), applied: row.applied === 1, resultingRunRevision: row.resulting_run_revision } : undefined;
  }

  record(input: { id: string; runId: string; caseId: string; runRevision: number; graphRevision: number; decision: RunObserverDecision; at: string }): void {
    this.sqlite.prepare(`
      INSERT INTO scenario_observer_evaluations
        (id, run_id, case_id, observed_run_revision, observed_graph_revision, decision_json, applied, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?)
    `).run(input.id, input.runId, input.caseId, input.runRevision, input.graphRevision, JSON.stringify(input.decision), input.at);
  }

  complete(evaluationId: string, runId: string, runRevision: number, graphRevision: number, at: string): void {
    this.sqlite.transaction(() => {
      const updated = this.sqlite.prepare(`
        UPDATE scenario_observer_evaluations
        SET applied = 1, resulting_run_revision = ?, applied_at = ? WHERE id = ?
      `).run(runRevision, at, evaluationId);
      if (updated.changes !== 1) throw new Error(`Unknown Observer evaluation ${evaluationId}`);
      this.sqlite.prepare(`
        INSERT INTO scenario_observer_cursors (run_id, run_revision, graph_revision, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET run_revision = excluded.run_revision,
          graph_revision = excluded.graph_revision, updated_at = excluded.updated_at
      `).run(runId, runRevision, graphRevision, at);
    })();
  }

  list(runId: string): ObserverEvaluationRecord[] {
    const rows = this.sqlite.prepare(`
      SELECT id, run_id, case_id, observed_run_revision, observed_graph_revision, decision_json,
             applied, resulting_run_revision, created_at, applied_at
      FROM scenario_observer_evaluations WHERE run_id = ? ORDER BY created_at ASC
    `).all(runId) as Array<{
      id: string; run_id: string; case_id: string; observed_run_revision: number; observed_graph_revision: number;
      decision_json: string; applied: number; resulting_run_revision: number | null; created_at: string; applied_at: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id, runId: row.run_id, caseId: row.case_id, observedRunRevision: row.observed_run_revision,
      observedGraphRevision: row.observed_graph_revision, decision: observerDecision.parse(JSON.parse(row.decision_json)),
      applied: row.applied === 1, resultingRunRevision: row.resulting_run_revision, createdAt: row.created_at, appliedAt: row.applied_at,
    }));
  }
}

export interface RunObserverSupervisorOptions {
  errorBackoffMs: number;
  concurrencyRetries: number;
}

export class RunObserverSupervisor {
  private readonly loop: CognitiveLoopScheduler;
  private readonly distiller = new CognitiveContextDistiller();
  private readonly wakeGate: CognitiveWakeGate;

  constructor(
    private readonly runtime: DurableScenarioRuntime,
    private readonly definitions: ScenarioDefinitionRegistry,
    private readonly scenarioEvents: SqliteScenarioEventStore,
    private readonly graphs: SqliteEvidenceGraphStore,
    private readonly store: SqliteRunObserverStore,
    private readonly model: RunObserverModel,
    private readonly options: RunObserverSupervisorOptions = { errorBackoffMs: 5_000, concurrencyRetries: 4 },
    private readonly createId: () => string = randomUUID,
    private readonly now: () => string = () => new Date().toISOString(),
    onError: (error: unknown) => void = () => undefined,
    semanticCursors?: CognitiveContextCursorPort,
  ) {
    this.wakeGate = new CognitiveWakeGate(semanticCursors);
    this.loop = new CognitiveLoopScheduler({
      tick: () => this.tick(),
      nextPollDelayMs: () => this.minimumPollInterval(),
      errorBackoffMs: this.options.errorBackoffMs,
      onError,
    });
  }

  start(): void { this.loop.start(); }

  wake(): void { this.loop.wake(); }

  stop(): Promise<void> { return this.loop.stop(); }

  async tick(): Promise<void> {
    for (const summary of this.scenarioEvents.listRuns().filter((run) => run.status === "running")) {
      const run = this.runtime.load(summary.runId);
      if (!run?.status || run.status !== "running") continue;
      const topology = this.definitions.require(run.definitionKind, run.definitionVersion).agentTopology;
      if (!topology.observer.enabled) continue;
      const graph = this.graphs.ensure(run.caseId, this.now());
      const allEvents = this.scenarioEvents.load(run.id).events;
      const context = this.distiller.distillRun(run, graph, allEvents, {
        maximumRecentEvents: topology.observer.maximumRecentEvents,
        maximumGraphNodes: topology.observer.maximumGraphNodes,
        maximumRunItems: topology.observer.maximumRunItems,
      });
      if (!this.wakeGate.shouldEvaluate("observer", run.id, context.semanticFingerprint)) continue;
      const cursor = this.store.cursor(run.id);
      if (cursor?.runRevision === run.revision && cursor.graphRevision === graph.revision) continue;
      await this.evaluateRun(
        run, graph, topology.observer.maximumRecentEvents,
        topology.observer.maximumGraphNodes, topology.observer.maximumRunItems,
      );
    }
  }

  private async evaluateRun(
    run: ScenarioRunState,
    graph: EvidenceGraphState,
    maximumRecentEvents: number,
    maximumGraphNodes: number,
    maximumRunItems: number,
  ): Promise<void> {
    let evaluation = this.store.find(run.id, run.revision, graph.revision);
    if (!evaluation) {
      const evaluationId = this.createId();
      const decision = await this.model.evaluate({
        contextId: evaluationId,
        run,
        graph,
        recentEvents: this.scenarioEvents.load(run.id).events.slice(-maximumRecentEvents),
        maximumGraphNodes,
        maximumRunItems,
      });
      evaluation = { id: evaluationId, decision, applied: false, resultingRunRevision: null };
      this.store.record({
        id: evaluation.id, runId: run.id, caseId: run.caseId, runRevision: run.revision,
        graphRevision: graph.revision, decision, at: this.now(),
      });
    }
    if (evaluation.applied) return;
    const resultingRevision = this.applyDecision(run.id, evaluation.id, evaluation.decision);
    this.store.complete(evaluation.id, run.id, resultingRevision, graph.revision, this.now());
    const latestRun = this.runtime.load(run.id);
    if (!latestRun) return;
    const latestGraph = this.graphs.ensure(run.caseId, this.now());
    const latestContext = this.distiller.distillRun(latestRun, latestGraph, this.scenarioEvents.load(run.id).events, {
      maximumRecentEvents,
      maximumGraphNodes,
      maximumRunItems,
    });
    this.wakeGate.advance({
      consumer: "observer",
      runId: run.id,
      semanticFingerprint: latestContext.semanticFingerprint,
      sourceRunRevision: latestRun.revision,
      sourceGraphRevision: latestGraph.revision,
      at: this.now(),
    });
  }

  private applyDecision(runId: string, evaluationId: string, decision: RunObserverDecision): number {
    for (let attempt = 0; attempt < this.options.concurrencyRetries; attempt += 1) {
      const state = this.runtime.load(runId);
      if (!state || state.status !== "running") return state?.revision ?? 0;
      try {
        if (decision.action === "continue") return state.revision;
        if (decision.action === "terminate_run") {
          return this.runtime.execute({
            runId, commandId: `observer:${evaluationId}`, expectedRevision: state.revision,
            command: { type: "cancel_run", reason: `Observer: ${decision.reason}`, at: this.now() },
          }).state.revision;
        }
        const work = state.workItems.find((candidate) => candidate.id === decision.workId);
        if (!work || ["completed", "blocked", "failed", "cancelled"].includes(work.status)) return state.revision;
        if (decision.action === "terminate_branch") {
          return this.runtime.execute({
            runId, commandId: `observer:${evaluationId}`, expectedRevision: state.revision,
            command: { type: "cancel_work", workId: work.id, leaseId: work.leaseId ?? undefined, reason: `Observer: ${decision.reason}`, at: this.now() },
          }).state.revision;
        }
        return this.runtime.execute({
          runId, commandId: `observer:${evaluationId}`, expectedRevision: state.revision,
          command: {
            type: "issue_directive",
            directive: { id: evaluationId, kind: "steer", targetWorkId: work.id, instruction: decision.instruction, rationale: decision.rationale, issuedBy: "observer" },
            at: this.now(),
          },
        }).state.revision;
      } catch (error) {
        if (!(error instanceof RevisionConflictError) || attempt === this.options.concurrencyRetries - 1) throw error;
      }
    }
    throw new Error(`Observer decision ${evaluationId} exhausted concurrency retries`);
  }

  private minimumPollInterval(): number {
    const intervals = this.scenarioEvents.listRuns()
      .map((summary) => this.runtime.load(summary.runId))
      .filter((run): run is ScenarioRunState => Boolean(run))
      .map((run) => this.definitions.require(run.definitionKind, run.definitionVersion).agentTopology.observer.pollIntervalMs);
    return intervals.length ? Math.min(...intervals) : this.options.errorBackoffMs;
  }
}

export function registerRunObserverRoutes(app: FastifyInstance, store: SqliteRunObserverStore): void {
  app.get("/api/scenarios/runs/:runId/observer/evaluations", async (request) => {
    const { runId } = z.object({ runId: z.string().min(1) }).parse(request.params);
    return store.list(runId);
  });
}
