import type Database from "better-sqlite3";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { EvidenceGraphCommand, EvidenceGraphState, KnowledgeNode } from "@traceforge/evidence-graph";
import {
  EvidenceGraphIdempotencyConflictError,
  EvidenceGraphRevisionConflictError,
  SqliteEvidenceGraphStore,
} from "./evidence-graph-store.js";

const nodeKind = z.enum(["entity", "fact", "hypothesis", "evidence", "task", "validation_conclusion", "finding", "limitation"]);
const nodeStatus = z.enum(["active", "candidate", "validating", "verified", "refuted", "blocked", "resolved", "needs_review", "invalidated"]);
const relation = z.enum(["supports", "refutes", "derived_from", "generated_by", "validates", "targets", "depends_on", "impacts", "limits", "supersedes"]);
const source = z.object({
  type: z.enum(["tool_result", "traffic", "artifact", "human", "code", "external_reference"]),
  ref: z.string().min(1),
  observedAt: z.string().datetime(),
  producerId: z.string().min(1),
  integrity: z.object({ algorithm: z.literal("sha256"), digest: z.string().min(1) }).optional(),
});
const node = z.object({
  id: z.string().min(1), runId: z.string().min(1).nullable(), kind: nodeKind,
  title: z.string().min(1), summary: z.string().min(1), status: nodeStatus,
  confidence: z.number().min(0).max(1), properties: z.record(z.unknown()), source: source.nullable(),
}).strict();
const command = z.discriminatedUnion("type", [
  z.object({ type: z.literal("add_node"), node }),
  z.object({ type: z.literal("add_edge"), edge: z.object({
    id: z.string().min(1), sourceId: z.string().min(1), targetId: z.string().min(1),
    relation, rationale: z.string().min(1),
  }) }),
  z.object({ type: z.literal("transition_node"), nodeId: z.string().min(1), status: nodeStatus, reason: z.string().min(1) }),
  z.object({ type: z.literal("invalidate_node"), nodeId: z.string().min(1), reason: z.string().min(1) }),
]);
const envelope = z.object({ commandId: z.string().min(1), expectedRevision: z.number().int().nonnegative(), command });

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof z.ZodError) return reply.code(400).send({ error: "invalid request", issues: error.issues });
  if (error instanceof EvidenceGraphRevisionConflictError) {
    return reply.code(409).send({ error: error.message, expectedRevision: error.expectedRevision, actualRevision: error.actualRevision });
  }
  if (error instanceof EvidenceGraphIdempotencyConflictError) return reply.code(409).send({ error: error.message });
  return reply.code(400).send({ error: error instanceof Error ? error.message : "Evidence Graph command failed" });
}

function filteredGraph(state: EvidenceGraphState, filter: { kind?: string; status?: string; runId?: string }): EvidenceGraphState {
  const nodes = state.nodes.filter((candidate) =>
    (!filter.kind || candidate.kind === filter.kind)
    && (!filter.status || candidate.status === filter.status)
    && (!filter.runId || candidate.runId === filter.runId));
  const ids = new Set(nodes.map((candidate) => candidate.id));
  return { ...state, nodes, edges: state.edges.filter((edge) => ids.has(edge.sourceId) && ids.has(edge.targetId)) };
}

function neighborhood(state: EvidenceGraphState, nodeId: string, depth: number): { center: KnowledgeNode; nodes: KnowledgeNode[]; edges: EvidenceGraphState["edges"] } {
  const center = state.nodes.find((candidate) => candidate.id === nodeId);
  if (!center) throw new Error(`Unknown Knowledge node ${nodeId}`);
  const included = new Set([nodeId]);
  let frontier = new Set([nodeId]);
  for (let level = 0; level < depth; level += 1) {
    const next = new Set<string>();
    for (const edge of state.edges) {
      if (frontier.has(edge.sourceId) && !included.has(edge.targetId)) next.add(edge.targetId);
      if (frontier.has(edge.targetId) && !included.has(edge.sourceId)) next.add(edge.sourceId);
    }
    for (const id of next) included.add(id);
    frontier = next;
  }
  return {
    center,
    nodes: state.nodes.filter((candidate) => included.has(candidate.id)),
    edges: state.edges.filter((edge) => included.has(edge.sourceId) && included.has(edge.targetId)),
  };
}

export function registerEvidenceGraphRoutes(
  app: FastifyInstance,
  sqlite: Database.Database,
  store: SqliteEvidenceGraphStore,
  now: () => string = () => new Date().toISOString(),
): void {
  const requireCase = (caseId: string) => {
    if (!sqlite.prepare("SELECT 1 FROM cases WHERE id = ?").get(caseId)) throw new Error(`Unknown Case ${caseId}`);
  };

  app.get("/api/knowledge-graph/:caseId", async (request, reply) => {
    try {
      const { caseId } = z.object({ caseId: z.string().min(1) }).parse(request.params);
      const query = z.object({ kind: nodeKind.optional(), status: nodeStatus.optional(), runId: z.string().min(1).optional() }).parse(request.query);
      requireCase(caseId);
      return filteredGraph(store.ensure(caseId, now()), query);
    } catch (error) { return sendError(reply, error); }
  });

  app.get("/api/knowledge-graph/:caseId/nodes/:nodeId", async (request, reply) => {
    try {
      const { caseId, nodeId } = z.object({ caseId: z.string().min(1), nodeId: z.string().min(1) }).parse(request.params);
      const { depth } = z.object({ depth: z.coerce.number().int().min(0).max(5).default(1) }).parse(request.query);
      requireCase(caseId);
      return neighborhood(store.ensure(caseId, now()), nodeId, depth);
    } catch (error) { return sendError(reply, error); }
  });

  app.post("/api/knowledge-graph/:caseId/commands", async (request, reply) => {
    try {
      const { caseId } = z.object({ caseId: z.string().min(1) }).parse(request.params);
      const body = envelope.parse(request.body);
      requireCase(caseId);
      store.ensure(caseId, now());
      const graphCommand = body.command.type === "add_node"
        ? { ...body.command, node: { ...body.command.node, caseId }, at: now() }
        : { ...body.command, at: now() };
      const result = store.execute({
        caseId, commandId: body.commandId, expectedRevision: body.expectedRevision,
        command: graphCommand as EvidenceGraphCommand,
      });
      return reply.code(result.idempotentReplay ? 200 : 201).send(result);
    } catch (error) { return sendError(reply, error); }
  });
}
