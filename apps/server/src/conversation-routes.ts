import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { getSqliteClient, type Db } from "./db/client.js";

/** Desktop application persistence, deliberately outside Core and Scenario.
 * Saved text is not a Planner input, an authorization, or an assistant reply.
 */
export function registerConversationRoutes(app: FastifyInstance, db: Db): void {
  const sql = getSqliteClient(db);
  const id = { type: "string", minLength: 1, maxLength: 100, pattern: "^[a-zA-Z0-9_-]+$" };
  const params = { type: "object", required: ["conversationId"], properties: { conversationId: id }, additionalProperties: false };
  const owner = (conversationId: string) => sql.prepare(`SELECT c.id, c.case_id AS caseId, c.title, c.created_at AS createdAt
    FROM desktop_conversations c JOIN cases k ON k.id=c.case_id WHERE c.id=?`).get(conversationId);

  app.post("/api/desktop/conversations", {
    schema: { body: { type: "object", required: ["commandId", "title"], additionalProperties: false,
      properties: { commandId: id, title: { type: "string", minLength: 1, maxLength: 200 } } } },
  }, async (request, reply) => {
    const { commandId, title } = request.body as { commandId: string; title: string };
    const normalized = title.trim();
    if (!normalized) return reply.code(400).send({ error: "title_required" });
    const result = sql.transaction(() => {
      const previous = sql.prepare("SELECT id, title FROM desktop_conversations WHERE command_id=?").get(commandId) as { id: string; title: string } | undefined;
      if (previous) return previous.title === normalized ? { status: owner(previous.id) ? 200 : 410, value: owner(previous.id) ?? { error: "conversation_owner_missing" } } : { status: 409, value: { error: "command_conflict" } };
      if ((sql.prepare("SELECT count(*) AS count FROM desktop_conversations").get() as { count: number }).count >= 1000) return { status: 409, value: { error: "conversation_capacity_reached" } };
      const conversationId = `conversation_${randomUUID()}`;
      const caseId = `case_${randomUUID()}`;
      const now = new Date().toISOString();
      // An empty Case is only an ownership container. It grants no target scope.
      sql.prepare("INSERT INTO cases (id,name,status,scope_rules_json,created_at) VALUES (?,?,'active','[]',?)").run(caseId, normalized, now);
      sql.prepare("INSERT INTO desktop_conversations (id,command_id,case_id,title,created_at) VALUES (?,?,?,?,?)").run(conversationId, commandId, caseId, normalized, now);
      return { status: 201, value: owner(conversationId) };
    })();
    return reply.code(result.status).send(result.value);
  });

  app.get("/api/desktop/conversations", async () => ({
    conversations: sql.prepare(`SELECT c.id, c.case_id AS caseId, c.title, c.created_at AS createdAt
      FROM desktop_conversations c JOIN cases k ON k.id=c.case_id ORDER BY c.created_at DESC,c.id DESC LIMIT 1000`).all(),
    capacity: 1000,
  }));

  app.get("/api/desktop/conversations/:conversationId", { schema: { params } }, async (request, reply) => {
    const { conversationId } = request.params as { conversationId: string };
    return owner(conversationId) ?? reply.code(404).send({ error: "conversation_not_found" });
  });

  app.post("/api/desktop/conversations/:conversationId/messages", {
    schema: { params, body: { type: "object", required: ["commandId", "text"], additionalProperties: false,
      properties: { commandId: id, text: { type: "string", minLength: 1, maxLength: 16000 } } } },
  }, async (request, reply) => {
    const { conversationId } = request.params as { conversationId: string };
    const { commandId, text } = request.body as { commandId: string; text: string };
    if (!text.trim()) return reply.code(400).send({ error: "message_required" });
    const result = sql.transaction(() => {
      if (!owner(conversationId)) return { status: 404, value: { error: "conversation_not_found" } };
      const previous = sql.prepare("SELECT sequence,text,created_at AS createdAt FROM desktop_conversation_messages WHERE conversation_id=? AND command_id=?").get(conversationId, commandId) as { sequence: number; text: string; createdAt: string } | undefined;
      if (previous) return previous.text === text ? { status: 200, value: receipt(conversationId, commandId, previous) } : { status: 409, value: { error: "command_conflict" } };
      const count = (sql.prepare("SELECT count(*) AS count FROM desktop_conversation_messages WHERE conversation_id=?").get(conversationId) as { count: number }).count;
      if (count >= 2000) return { status: 409, value: { error: "message_capacity_reached" } };
      const bytes = (sql.prepare("SELECT coalesce(sum(length(cast(text AS BLOB))),0) AS bytes FROM desktop_conversation_messages").get() as { bytes: number }).bytes;
      if (bytes + Buffer.byteLength(text, "utf8") > 32 * 1024 * 1024) return { status: 409, value: { error: "conversation_storage_capacity_reached" } };
      const message = { sequence: count + 1, text, createdAt: new Date().toISOString() };
      sql.prepare("INSERT INTO desktop_conversation_messages (conversation_id,command_id,sequence,text,created_at) VALUES (?,?,?,?,?)").run(conversationId, commandId, message.sequence, text, message.createdAt);
      return { status: 201, value: receipt(conversationId, commandId, message) };
    })();
    return reply.code(result.status).send(result.value);
  });

  app.get("/api/desktop/conversations/:conversationId/messages", {
    schema: { params, querystring: { type: "object", additionalProperties: false, properties: {
      after: { type: "integer", minimum: 0, maximum: 2000, default: 0 }, limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
    } } },
  }, async (request, reply) => {
    const { conversationId } = request.params as { conversationId: string };
    if (!owner(conversationId)) return reply.code(404).send({ error: "conversation_not_found" });
    const { after, limit } = request.query as { after: number; limit: number };
    const rows = sql.prepare(`SELECT sequence,command_id AS commandId,text,created_at AS createdAt
      FROM desktop_conversation_messages WHERE conversation_id=? AND sequence>? ORDER BY sequence LIMIT ?`).all(conversationId, after, limit + 1) as Array<{ sequence: number; commandId: string; text: string; createdAt: string }>;
    return { conversationId, messages: rows.slice(0, limit).map(row => receipt(conversationId, row.commandId, row)), hasMore: rows.length > limit,
      nextAfter: rows.slice(0, limit).at(-1)?.sequence ?? after };
  });
}

function receipt(conversationId: string, commandId: string, row: { sequence: number; text: string; createdAt: string }) {
  return { conversationId, commandId, sequence: row.sequence, text: row.text, createdAt: row.createdAt,
    role: "user", persistence: "saved", delivery: "not_dispatched", reason: "conversation_dispatch_not_connected" };
}
