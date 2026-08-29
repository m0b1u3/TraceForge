import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { EvidenceGraphState, KnowledgeNode } from "@traceforge/evidence-graph";
import type { LlmProvider } from "@traceforge/llm";
import {
  CognitiveContextDistiller,
  CognitiveEvaluationRunner,
  CognitiveLoopScheduler,
  type CognitiveEvaluationSnapshotPort,
} from "@traceforge/cognitive-runtime";
import {
  RevisionConflictError,
  transitionAllowed,
  type DurableScenarioRuntime,
  type ScenarioDefinition,
  type ScenarioDefinitionRegistry,
  type ScenarioEvent,
  type ScenarioRunState,
  type WorkKind,
} from "@traceforge/orchestration-core";
import type { SqliteEvidenceGraphStore } from "./evidence-graph-store.js";
import type { SqliteScenarioEventStore } from "./scenario-event-store.js";
import type { ModelExecutionRuntime } from "./model-execution-runtime.js";

const workKind = z.string().min(1);
const proposal = z.object({
  kind: workKind,
  title: z.string().min(1),
  objective: z.string().min(1),
  priority: z.number().int().min(0).max(100),
  requiredCapabilities: z.array(z.string().min(1)),
  hypothesisIds: z.array(z.string().min(1)),
  evidenceRefs: z.array(z.string().min(1)),
  maxAttempts: z.number().int().min(1).max(20),
});
const plannerDecision = z.discriminatedUnion("action", [
  z.object({ action: z.literal("wait"), rationale: z.string().min(1) }),
  z.object({
    action: z.literal("plan"),
    rationale: z.string().min(1),
    proposals: z.array(proposal),
    cancellations: z.array(z.object({ workId: z.string().min(1), reason: z.string().min(1) })),
    reprioritizations: z.array(z.object({ workId: z.string().min(1), priority: z.number().int().min(0).max(100), reason: z.string().min(1) })),
  }),
]);

export type RunPlannerDecision = z.infer<typeof plannerDecision>;

export interface RunPlannerSnapshot {
  contextId: string;
  run: ScenarioRunState;
  definition: ScenarioDefinition;
  graph: EvidenceGraphState;
  recentEvents: ScenarioEvent[];
  maximumGraphNodes: number;
  maximumRunItems: number;
}

export interface RunPlannerModel {
  evaluate(snapshot: RunPlannerSnapshot): Promise<RunPlannerDecision>;
}

const decisionSchema = {
  type: "object",
  oneOf: [
    { properties: { action: { const: "wait" }, rationale: { type: "string" } }, required: ["action", "rationale"], additionalProperties: false },
    {
      properties: {
        action: { const: "plan" }, rationale: { type: "string" },
        proposals: { type: "array", items: { type: "object", additionalProperties: false, properties: {
          kind: { type: "string" }, title: { type: "string" }, objective: { type: "string" }, priority: { type: "integer", minimum: 0, maximum: 100 },
          requiredCapabilities: { type: "array", items: { type: "string" } }, hypothesisIds: { type: "array", items: { type: "string" } },
          evidenceRefs: { type: "array", items: { type: "string" } }, maxAttempts: { type: "integer", minimum: 1, maximum: 20 },
        }, required: ["kind", "title", "objective", "priority", "requiredCapabilities", "hypothesisIds", "evidenceRefs", "maxAttempts"] } },
        cancellations: { type: "array", items: { type: "object", additionalProperties: false, properties: { workId: { type: "string" }, reason: { type: "string" } }, required: ["workId", "reason"] } },
        reprioritizations: { type: "array", items: { type: "object", additionalProperties: false, properties: { workId: { type: "string" }, priority: { type: "integer", minimum: 0, maximum: 100 }, reason: { type: "string" } }, required: ["workId", "priority", "reason"] } },
      },
      required: ["action", "rationale", "proposals", "cancellations", "reprioritizations"],
      additionalProperties: false,
    },
  ],
} satisfies Record<string, unknown>;

