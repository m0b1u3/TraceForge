import type Database from "better-sqlite3";
import { z } from "zod";
import type { EvidenceGraphCommand, EvidenceSource, KnowledgeNode } from "@traceforge/evidence-graph";
import type { ExecutionToolAdapter, ToolExecutionResult } from "@traceforge/worker-runtime";
import { EvidenceGraphRevisionConflictError, SqliteEvidenceGraphStore } from "./evidence-graph-store.js";

export const KNOWLEDGE_GRAPH_CAPABILITIES = {
  read: "knowledge.graph.read",
  write: "knowledge.graph.write",
} as const;

const kind = z.enum(["entity", "fact", "hypothesis", "evidence", "task", "validation_conclusion", "finding", "limitation"]);
const status = z.enum(["active", "candidate", "validating", "verified", "refuted", "blocked", "resolved", "needs_review", "invalidated"]);
const relation = z.enum(["supports", "refutes", "derived_from", "generated_by", "validates", "targets", "depends_on", "impacts", "limits", "supersedes"]);
const mutation = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("add_node"),
    node: z.object({
      id: z.string().min(1), kind, title: z.string().min(1), summary: z.string().min(1), status,
      confidence: z.number().min(0).max(1), properties: z.record(z.unknown()).default({}),
      source: z.object({ type: z.enum(["tool_result", "traffic", "artifact"]), ref: z.string().min(1) }).nullable().default(null),
    }),
  }),
  z.object({ type: z.literal("add_edge"), edge: z.object({
    id: z.string().min(1), sourceId: z.string().min(1), targetId: z.string().min(1), relation, rationale: z.string().min(1),
  }) }),
  z.object({ type: z.literal("transition_node"), nodeId: z.string().min(1), status, reason: z.string().min(1) }),
  z.object({ type: z.literal("invalidate_node"), nodeId: z.string().min(1), reason: z.string().min(1) }),
]);

type ToolContext = Parameters<ExecutionToolAdapter["execute"]>[1];

export class EvidenceGraphSnapshotTool implements ExecutionToolAdapter {
  readonly name = "knowledge.graph.snapshot";
  readonly description = "Read a bounded, typed snapshot of the assigned Case Evidence Graph, including lifecycle state and traceable relations.";
  readonly inputSchema = {
    type: "object",
    properties: {
      limit: { type: "integer", minimum: 1, maximum: 200 },
      kinds: { type: "array", items: { enum: kind.options }, uniqueItems: true },
      statuses: { type: "array", items: { enum: status.options }, uniqueItems: true },
    },
    additionalProperties: false,
  };
  readonly requiredCapabilities = [KNOWLEDGE_GRAPH_CAPABILITIES.read];
  readonly permissionRequirements = {};
  readonly risk = "read_only" as const;
  readonly timeoutMs = 5_000;

  constructor(private readonly store: SqliteEvidenceGraphStore, private readonly now: () => string = () => new Date().toISOString()) {}

  async execute(input: unknown, context: ToolContext): Promise<ToolExecutionResult> {
    const parsed = z.object({ limit: z.number().int().min(1).max(200).default(100), kinds: z.array(kind).optional(), statuses: z.array(status).optional() }).parse(input ?? {});
    const state = this.store.ensure(context.caseId, this.now());
    const nodes = state.nodes
      .filter((node) => (!parsed.kinds || parsed.kinds.includes(node.kind)) && (!parsed.statuses || parsed.statuses.includes(node.status)))
      .slice(-parsed.limit);
    const ids = new Set(nodes.map((node) => node.id));
    const edges = state.edges.filter((edge) => ids.has(edge.sourceId) && ids.has(edge.targetId));
    return {
      status: "succeeded",
      summary: `Loaded ${nodes.length} Knowledge nodes and ${edges.length} relations at graph revision ${state.revision}`,
      raw: JSON.stringify({ caseId: state.caseId, revision: state.revision, nodes, edges }),
      refs: nodes.map((node) => `knowledge-node:${node.id}`),
      retryable: false,
      metadata: { graphRevision: state.revision },
    };
  }
}

