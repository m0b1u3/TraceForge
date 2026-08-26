import type {
  EvidenceGraphCommand,
  EvidenceGraphCommandResult,
  EvidenceGraphEvent,
  EvidenceGraphState,
  KnowledgeEdge,
  KnowledgeNode,
  KnowledgeNodeKind,
  KnowledgeNodeStatus,
  KnowledgeRelation,
} from "./model.js";

const allowedInitialStatuses: Record<KnowledgeNodeKind, KnowledgeNodeStatus[]> = {
  entity: ["active"],
  fact: ["active"],
  evidence: ["active"],
  hypothesis: ["candidate", "active"],
  task: ["candidate", "active", "blocked"],
  validation_conclusion: ["candidate", "active", "refuted", "resolved"],
  finding: ["candidate", "validating"],
  limitation: ["active", "resolved"],
};

const allowedTransitions: Record<KnowledgeNodeKind, Partial<Record<KnowledgeNodeStatus, KnowledgeNodeStatus[]>>> = {
  entity: { active: ["needs_review", "invalidated"], needs_review: ["active", "invalidated"] },
  fact: { active: ["needs_review", "invalidated"], needs_review: ["active", "invalidated"] },
  evidence: { active: ["invalidated"], needs_review: ["active", "invalidated"] },
  hypothesis: {
    candidate: ["active", "refuted", "blocked", "needs_review", "invalidated"],
    active: ["validating", "refuted", "blocked", "resolved", "needs_review", "invalidated"],
    validating: ["resolved", "refuted", "blocked", "needs_review", "invalidated"],
    needs_review: ["active", "refuted", "blocked", "invalidated"],
  },
  task: {
    candidate: ["active", "blocked", "resolved", "invalidated"], active: ["blocked", "resolved", "needs_review", "invalidated"],
    blocked: ["active", "resolved", "invalidated"], needs_review: ["active", "blocked", "resolved", "invalidated"],
  },
  validation_conclusion: {
    candidate: ["active", "resolved", "refuted", "invalidated"], active: ["resolved", "refuted", "needs_review", "invalidated"],
    resolved: ["needs_review", "invalidated"], refuted: ["needs_review", "invalidated"], needs_review: ["active", "resolved", "refuted", "invalidated"],
  },
  finding: {
    candidate: ["validating", "refuted", "blocked", "invalidated"],
    validating: ["verified", "refuted", "blocked", "needs_review", "invalidated"],
    verified: ["needs_review", "invalidated"], needs_review: ["validating", "refuted", "blocked", "invalidated"],
    blocked: ["validating", "refuted", "invalidated"],
  },
  limitation: { active: ["resolved", "invalidated"], resolved: ["active", "invalidated"] },
};

const relationKinds: Record<KnowledgeRelation, { sources: KnowledgeNodeKind[]; targets: KnowledgeNodeKind[] }> = {
  supports: { sources: ["evidence", "fact"], targets: ["hypothesis", "validation_conclusion", "finding"] },
  refutes: { sources: ["evidence", "fact"], targets: ["hypothesis", "validation_conclusion", "finding"] },
  derived_from: { sources: ["hypothesis", "validation_conclusion", "finding", "fact"], targets: ["entity", "fact", "hypothesis", "evidence", "task", "validation_conclusion"] },
  generated_by: { sources: ["fact", "evidence", "hypothesis", "validation_conclusion", "finding", "limitation"], targets: ["task"] },
  validates: { sources: ["validation_conclusion"], targets: ["finding"] },
  targets: { sources: ["task", "hypothesis"], targets: ["entity", "fact", "hypothesis", "finding"] },
  depends_on: { sources: ["task", "hypothesis", "finding", "validation_conclusion"], targets: ["entity", "fact", "hypothesis", "evidence", "task"] },
  impacts: { sources: ["finding"], targets: ["entity"] },
  limits: { sources: ["limitation"], targets: ["task", "hypothesis", "validation_conclusion", "finding"] },
  supersedes: { sources: ["entity", "fact", "hypothesis", "evidence", "task", "validation_conclusion", "finding", "limitation"], targets: ["entity", "fact", "hypothesis", "evidence", "task", "validation_conclusion", "finding", "limitation"] },
};

