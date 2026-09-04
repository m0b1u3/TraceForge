import type { EvidenceGraphState } from "@traceforge/evidence-graph";
import type { ScenarioEvent, ScenarioRunState } from "@traceforge/orchestration-core";
import type { ContextCompactionPolicy } from "./compaction.js";
import type { CognitiveContextDistiller } from "./index.js";

export type CognitiveContextRole = "planner" | "observer" | "worker";
export interface ContextLineageSource { key: string; workId: string; fingerprint: string; refs: string[]; valid: boolean }
export interface ContextLineageDerivation { target_kind: "work" | "directive"; target_id: string; snapshot_id: string; sources_json: string }
export interface RunContextInput { run: ScenarioRunState; graph: EvidenceGraphState; recentEvents: ScenarioEvent[] }
export interface ContextLineageManifest {
  version: 1; role: CognitiveContextRole; fingerprint: string; sources: ContextLineageSource[]; parents: string[];
  withheldWorkIds: string[]; withheldDirectiveIds: string[]; withheldNodeIds: string[]; omittedEvents: number;
}
export interface RunContextProjection extends RunContextInput { manifest: { contextLineage: ContextLineageManifest } }
export interface RunContextProjectionPort {
  prepare(input: RunContextInput, role: "planner" | "observer"): Promise<RunContextProjection>;
}

export const CONTEXT_WITHHELD_TEXT = "Context-derived text withheld: source authorization or lifecycle is no longer current. Reassess from available evidence; original retained for audit.";

/** Pure structural projection. Persistence adapters supply already-validated lineage facts. */
export function projectRunContextLineage(input: RunContextInput, facts: {
  role: CognitiveContextRole;
  fingerprint: string;
  sources: ContextLineageSource[];
  derived: ContextLineageDerivation[];
}): RunContextProjection {
  if (input.graph.caseId !== input.run.caseId || input.graph.nodes.length > 2048 || input.graph.edges.length > 4096
    || input.recentEvents.length > 4096 || input.run.workItems.length > 512 || input.run.outputs.length > 512 || input.run.directives.length > 512
    || facts.sources.length > 256 || facts.derived.length > 512) throw new Error("Invalid Run context lineage bounds or Case");
  const valid = new Set(facts.sources.filter((source) => source.valid).map((source) => source.key));
  const bad = facts.sources.filter((source) => !source.valid);
  const workIds = new Set(bad.map((source) => source.workId)), directiveIds = new Set<string>();
  for (const row of facts.derived) {
    const keys = JSON.parse(row.sources_json) as unknown;
    if (!Array.isArray(keys) || keys.length > 256 || keys.some((key) => typeof key !== "string")) throw new Error("Invalid context derivation");
    if (keys.some((key) => !valid.has(key))) (row.target_kind === "work" ? workIds : directiveIds).add(row.target_id);
  }
  for (let iteration = 0; iteration < input.run.workItems.length; iteration += 1) {
    let changed = false;
    for (const work of input.run.workItems) if (work.retryOf && workIds.has(work.retryOf) && !workIds.has(work.id)) {
      workIds.add(work.id); changed = true;
    }
    if (!changed) break;
  }
  if (bad.length) for (const directive of input.run.directives) {
    if (!facts.derived.some((item) => item.target_kind === "directive" && item.target_id === directive.id)) directiveIds.add(directive.id);
  }
  const tainted = new Set([...bad.flatMap((source) => [source.key, ...source.refs]), ...workIds, ...directiveIds,
    ...input.run.outputs.filter((output) => workIds.has(output.producedByWorkId)).flatMap((output) => [output.id, ...output.refs])]);
  const nodeIds = new Set<string>();
  const visibleNodes = input.graph.nodes.filter((node) => node.caseId === input.run.caseId && (node.runId === null || node.runId === input.run.id));
  for (const node of visibleNodes) if (node.source && tainted.has(node.source.ref)) nodeIds.add(node.id);
  for (let iteration = 0; iteration < visibleNodes.length; iteration += 1) {
    let changed = false;
    for (const edge of input.graph.edges) {
      const reverse = ["derived_from", "depends_on"].includes(edge.relation);
      const source = reverse ? edge.targetId : edge.sourceId, target = reverse ? edge.sourceId : edge.targetId;
      if (nodeIds.has(source) && !nodeIds.has(target)) { nodeIds.add(target); changed = true; }
    }
    if (!changed) break;
  }
  const request = structuredClone(input);
  request.run.workItems = request.run.workItems.map((work) => workIds.has(work.id) ? {
    ...work, title: CONTEXT_WITHHELD_TEXT, objective: CONTEXT_WITHHELD_TEXT, resultSummary: null, error: null, latestCheckpoint: null,
    pendingApproval: null, approvalHistory: [],
  } : work);
  request.run.outputs = request.run.outputs.map((output) => workIds.has(output.producedByWorkId) ? { ...output, summary: CONTEXT_WITHHELD_TEXT } : output);
  request.run.directives = request.run.directives.filter((directive) => !directiveIds.has(directive.id));
  request.graph.nodes = visibleNodes.map((node) => nodeIds.has(node.id) ? {
    ...structuredClone(node), title: CONTEXT_WITHHELD_TEXT, summary: CONTEXT_WITHHELD_TEXT, properties: {}, source: null,
  } : structuredClone(node));
  const visibleIds = new Set(request.graph.nodes.map((node) => node.id));
  request.graph.edges = request.graph.edges.filter((edge) => visibleIds.has(edge.sourceId) && visibleIds.has(edge.targetId))
    .map((edge) => nodeIds.has(edge.sourceId) || nodeIds.has(edge.targetId) ? { ...edge, rationale: CONTEXT_WITHHELD_TEXT } : edge);
  if (bad.length || workIds.size || directiveIds.size) request.recentEvents = [];
  const contextLineage: ContextLineageManifest = { version: 1, role: facts.role, fingerprint: facts.fingerprint,
    sources: structuredClone(facts.sources), parents: [...new Set(facts.derived.map((item) => item.snapshot_id))],
    withheldWorkIds: [...workIds], withheldDirectiveIds: [...directiveIds], withheldNodeIds: [...nodeIds],
    omittedEvents: input.recentEvents.length - request.recentEvents.length };
  return { ...request, manifest: { contextLineage } };
}

/** Shared role assembly: projection precedes compaction and identifiers are retained. */
export async function assembleRunContext(input: RunContextInput & { maximumGraphNodes: number; maximumRunItems: number },
  role: "planner" | "observer", distiller: CognitiveContextDistiller, policy?: RunContextProjectionPort, compaction?: ContextCompactionPolicy) {
  const projection = policy ? await policy.prepare(input, role) : { ...input, manifest: {} };
  const context = distiller.distillRun(projection.run, projection.graph, projection.recentEvents, {
    maximumGraphNodes: compaction ? Math.max(1, projection.graph.nodes.length) : input.maximumGraphNodes,
    maximumRunItems: compaction ? Math.max(1, projection.run.workItems.length, projection.run.outputs.length, projection.run.directives.length) : input.maximumRunItems,
    maximumRecentEvents: projection.recentEvents.length || 1,
  });
  return { ...context, manifest: { ...context.manifest, ...projection.manifest } };
}
