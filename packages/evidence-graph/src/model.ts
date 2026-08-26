export type KnowledgeNodeKind =
  | "entity"
  | "fact"
  | "hypothesis"
  | "evidence"
  | "task"
  | "validation_conclusion"
  | "finding"
  | "limitation";

export type KnowledgeNodeStatus =
  | "active"
  | "candidate"
  | "validating"
  | "verified"
  | "refuted"
  | "blocked"
  | "resolved"
  | "needs_review"
  | "invalidated";

export type EvidenceSourceType = "tool_result" | "traffic" | "artifact" | "human" | "code" | "external_reference";

export interface EvidenceSource {
  type: EvidenceSourceType;
  ref: string;
  observedAt: string;
  producerId: string;
  integrity?: { algorithm: "sha256"; digest: string };
}

export interface KnowledgeNode {
  id: string;
  caseId: string;
  runId: string | null;
  kind: KnowledgeNodeKind;
  title: string;
  summary: string;
  status: KnowledgeNodeStatus;
  confidence: number;
  properties: Record<string, unknown>;
  source: EvidenceSource | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  invalidatedAt: string | null;
  invalidationReason: string | null;
}

export type KnowledgeRelation =
  | "supports"
  | "refutes"
  | "derived_from"
  | "generated_by"
  | "validates"
  | "targets"
  | "depends_on"
  | "impacts"
  | "limits"
  | "supersedes";

export interface KnowledgeEdge {
  id: string;
  caseId: string;
  sourceId: string;
  targetId: string;
  relation: KnowledgeRelation;
  rationale: string;
  createdAt: string;
}

export interface EvidenceGraphState {
  caseId: string;
  revision: number;
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
  createdAt: string;
  updatedAt: string;
}

export type EvidenceGraphCommand =
  | { type: "initialize_graph"; caseId: string; at: string }
  | { type: "add_node"; node: Omit<KnowledgeNode, "version" | "createdAt" | "updatedAt" | "invalidatedAt" | "invalidationReason">; at: string }
  | { type: "add_edge"; edge: Omit<KnowledgeEdge, "caseId" | "createdAt">; at: string }
  | { type: "transition_node"; nodeId: string; status: KnowledgeNodeStatus; reason: string; at: string }
  | { type: "invalidate_node"; nodeId: string; reason: string; at: string };

export type EvidenceGraphEvent =
  | { type: "graph_initialized"; caseId: string; at: string }
  | { type: "node_added"; node: KnowledgeNode; at: string }
  | { type: "edge_added"; edge: KnowledgeEdge; at: string }
  | { type: "node_status_changed"; nodeId: string; status: KnowledgeNodeStatus; reason: string; at: string }
  | { type: "node_invalidated"; nodeId: string; reason: string; at: string };

export interface EvidenceGraphCommandEnvelope {
  commandId: string;
  caseId: string;
  expectedRevision: number;
  command: EvidenceGraphCommand;
}

export interface EvidenceGraphCommandResult {
  state: EvidenceGraphState;
  events: EvidenceGraphEvent[];
  idempotentReplay?: boolean;
}