export function evolveEvidenceGraph(state: EvidenceGraphState | undefined, event: EvidenceGraphEvent): EvidenceGraphState {
  if (event.type === "graph_initialized") {
    if (state) throw new Error(`Evidence Graph ${event.caseId} is already initialized`);
    return { caseId: event.caseId, revision: 1, nodes: [], edges: [], createdAt: event.at, updatedAt: event.at };
  }
  if (!state) throw new Error(`Cannot apply ${event.type} before graph initialization`);
  const revision = state.revision + 1;
  if (event.type === "node_added") return { ...state, nodes: [...state.nodes, event.node], revision, updatedAt: event.at };
  if (event.type === "edge_added") return { ...state, edges: [...state.edges, event.edge], revision, updatedAt: event.at };
  return {
    ...state,
    nodes: state.nodes.map((node) => node.id !== event.nodeId ? node : {
      ...node,
      status: event.type === "node_invalidated" ? "invalidated" : event.status,
      version: node.version + 1,
      updatedAt: event.at,
      invalidatedAt: event.type === "node_invalidated" ? event.at : node.invalidatedAt,
      invalidationReason: event.reason,
    }),
    revision,
    updatedAt: event.at,
  };
}

export class EvidenceGraphKernel {
  execute(state: EvidenceGraphState | undefined, command: EvidenceGraphCommand): EvidenceGraphCommandResult {
    const events = this.decide(state, command);
    let next = state;
    for (const event of events) next = evolveEvidenceGraph(next, event);
    if (!next) throw new Error("Evidence Graph command emitted no state");
    return { state: next, events };
  }

  private decide(state: EvidenceGraphState | undefined, command: EvidenceGraphCommand): EvidenceGraphEvent[] {
    if (command.type === "initialize_graph") {
      if (state) throw new Error(`Evidence Graph ${command.caseId} already exists`);
      return [{ type: "graph_initialized", caseId: command.caseId, at: command.at }];
    }
    if (!state) throw new Error("Evidence Graph has not been initialized");
    if (command.type === "add_node") {
      if (command.node.caseId !== state.caseId) throw new Error("Knowledge node belongs to another Case");
      if (state.nodes.some((node) => node.id === command.node.id)) throw new Error(`Duplicate Knowledge node ${command.node.id}`);
      if (!command.node.title.trim() || !command.node.summary.trim()) throw new Error("Knowledge nodes require a title and summary");
      if (command.node.confidence < 0 || command.node.confidence > 1) throw new Error("Knowledge node confidence must be between 0 and 1");
      if (!allowedInitialStatuses[command.node.kind].includes(command.node.status)) throw new Error(`Invalid initial ${command.node.kind} status ${command.node.status}`);
      if (command.node.kind === "evidence" && !command.node.source) throw new Error("Evidence nodes require an auditable source");
      if (command.node.kind !== "evidence" && command.node.source) throw new Error("Only Evidence nodes may carry source material");
      if (command.node.source && (!command.node.source.ref.trim() || !command.node.source.producerId.trim() || !Number.isFinite(Date.parse(command.node.source.observedAt)))) {
        throw new Error("Evidence source requires a ref, producer and valid observation time");
      }
      const node: KnowledgeNode = { ...command.node, version: 1, createdAt: command.at, updatedAt: command.at, invalidatedAt: null, invalidationReason: null };
      return [{ type: "node_added", node, at: command.at }];
    }
    if (command.type === "add_edge") {
      if (state.edges.some((edge) => edge.id === command.edge.id)) throw new Error(`Duplicate Knowledge edge ${command.edge.id}`);
      if (command.edge.sourceId === command.edge.targetId) throw new Error("Knowledge edges cannot reference the same source and target");
      const source = requireNode(state, command.edge.sourceId);
      const target = requireNode(state, command.edge.targetId);
      if (source.status === "invalidated" || target.status === "invalidated") throw new Error("Knowledge edges cannot attach to invalidated nodes");
      const allowed = relationKinds[command.edge.relation];
      if (!allowed.sources.includes(source.kind) || !allowed.targets.includes(target.kind)) {
        throw new Error(`Relation ${command.edge.relation} cannot connect ${source.kind} to ${target.kind}`);
      }
      if (command.edge.relation === "supersedes" && source.kind !== target.kind) throw new Error("Supersedes requires nodes of the same kind");
      if (!command.edge.rationale.trim()) throw new Error("Knowledge edges require a rationale");
      const edge: KnowledgeEdge = { ...command.edge, caseId: state.caseId, createdAt: command.at };
      return [{ type: "edge_added", edge, at: command.at }];
    }
    const node = requireNode(state, command.nodeId);
    if (!command.reason.trim()) throw new Error("Lifecycle changes require a reason");
    if (command.type === "transition_node") {
      if (node.status === command.status) throw new Error(`Knowledge node ${node.id} is already ${command.status}`);
      if (!(allowedTransitions[node.kind][node.status] ?? []).includes(command.status)) {
        throw new Error(`${node.kind} cannot transition from ${node.status} to ${command.status}`);
      }
      if (node.kind === "finding" && command.status === "verified") this.assertVerifiableFinding(state, node);
      return [{ type: "node_status_changed", nodeId: node.id, status: command.status, reason: command.reason, at: command.at }];
    }
    if (node.status === "invalidated") throw new Error(`Knowledge node ${node.id} is already invalidated`);
    return this.invalidationEvents(state, node.id, command.reason, command.at);
  }

