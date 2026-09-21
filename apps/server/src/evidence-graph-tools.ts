import type Database from "better-sqlite3";
import { executionSourceProvenance } from "./execution-provenance.js";
import { z } from "zod";
import type { EvidenceGraphCommand, KnowledgeNode } from "@traceforge/evidence-graph";
import {projectCaseHistory} from "@traceforge/evidence-graph";
import type { ExecutionToolAdapter, ToolExecutionResult } from "@traceforge/worker-runtime";
import { EvidenceGraphRevisionConflictError, SqliteEvidenceGraphStore } from "./evidence-graph-store.js";

export const KNOWLEDGE_GRAPH_CAPABILITIES = {
  read: "knowledge.graph.read",
  write: "knowledge.graph.write",
} as const;

const kind = z.enum(["entity", "fact", "hypothesis", "evidence", "task", "validation_conclusion", "finding", "limitation", "inquiry"]);
const writableKind=kind.exclude(["inquiry"]);
const status = z.enum(["active", "candidate", "validating", "verified", "refuted", "blocked", "resolved", "needs_review", "invalidated"]);
const relation = z.enum(["supports", "refutes", "derived_from", "generated_by", "validates", "targets", "depends_on", "impacts", "limits", "supersedes"]);
const mutation = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("add_node"),
    node: z.object({
      id: z.string().min(1), kind:writableKind, title: z.string().min(1), summary: z.string().min(1), status,
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
  readonly source = "traceforge.builtin";
  readonly version = "1.0.0";
  readonly priority = 100;
  readonly description = "Read the current Run and shared Case graph. Set history=true to search prior Run verified findings, resolved conclusions and active limitations; historical context is never current evidence or permission.";
  readonly inputSchema = {
    type: "object",
    properties: {
      history:{type:"boolean"},query:{type:"string",maxLength:512},
      limit: { type: "integer", minimum: 1, maximum: 100 },
      kinds: { type: "array", items: { enum: kind.options }, uniqueItems: true },
      statuses: { type: "array", items: { enum: status.options }, uniqueItems: true },
    },
    additionalProperties: false,
  };
  readonly providedCapabilities = [KNOWLEDGE_GRAPH_CAPABILITIES.read];
  readonly dependencyCapabilities: string[] = [];
  readonly permissionRequirements = {};
  readonly risk = "read_only" as const;
  readonly timeoutMs = 5_000;

  constructor(private readonly store: SqliteEvidenceGraphStore, private readonly now: () => string = () => new Date().toISOString()) {}

  async execute(input: unknown, context: ToolContext): Promise<ToolExecutionResult> {
    const parsed = z.object({ history:z.boolean().default(false),query:z.string().max(512).default(""),limit: z.number().int().min(1).max(100).default(100), kinds: z.array(kind).optional(), statuses: z.array(status).optional() }).strict().parse(input ?? {});
    const state = this.store.ensure(context.caseId, this.now());
    if(parsed.history){const entries=projectCaseHistory(state,context,parsed.query,Math.min(parsed.limit,100));return {status:"succeeded",summary:`Loaded ${entries.length} historical conclusions; none verifies the current Run`,raw:JSON.stringify({caseId:context.caseId,history:entries,trust:"historical_context"}),refs:entries.map(item=>item.reference),retryable:false};}
    const nodes = state.nodes
      .filter(node=>node.runId===null||node.runId===context.runId)
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
  readonly source = "traceforge.builtin";
  readonly version = "1.0.0";
  readonly priority = 100;
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
              id: { type: "string", minLength: 1 }, kind: { enum: writableKind.options }, title: { type: "string", minLength: 1 },
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
  readonly providedCapabilities = [KNOWLEDGE_GRAPH_CAPABILITIES.write, "evidence.write"];
  readonly dependencyCapabilities: string[] = [];
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
      const verifiedSource = parsed.node.source ? executionSourceProvenance(this.sqlite, parsed.node.source, context) : null;
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

}