function relevantNodes(run: ScenarioRunState, graph: EvidenceGraphState, limit: number): KnowledgeNode[] {
  return graph.nodes.filter((node) => node.runId === null || node.runId === run.id).slice(-limit);
}

export class StructuredRunPlannerModel implements RunPlannerModel {
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

  async evaluate(snapshot: RunPlannerSnapshot): Promise<RunPlannerDecision> {
    const phase = snapshot.definition.phases.find((candidate) => candidate.id === snapshot.run.activePhaseId);
    if (!phase) throw new Error(`Planner cannot find active phase ${snapshot.run.activePhaseId}`);
    const context = this.distiller.distillRun(snapshot.run, snapshot.graph, snapshot.recentEvents, {
      maximumGraphNodes: snapshot.maximumGraphNodes,
      maximumRecentEvents: snapshot.recentEvents.length || 1,
      maximumRunItems: snapshot.maximumRunItems,
    });
    const request = {
      system: [
        "You are the strategic Planner of a general security-agent control plane.",
        "You plan bounded Work Packages; you never execute tools, send requests, invent evidence, or declare a Finding verified.",
        "Use only supplied identifiers and capabilities. Preserve distinct hypotheses and propose validation only for a traceable Hypothesis.",
        "Avoid duplicate Work. Cancel or reprioritize only queued Work when the supplied state justifies it.",
        "Plan for the active Scenario phase and its objective. Concrete attack or analysis techniques come only from the Scenario Profile, never from product-wide assumptions.",
        "Return only the requested JSON and never expose private chain-of-thought.",
      ].join("\n"),
      user: JSON.stringify({
        scenario: { kind: snapshot.definition.kind, title: snapshot.definition.title, phase, workerPools: snapshot.definition.agentTopology.workerPools },
        run: {
          id: context.run.id, caseId: context.run.caseId, goal: context.run.goal, scopeRef: context.run.scopeRef,
          activePhaseId: context.run.activePhaseId, availableCapabilities: context.run.availableCapabilities,
          workItems: context.run.workItems,
          outputs: context.run.outputs,
          directives: context.run.directives,
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
        consumer: "planner",
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
              role: "planner", snapshotId: snapshot.contextId, runId: snapshot.run.id, caseId: snapshot.run.caseId,
            }, modelRequest)
          : this.provider.extractJson(modelRequest),
      },
      parse: (value) => plannerDecision.parse(value),
      completion: (parsed) => ({
        decisionKind: parsed.action,
        outcome: parsed.action === "wait" ? "continue" : "finish",
      }),
    });
  }
}

export function planningFingerprint(
  run: ScenarioRunState,
  graph: EvidenceGraphState,
  maximumGraphNodes: number,
  maximumRunItems = Number.POSITIVE_INFINITY,
): string {
  return new CognitiveContextDistiller().distillRun(run, graph, [], {
    maximumGraphNodes,
    maximumRecentEvents: 1,
    maximumRunItems: Number.isFinite(maximumRunItems) ? maximumRunItems : Math.max(1, run.workItems.length, run.outputs.length, run.directives.length),
  }).semanticFingerprint;
}

interface EvaluationRow { id: string; decision_json: string; applied: number; resulting_run_revision: number | null; observed_phase_id: string }

export interface PlannerEvaluationRecord {
  id: string; runId: string; caseId: string; inputFingerprint: string; observedRunRevision: number;
  observedGraphRevision: number; observedPhaseId: string; decision: RunPlannerDecision; applied: boolean;
  resultingRunRevision: number | null; createdAt: string; appliedAt: string | null;
}

export class SqliteRunPlannerStore {
  constructor(private readonly sqlite: Database.Database) {}