  private assertVerifiableFinding(state: EvidenceGraphState, finding: KnowledgeNode): void {
    const conclusionIds = state.edges.filter((edge) => edge.relation === "validates" && edge.targetId === finding.id).map((edge) => edge.sourceId);
    const conclusions = conclusionIds.map((id) => requireNode(state, id)).filter((node) => ["active", "resolved"].includes(node.status));
    if (conclusions.length === 0) throw new Error("Verified Finding requires an active validation conclusion");
    const completeConclusion = conclusions.find((node) => ["causalMechanism", "reproduction", "concreteImpact"].every((key) => typeof node.properties[key] === "string" && String(node.properties[key]).trim()));
    if (!completeConclusion) throw new Error("Verified Finding requires causal mechanism, reproduction and concrete impact");
    const supportedTargets = new Set([finding.id, ...conclusions.map((node) => node.id)]);
    const evidence = state.edges
      .filter((edge) => edge.relation === "supports" && supportedTargets.has(edge.targetId))
      .map((edge) => requireNode(state, edge.sourceId))
      .filter((node) => node.kind === "evidence" && node.status === "active" && node.source);
    const distinctSignals = new Set(evidence.map((node) => `${node.source!.type}:${node.source!.ref}`));
    if (distinctSignals.size < 2) throw new Error("Verified Finding requires at least two distinct active evidence signals");
    if (!state.edges.some((edge) => edge.sourceId === finding.id && edge.relation === "derived_from" && requireNode(state, edge.targetId).kind === "hypothesis")) {
      throw new Error("Verified Finding requires a traceable originating Hypothesis");
    }
    if (!state.edges.some((edge) => edge.sourceId === finding.id && edge.relation === "impacts" && requireNode(state, edge.targetId).kind === "entity")) {
      throw new Error("Verified Finding requires a concrete impacted entity");
    }
  }

  private invalidationEvents(state: EvidenceGraphState, nodeId: string, reason: string, at: string): EvidenceGraphEvent[] {
    const events: EvidenceGraphEvent[] = [{ type: "node_invalidated", nodeId, reason, at }];
    const affected = new Set([nodeId]);
    const queue = [nodeId];
    while (queue.length) {
      const invalidatedDependencyId = queue.shift()!;
      const dependentIds = state.edges.flatMap((edge) => {
        if (edge.sourceId === invalidatedDependencyId && ["supports", "refutes", "validates"].includes(edge.relation)) {
          return [edge.targetId];
        }
        if (edge.targetId === invalidatedDependencyId && ["derived_from", "depends_on", "generated_by", "targets", "impacts"].includes(edge.relation)) {
          return [edge.sourceId];
        }
        return [];
      });
      for (const dependentId of dependentIds) {
        if (affected.has(dependentId)) continue;
        affected.add(dependentId);
        const dependent = requireNode(state, dependentId);
        if (!["invalidated", "needs_review"].includes(dependent.status)) {
          events.push({ type: "node_status_changed", nodeId: dependentId, status: "needs_review", reason: `Dependency ${invalidatedDependencyId} invalidated: ${reason}`, at });
        }
        queue.push(dependentId);
      }
    }
    return events;
  }
}

function requireNode(state: EvidenceGraphState, id: string): KnowledgeNode {
  const node = state.nodes.find((candidate) => candidate.id === id);
  if (!node) throw new Error(`Unknown Knowledge node ${id}`);
  return node;
}
