import type { EvidenceGraphState, KnowledgeNode } from "@traceforge/evidence-graph";
import { canonicalJson, type ScenarioEvent, type ScenarioRunState } from "@traceforge/orchestration-core";
import type { WorkerModelRequest, WorkerTranscriptEntry } from "@traceforge/worker-runtime";

export * from "./snapshot.js";
export * from "./evaluation.js";
export * from "./wakeup.js";
export * from "./loop.js";

export interface CognitiveContextBudget {
  maximumGraphNodes: number;
  maximumRecentEvents: number;
  maximumRunItems: number;
}

export interface DistilledRunContext {
  run: ScenarioRunState;
  graph: { revision: number; nodes: KnowledgeNode[]; edges: EvidenceGraphState["edges"] };
  recentEvents: ScenarioEvent[];
  manifest: {
    sourceRunRevision: number;
    sourceGraphRevision: number;
    omittedWorkItems: number;
    omittedOutputs: number;
    omittedDirectives: number;
    omittedGraphNodes: number;
    omittedEvents: number;
  };
  semanticFingerprint: string;
}

export interface DistilledWorkerContext {
  run: WorkerModelRequest["assignment"]["runContext"];
  work: WorkerModelRequest["assignment"]["work"];
  worker: Pick<WorkerModelRequest["worker"], "id" | "roles" | "capabilities">;
  tools: WorkerModelRequest["tools"];
  toolResolution: WorkerModelRequest["toolResolution"];
  transcript: WorkerTranscriptEntry[];
  steering: string[];
  manifest: { omittedTranscriptEntries: number; omittedTranscriptCharacters: number };
}

function visibleNodes(run: ScenarioRunState, graph: EvidenceGraphState): KnowledgeNode[] {
  return graph.nodes.filter((node) => node.runId === null || node.runId === run.id);
}

function semanticRun(run: ScenarioRunState) {
  return {
    id: run.id,
    caseId: run.caseId,
    status: run.status,
    goal: run.goal,
    scopeRef: run.scopeRef,
    activePhaseId: run.activePhaseId,
    availableCapabilities: run.availableCapabilities,
    workItems: run.workItems.map((item) => ({
      id: item.id,
      phaseId: item.phaseId,
      kind: item.kind,
      title: item.title,
      objective: item.objective,
      status: ["queued", "running"].includes(item.status) ? "active" : item.status,
      priority: item.priority,
      requiredCapabilities: item.requiredCapabilities,
      hypothesisIds: item.hypothesisIds,
      evidenceRefs: item.evidenceRefs,
      resultSummary: item.resultSummary,
      error: item.error,
    })),
    outputs: run.outputs.map((output) => ({ id: output.id, phaseId: output.phaseId, kind: output.kind, summary: output.summary, refs: output.refs })),
    directives: run.directives.map((directive) => ({
      id: directive.id,
      kind: directive.kind,
      targetWorkId: directive.targetWorkId,
      instruction: directive.instruction,
      rationale: directive.rationale,
    })),
  };
}

export class CognitiveContextDistiller {
  distillRun(
    run: ScenarioRunState,
    graph: EvidenceGraphState,
    events: ScenarioEvent[],
    budget: CognitiveContextBudget,
  ): DistilledRunContext {
    for (const [name, value] of Object.entries(budget)) {
      if (!Number.isInteger(value) || value < 1) throw new Error(`Context budget ${name} must be a positive integer`);
    }
    const allNodes = visibleNodes(run, graph);
    const nodes = allNodes.slice(-budget.maximumGraphNodes);
    const nodeIds = new Set(nodes.map((node) => node.id));
    const edges = graph.edges.filter((edge) => nodeIds.has(edge.sourceId) && nodeIds.has(edge.targetId));
    const workItems = run.workItems.slice(-budget.maximumRunItems);
    const outputs = run.outputs.slice(-budget.maximumRunItems);
    const directives = run.directives.slice(-budget.maximumRunItems);
    const recentEvents = events.slice(-budget.maximumRecentEvents);
    const distilledRun: ScenarioRunState = { ...run, workItems, outputs, directives };
    const semanticNodes = nodes.map((node) => ({
      id: node.id,
      runId: node.runId,
      kind: node.kind,
      title: node.title,
      summary: node.summary,
      status: node.status,
      confidence: node.confidence,
      properties: node.properties,
      source: node.source,
      version: node.version,
    }));
    const semanticFingerprint = canonicalJson({
      run: semanticRun(distilledRun),
      nodes: semanticNodes,
      edges: edges.map((edge) => ({ id: edge.id, sourceId: edge.sourceId, targetId: edge.targetId, relation: edge.relation, rationale: edge.rationale })),
    });
    return {
      run: distilledRun,
      graph: { revision: graph.revision, nodes, edges },
      recentEvents,
      manifest: {
        sourceRunRevision: run.revision,
        sourceGraphRevision: graph.revision,
        omittedWorkItems: run.workItems.length - workItems.length,
        omittedOutputs: run.outputs.length - outputs.length,
        omittedDirectives: run.directives.length - directives.length,
        omittedGraphNodes: allNodes.length - nodes.length,
        omittedEvents: events.length - recentEvents.length,
      },
      semanticFingerprint,
    };
  }

  distillWorker(request: WorkerModelRequest, maximumTranscriptEntries = 12, maximumTranscriptCharacters = 24_000): DistilledWorkerContext {
    if (maximumTranscriptEntries < 1 || maximumTranscriptCharacters < 256) throw new Error("Worker context budget is invalid");
    const selected: WorkerTranscriptEntry[] = [];
    let characters = 0;
    let omittedCharacters = 0;
    for (const entry of [...request.transcript].reverse()) {
      if (selected.length >= maximumTranscriptEntries || characters + entry.summary.length > maximumTranscriptCharacters) {
        omittedCharacters += entry.summary.length;
        continue;
      }
      selected.unshift(entry);
      characters += entry.summary.length;
    }
    return {
      run: request.assignment.runContext,
      work: request.assignment.work,
      worker: { id: request.worker.id, roles: request.worker.roles, capabilities: request.worker.capabilities },
      tools: request.tools,
      toolResolution: request.toolResolution,
      transcript: selected,
      steering: [...new Set(request.steering)].slice(-maximumTranscriptEntries),
      manifest: {
        omittedTranscriptEntries: request.transcript.length - selected.length,
        omittedTranscriptCharacters: omittedCharacters,
      },
    };
  }
}
