import type { EvidenceGraphState, KnowledgeNode } from "@traceforge/evidence-graph";
import { createHash } from "node:crypto";
import { canonicalJson, type ScenarioEvent, type ScenarioRunState } from "@traceforge/orchestration-core";
import type { WorkerModelRequest, WorkerTranscriptEntry } from "@traceforge/worker-runtime";

export * from "./snapshot.js";
export * from "./shared-progress.js";
export * from "./evaluation.js";
export * from "./wakeup.js";
export * from "./loop.js";
export * from "./compaction.js";
export * from "./recall.js";
export * from "./anchors.js";
export * from "./lineage.js";
export * from "./run-planning.js";
export * from "./run-observation.js";
export * from "./structured-worker-model.js";

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
  if (graph.caseId !== run.caseId) throw new Error("Context graph Case mismatch");
  // Inquiry nodes project durable Work state; they are not evidence or a second ledger.
  const inquiries:KnowledgeNode[]=run.workItems.filter(work=>work.inquiry).map(work=>({id:`inquiry:${run.id}:${work.inquiry!.id}`,caseId:run.caseId,runId:run.id,
    kind:"inquiry",title:"Worker inquiry",summary:work.inquiry!.question,status:work.status==="cancelled"?"invalidated":work.inquiry!.status==="answered"?"resolved":"active",confidence:0,
    properties:{workId:work.id,...work.inquiry},source:null,version:1,createdAt:work.createdAt,updatedAt:run.updatedAt,invalidatedAt:null,invalidationReason:null}));
  return [...graph.nodes.filter((node) => node.kind!=="inquiry" && node.caseId === run.caseId && (node.runId === null || node.runId === run.id)),...inquiries];
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
      inquiry:item.inquiry,
    })),
    outputs: run.outputs.map((output) => ({ id: output.id, phaseId: output.phaseId, kind: output.kind, summary: output.summary, refs: output.refs })),
    directives: run.directives.map((directive) => ({
      id: directive.id,
      kind: directive.kind,
      targetWorkId: directive.targetWorkId,
      instruction: directive.instruction,
      rationale: directive.rationale,
      issuedBy: directive.issuedBy,
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
    const visibleIds = new Set(allNodes.map(node => node.id));
    const nodes = allNodes.slice(-budget.maximumGraphNodes);
    const nodeIds = new Set(nodes.map((node) => node.id));
    const edges = graph.edges.filter((edge) => nodeIds.has(edge.sourceId) && nodeIds.has(edge.targetId));
    const pendingInquiries=run.workItems.filter(item=>item.status==="blocked"&&item.inquiry?.status==="pending").slice(0,budget.maximumRunItems);
    const remaining=budget.maximumRunItems-pendingInquiries.length;
    const workItems = [...pendingInquiries,...(remaining>0?run.workItems.filter(item=>!pendingInquiries.includes(item)).slice(-remaining):[])];
    const outputs = run.outputs.slice(-budget.maximumRunItems);
    const directives = run.directives.slice(-budget.maximumRunItems);
    const recentEvents = events.slice(-budget.maximumRecentEvents);
    const distilledRun: ScenarioRunState = { ...run, workItems, outputs, directives };
    // Wake-up identity covers all visible durable facts, not just the prompt
    // window. An older changed fact must still wake a consumer after compaction.
    const semanticNodes = allNodes.map((node) => ({
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
    const semanticFingerprint = createHash("sha256").update(canonicalJson({
      run: semanticRun(run),
      nodes: semanticNodes,
      edges: graph.edges.filter((edge) => visibleIds.has(edge.sourceId) && visibleIds.has(edge.targetId))
        .map((edge) => ({ id: edge.id, sourceId: edge.sourceId, targetId: edge.targetId, relation: edge.relation, rationale: edge.rationale })),
    })).digest("hex");
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

  distillWorker(request: WorkerModelRequest, maximumTranscriptEntries = 12, maximumTranscriptCharacters = 24_000, maximumRecallCharacters = 8_000): DistilledWorkerContext {
    if (maximumTranscriptEntries < 1 || maximumTranscriptCharacters < 256) throw new Error("Worker context budget is invalid");
    const selected: WorkerTranscriptEntry[] = [];
    let characters = 0;
    let omittedCharacters = 0;
    // Reserve part of the SAME total budget for the latest original-text page;
    // ordinary observations cannot evict it. This never makes context unbounded.
    const recall=[...request.transcript].reverse().find(entry=>entry.kind==="tool"&&entry.summary.startsWith("[recall-page]"));
    if(!Number.isSafeInteger(maximumRecallCharacters)||maximumRecallCharacters<1)throw new Error("Invalid recall budget");
    if(recall){const budget=Math.min(maximumRecallCharacters,Math.floor(maximumTranscriptCharacters/3));selected.push({...recall,summary:recall.summary.slice(0,budget)});characters=selected[0]!.summary.length;omittedCharacters+=recall.summary.length-characters;}
    for (const entry of [...request.transcript].reverse()) {
      if(entry===recall)continue;
      if (selected.length >= maximumTranscriptEntries || characters + entry.summary.length > maximumTranscriptCharacters) {
        omittedCharacters += entry.summary.length;
        continue;
      }
      selected.unshift(entry);
      characters += entry.summary.length;
    }
    selected.sort((a,b)=>a.turn-b.turn);
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
export * from "./semantic-compactor.js";
export * from "./rolling-context.js";