  cursor(runId: string): string | undefined {
    return (this.sqlite.prepare("SELECT input_fingerprint FROM scenario_planner_cursors WHERE run_id = ?").get(runId) as { input_fingerprint: string } | undefined)?.input_fingerprint;
  }

  find(runId: string, fingerprint: string): { id: string; decision: RunPlannerDecision; applied: boolean; resultingRunRevision: number | null; observedPhaseId: string } | undefined {
    const row = this.sqlite.prepare(`
      SELECT id, decision_json, applied, resulting_run_revision, observed_phase_id
      FROM scenario_planner_evaluations WHERE run_id = ? AND input_fingerprint = ?
    `).get(runId, fingerprint) as EvaluationRow | undefined;
    return row ? {
      id: row.id, decision: plannerDecision.parse(JSON.parse(row.decision_json)), applied: row.applied === 1,
      resultingRunRevision: row.resulting_run_revision, observedPhaseId: row.observed_phase_id,
    } : undefined;
  }

  record(input: { id: string; run: ScenarioRunState; graphRevision: number; fingerprint: string; decision: RunPlannerDecision; at: string }): void {
    this.sqlite.prepare(`
      INSERT INTO scenario_planner_evaluations
        (id, run_id, case_id, input_fingerprint, observed_run_revision, observed_graph_revision,
         observed_phase_id, decision_json, applied, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(
      input.id, input.run.id, input.run.caseId, input.fingerprint, input.run.revision, input.graphRevision,
      input.run.activePhaseId, JSON.stringify(input.decision), input.at,
    );
  }

  complete(input: { evaluationId: string; runId: string; fingerprint: string; runRevision: number; graphRevision: number; at: string }): void {
    this.sqlite.transaction(() => {
      const update = this.sqlite.prepare(`
        UPDATE scenario_planner_evaluations SET applied = 1, resulting_run_revision = ?, applied_at = ? WHERE id = ?
      `).run(input.runRevision, input.at, input.evaluationId);
      if (update.changes !== 1) throw new Error(`Unknown Planner evaluation ${input.evaluationId}`);
      this.sqlite.prepare(`
        INSERT INTO scenario_planner_cursors (run_id, input_fingerprint, run_revision, graph_revision, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET input_fingerprint = excluded.input_fingerprint,
          run_revision = excluded.run_revision, graph_revision = excluded.graph_revision, updated_at = excluded.updated_at
      `).run(input.runId, input.fingerprint, input.runRevision, input.graphRevision, input.at);
    })();
  }

  list(runId: string): PlannerEvaluationRecord[] {
    const rows = this.sqlite.prepare(`
      SELECT id, run_id, case_id, input_fingerprint, observed_run_revision, observed_graph_revision,
             observed_phase_id, decision_json, applied, resulting_run_revision, created_at, applied_at
      FROM scenario_planner_evaluations WHERE run_id = ? ORDER BY created_at ASC
    `).all(runId) as Array<{
      id: string; run_id: string; case_id: string; input_fingerprint: string; observed_run_revision: number;
      observed_graph_revision: number; observed_phase_id: string; decision_json: string; applied: number;
      resulting_run_revision: number | null; created_at: string; applied_at: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id, runId: row.run_id, caseId: row.case_id, inputFingerprint: row.input_fingerprint,
      observedRunRevision: row.observed_run_revision, observedGraphRevision: row.observed_graph_revision,
      observedPhaseId: row.observed_phase_id, decision: plannerDecision.parse(JSON.parse(row.decision_json)),
      applied: row.applied === 1, resultingRunRevision: row.resulting_run_revision,
      createdAt: row.created_at, appliedAt: row.applied_at,
    }));
  }
}

export class RunPlannerSupervisor {
  private readonly loop: CognitiveLoopScheduler;

  constructor(
    private readonly runtime: DurableScenarioRuntime,
    private readonly definitions: ScenarioDefinitionRegistry,
    private readonly scenarioEvents: SqliteScenarioEventStore,
    private readonly graphs: SqliteEvidenceGraphStore,
    private readonly store: SqliteRunPlannerStore,
    private readonly model: RunPlannerModel,
    private readonly concurrencyRetries = 4,
    private readonly createId: () => string = randomUUID,
    private readonly now: () => string = () => new Date().toISOString(),
    onError: (error: unknown) => void = () => undefined,
  ) {
    this.loop = new CognitiveLoopScheduler({
      tick: () => this.tick(),
      nextPollDelayMs: () => this.minimumPollInterval(),
      errorBackoffMs: 5_000,
      onError,
    });
  }

  start(): void { this.loop.start(); }

  wake(): void { this.loop.wake(); }

  stop(): Promise<void> { return this.loop.stop(); }

  async tick(): Promise<void> {
    for (const summary of this.scenarioEvents.listRuns().filter((run) => run.status === "running")) {
      const run = this.runtime.load(summary.runId);
      if (!run || run.status !== "running") continue;
      const definition = this.definitions.require(run.definitionKind, run.definitionVersion);
      const config = definition.agentTopology.planner;
      if (!config.enabled) continue;
      const graph = this.graphs.ensure(run.caseId, this.now());
      const fingerprint = planningFingerprint(run, graph, config.maximumGraphNodes, config.maximumRunItems);
      if (this.store.cursor(run.id) === fingerprint) continue;
      await this.evaluateRun(run, definition, graph, fingerprint);
    }
  }

  private async evaluateRun(run: ScenarioRunState, definition: ScenarioDefinition, graph: EvidenceGraphState, fingerprint: string): Promise<void> {
    const config = definition.agentTopology.planner;
    let evaluation = this.store.find(run.id, fingerprint);
    if (!evaluation) {
      const evaluationId = this.createId();
      const decision = await this.model.evaluate({
        contextId: evaluationId, run, definition, graph,
        recentEvents: this.scenarioEvents.load(run.id).events.slice(-config.maximumRecentEvents),
        maximumGraphNodes: config.maximumGraphNodes, maximumRunItems: config.maximumRunItems,
      });
      this.validateDecision(decision, run, definition, graph);
      evaluation = { id: evaluationId, decision, applied: false, resultingRunRevision: null, observedPhaseId: run.activePhaseId };
      this.store.record({ id: evaluation.id, run, graphRevision: graph.revision, fingerprint, decision, at: this.now() });
    }
    if (evaluation.applied) return;
    const result = this.applyDecision(run.id, evaluation.id, evaluation.observedPhaseId, evaluation.decision);
    const advanced = this.advanceIfAllowed(run.id, evaluation.id, evaluation.observedPhaseId);
    this.store.complete({
      evaluationId: evaluation.id, runId: run.id, fingerprint,
      runRevision: advanced ?? result, graphRevision: graph.revision, at: this.now(),
    });
  }

  private validateDecision(decision: RunPlannerDecision, run: ScenarioRunState, definition: ScenarioDefinition, graph: EvidenceGraphState): void {
    if (decision.action === "wait") return;
    const config = definition.agentTopology.planner;
    if (decision.proposals.length > config.maximumProposalsPerEvaluation) {
      throw new Error(`Planner proposed ${decision.proposals.length} Work Packages; maximum is ${config.maximumProposalsPerEvaluation}`);
    }
    if (decision.proposals.length + decision.cancellations.length + decision.reprioritizations.length === 0) {
      throw new Error("Planner plan must contain at least one state change");
    }
    const phase = definition.phases.find((candidate) => candidate.id === run.activePhaseId)!;
    const visibleNodes = relevantNodes(run, graph, config.maximumGraphNodes);
    const knownHypotheses = new Set(visibleNodes.filter((node) => node.kind === "hypothesis" && node.status !== "invalidated").map((node) => node.id));
    const knownRefs = new Set([
      run.scopeRef,
      ...run.outputs.flatMap((output) => output.refs),
      ...visibleNodes.flatMap((node) => [node.id, `knowledge-node:${node.id}`]),
    ]);
    const available = new Set(run.availableCapabilities);
    const signatures = new Set(run.workItems.filter((work) => !["completed", "blocked", "failed", "cancelled"].includes(work.status))
      .map((work) => this.workSignature(work.kind, work.title, work.objective)));
    for (const item of decision.proposals) {
      if (!phase.allowedWorkKinds.includes(item.kind)) throw new Error(`Planner proposed ${item.kind} outside phase ${phase.id}`);
      const unknownHypotheses = item.hypothesisIds.filter((id) => !knownHypotheses.has(id));
      if (unknownHypotheses.length) throw new Error(`Planner referenced unknown Hypotheses: ${unknownHypotheses.join(", ")}`);
      const workKindDefinition = definition.workKinds.find((candidate) => candidate.id === item.kind);
      if (!workKindDefinition) throw new Error(`Planner proposed unknown work kind ${item.kind}`);
      if (item.hypothesisIds.length < (workKindDefinition.minimumHypothesisRefs ?? 0)) {
        throw new Error(`Planner Work ${item.kind} requires at least ${workKindDefinition.minimumHypothesisRefs} Hypothesis reference(s)`);
      }
      const unknownRefs = item.evidenceRefs.filter((ref) => !knownRefs.has(ref));
      if (unknownRefs.length) throw new Error(`Planner referenced unknown Evidence: ${unknownRefs.join(", ")}`);
      const required = [...new Set([...phase.requiredCapabilities, ...item.requiredCapabilities])];
      const unavailable = required.filter((capability) => !available.has(capability));
      if (unavailable.length) throw new Error(`Planner requested unavailable capabilities: ${unavailable.join(", ")}`);
      const pool = definition.agentTopology.workerPools.find((candidate) => candidate.workKinds.includes(item.kind));
      if (!pool || required.some((capability) => !pool.capabilities.includes(capability))) {
        throw new Error(`No Worker pool can execute the proposed ${item.kind} Work`);
      }
      const signature = this.workSignature(item.kind, item.title, item.objective);
      if (signatures.has(signature)) throw new Error(`Planner proposed duplicate Work ${item.title}`);
      signatures.add(signature);
    }
    const requestedWorkIds = new Set<string>();
    for (const change of [...decision.cancellations, ...decision.reprioritizations]) {
      if (requestedWorkIds.has(change.workId)) throw new Error(`Planner requested multiple changes for Work ${change.workId}`);
      requestedWorkIds.add(change.workId);
      const work = run.workItems.find((candidate) => candidate.id === change.workId);
      if (!work || work.status !== "queued") throw new Error(`Planner may change only queued Work; ${change.workId} is unavailable`);
    }
  }

  private applyDecision(runId: string, evaluationId: string, observedPhaseId: string, decision: RunPlannerDecision): number {
    let state = this.runtime.load(runId);
    if (!state || state.status !== "running" || state.activePhaseId !== observedPhaseId || decision.action === "wait") return state?.revision ?? 0;
    for (const [index, cancellation] of decision.cancellations.entries()) {
      state = this.applyCommand(runId, `planner:${evaluationId}:cancel:${index}`, (current) => {
        const work = current.workItems.find((candidate) => candidate.id === cancellation.workId);
        return work?.status === "queued" ? { type: "cancel_work" as const, workId: work.id, reason: `Planner: ${cancellation.reason}`, at: this.now() } : undefined;
      });
    }
    for (const [index, change] of decision.reprioritizations.entries()) {
      state = this.applyCommand(runId, `planner:${evaluationId}:priority:${index}`, (current) => {
        const work = current.workItems.find((candidate) => candidate.id === change.workId);
        return work?.status === "queued" && work.priority !== change.priority
          ? { type: "reprioritize_work" as const, workId: work.id, priority: change.priority, reason: `Planner: ${change.reason}`, at: this.now() }
          : undefined;
      });
    }
    for (const [index, item] of decision.proposals.entries()) {
      state = this.applyCommand(runId, `planner:${evaluationId}:proposal:${index}`, (current) => {
        if (current.activePhaseId !== observedPhaseId) return undefined;
        const signature = this.workSignature(item.kind, item.title, item.objective);
        const duplicate = current.workItems.some((work) => !["completed", "blocked", "failed", "cancelled"].includes(work.status)
          && this.workSignature(work.kind, work.title, work.objective) === signature);
        if (duplicate) return undefined;
        return {
          type: "propose_work" as const,
          proposal: {
            id: `planner-work-${evaluationId}-${index}`,
            kind: item.kind, title: item.title, objective: item.objective, priority: item.priority,
            requiredCapabilities: item.requiredCapabilities, hypothesisIds: item.hypothesisIds,
            evidenceRefs: item.evidenceRefs, maxAttempts: item.maxAttempts,
            idempotencyKey: `planner-effect:${evaluationId}:${index}`,
          },
          at: this.now(),
        };
      });
    }
    return state.revision;
  }

  private advanceIfAllowed(runId: string, evaluationId: string, observedPhaseId: string): number | undefined {
    const state = this.runtime.load(runId);
    if (!state || state.status !== "running" || state.activePhaseId !== observedPhaseId) return state?.revision;
    const definition = this.definitions.require(state.definitionKind, state.definitionVersion);
    const phase = definition.phases.find((candidate) => candidate.id === state.activePhaseId)!;
    const unsettled = state.workItems.some((work) => work.phaseId === phase.id && !["completed", "blocked", "failed", "cancelled"].includes(work.status));
    if (unsettled) return undefined;
    const transition = phase.transitions.find((candidate) => transitionAllowed(state, candidate).allowed);
    if (!transition) return undefined;
    return this.applyCommand(runId, `planner:${evaluationId}:advance:${phase.id}`, () => ({ type: "advance_phase", to: transition.to, at: this.now() })).revision;
  }

  private applyCommand(
    runId: string,
    commandId: string,
    create: (state: ScenarioRunState) => Parameters<DurableScenarioRuntime["execute"]>[0]["command"] | undefined,
  ): ScenarioRunState {
    for (let attempt = 0; attempt < this.concurrencyRetries; attempt += 1) {
      const state = this.runtime.load(runId);
      if (!state) throw new Error(`Unknown Planner Run ${runId}`);
      const command = create(state);
      if (!command) return state;
      try {
        return this.runtime.execute({ runId, commandId, expectedRevision: state.revision, command }).state;
      } catch (error) {
        if (!(error instanceof RevisionConflictError) || attempt === this.concurrencyRetries - 1) throw error;
      }
    }
    throw new Error(`Planner command ${commandId} exhausted concurrency retries`);
  }

  private workSignature(kind: WorkKind, title: string, objective: string): string {
    return `${kind}:${title.trim().toLowerCase()}:${objective.trim().toLowerCase()}`;
  }

  private minimumPollInterval(): number {
    const intervals = this.scenarioEvents.listRuns()
      .map((summary) => this.runtime.load(summary.runId))
      .filter((run): run is ScenarioRunState => Boolean(run))
      .map((run) => this.definitions.require(run.definitionKind, run.definitionVersion).agentTopology.planner.pollIntervalMs);
    return intervals.length ? Math.min(...intervals) : 5_000;
  }
}

export function registerRunPlannerRoutes(app: FastifyInstance, store: SqliteRunPlannerStore): void {
  app.get("/api/scenarios/runs/:runId/planner/evaluations", async (request) => {
    const { runId } = z.object({ runId: z.string().min(1) }).parse(request.params);
    return store.list(runId);
  });
}