export class EvidenceGraphMutateTool implements ExecutionToolAdapter {
  readonly name = "knowledge.graph.mutate";
  readonly description = "Apply one typed, auditable Evidence Graph mutation. Evidence sources must reference persisted tool receipts, traffic, or artifacts.";
  readonly inputSchema = {
    oneOf: [
      {
        type: "object", required: ["type", "node"], additionalProperties: false,
        properties: {
          type: { const: "add_node" },
          node: {
            type: "object", required: ["id", "kind", "title", "summary", "status", "confidence", "properties", "source"], additionalProperties: false,
            properties: {
              id: { type: "string", minLength: 1 }, kind: { enum: kind.options }, title: { type: "string", minLength: 1 },
              summary: { type: "string", minLength: 1 }, status: { enum: status.options }, confidence: { type: "number", minimum: 0, maximum: 1 },
              properties: { type: "object", additionalProperties: true },
              source: {
                anyOf: [
                  { type: "null" },
                  { type: "object", required: ["type", "ref"], additionalProperties: false, properties: { type: { enum: ["tool_result", "traffic", "artifact"] }, ref: { type: "string", minLength: 1 } } },
                ],
              },
            },
          },
        },
      },
      {
        type: "object", required: ["type", "edge"], additionalProperties: false,
        properties: {
          type: { const: "add_edge" },
          edge: { type: "object", required: ["id", "sourceId", "targetId", "relation", "rationale"], additionalProperties: false, properties: {
            id: { type: "string", minLength: 1 }, sourceId: { type: "string", minLength: 1 }, targetId: { type: "string", minLength: 1 },
            relation: { enum: relation.options }, rationale: { type: "string", minLength: 1 },
          } },
        },
      },
      { type: "object", required: ["type", "nodeId", "status", "reason"], additionalProperties: false, properties: { type: { const: "transition_node" }, nodeId: { type: "string", minLength: 1 }, status: { enum: status.options }, reason: { type: "string", minLength: 1 } } },
      { type: "object", required: ["type", "nodeId", "reason"], additionalProperties: false, properties: { type: { const: "invalidate_node" }, nodeId: { type: "string", minLength: 1 }, reason: { type: "string", minLength: 1 } } },
    ],
  };
  readonly requiredCapabilities = [KNOWLEDGE_GRAPH_CAPABILITIES.write];
  readonly permissionRequirements = {};
  readonly risk = "bounded_write" as const;
  readonly timeoutMs = 5_000;

  constructor(
    private readonly sqlite: Database.Database,
    private readonly store: SqliteEvidenceGraphStore,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async execute(input: unknown, context: ToolContext): Promise<ToolExecutionResult> {
    const parsed = mutation.parse(input);
    const at = this.now();
    let command: EvidenceGraphCommand;
    if (parsed.type === "add_node") {
      const verifiedSource = parsed.node.source ? this.verifySource(context.caseId, parsed.node.source, context, at) : null;
      const node: Omit<KnowledgeNode, "version" | "createdAt" | "updatedAt" | "invalidatedAt" | "invalidationReason"> = {
        ...parsed.node,
        caseId: context.caseId,
        runId: context.runId,
        source: verifiedSource,
      };
      command = { type: "add_node", node, at };
    } else {
      command = { ...parsed, at } as EvidenceGraphCommand;
    }

    const commandId = `worker-graph:${context.idempotencyKey}`;
    let lastConflict: EvidenceGraphRevisionConflictError | undefined;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const state = this.store.ensure(context.caseId, at);
      try {
        const result = this.store.execute({ caseId: context.caseId, commandId, expectedRevision: state.revision, command });
        const refs = result.events.flatMap((event) => {
          if (event.type === "node_added") return [`knowledge-node:${event.node.id}`];
          if (event.type === "edge_added") return [`knowledge-edge:${event.edge.id}`];
          if (event.type === "node_status_changed" || event.type === "node_invalidated") return [`knowledge-node:${event.nodeId}`];
          return [];
        });
        return {
          status: "succeeded",
          summary: `Applied ${parsed.type} at Evidence Graph revision ${result.state.revision}`,
          raw: JSON.stringify({ events: result.events, revision: result.state.revision, idempotentReplay: result.idempotentReplay }),
          refs,
          retryable: false,
          metadata: { graphRevision: result.state.revision },
        };
      } catch (error) {
        if (!(error instanceof EvidenceGraphRevisionConflictError)) throw error;
        lastConflict = error;
      }
    }
    throw lastConflict ?? new Error("Evidence Graph mutation failed after concurrency retries");
  }

  private verifySource(caseId: string, source: { type: "tool_result" | "traffic" | "artifact"; ref: string }, context: ToolContext, at: string): EvidenceSource {
    let integrity: EvidenceSource["integrity"];
    if (source.type === "traffic") {
      const row = this.sqlite.prepare("SELECT 1 FROM traffic_entries WHERE id = ? AND case_id = ?").get(source.ref, caseId);
      if (!row) throw new Error(`Evidence source traffic ${source.ref} does not exist in the assigned Case`);
    } else if (source.type === "artifact") {
      const row = this.sqlite.prepare("SELECT sha256 FROM artifacts WHERE id = ? AND case_id = ?").get(source.ref, caseId) as { sha256: string } | undefined;
      if (!row) throw new Error(`Evidence source artifact ${source.ref} does not exist in the assigned Case`);
      integrity = { algorithm: "sha256", digest: row.sha256 };
    } else {
      const row = this.sqlite.prepare("SELECT 1 FROM worker_tool_receipts WHERE idempotency_key = ?").get(source.ref);
      if (!row) throw new Error(`Evidence source tool result ${source.ref} has no durable receipt`);
    }
    return { type: source.type, ref: source.ref, observedAt: at, producerId: `${context.workerId}:${context.idempotencyKey}`, integrity };
  }
}
