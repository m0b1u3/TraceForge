import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import type { LlmProvider, TurnMessage } from "@traceforge/llm";
import { DesktopReplyCommandSchema, type DesktopReply } from "@traceforge/shared/desktop-replies";

const columns = `conversation_id AS conversationId, message_command_id AS messageCommandId,
  revision, state, text, created_at AS createdAt, updated_at AS updatedAt,
  context_messages AS contextMessages, context_truncated AS contextTruncated, error`;
const outputLimit = 65536;
// This is a capability declaration, not a Scenario prompt or investigation policy.
const system = "This is a text-only conversation. No tools, target access or investigation evidence are available in this request. Do not claim to have executed actions or verified findings. Tool execution requires the separate authorized investigation workflow.";

/** Local application conversation service. It neither owns a Scenario Run nor executes tools.
 * One durable generation per saved message: replaying a command never repeats model inference.
 * Streaming snapshots are committed before the renderer can observe them.
 */
export class DesktopReplyService {
  private active = new Map<string, { abort: AbortController; stop(state: "cancelled" | "interrupted", error?: DesktopReply["error"]): void }>();
  private closed = false;
  constructor(private sql: Database.Database, private provider: () => LlmProvider, private timeoutMs = 120000) {
    sql.exec(`CREATE TABLE IF NOT EXISTS desktop_reply_clock (id INTEGER PRIMARY KEY CHECK(id=1), value INTEGER NOT NULL);
      INSERT OR IGNORE INTO desktop_reply_clock VALUES(1,0);
      CREATE TABLE IF NOT EXISTS desktop_replies (
        conversation_id TEXT NOT NULL, message_command_id TEXT NOT NULL, revision INTEGER NOT NULL,
        state TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        context_messages INTEGER NOT NULL, context_truncated INTEGER NOT NULL, error TEXT,
        PRIMARY KEY(conversation_id,message_command_id));
      CREATE INDEX IF NOT EXISTS desktop_replies_changes ON desktop_replies(conversation_id,revision);`);
    // Only one local Server owns the database. A host restart restores text, never inference.
    sql.transaction(() => {
      for (const row of sql.prepare(`SELECT ${columns} FROM desktop_replies WHERE state='streaming'`).all() as DesktopReply[])
        this.update(row.conversationId, row.messageCommandId, row.text, "interrupted", "host_stopped");
    })();
  }
  private revision() { return (this.sql.prepare("UPDATE desktop_reply_clock SET value=value+1 WHERE id=1 RETURNING value").get() as { value: number }).value; }
  private owner(id: string) { return this.sql.prepare("SELECT 1 FROM desktop_conversations c JOIN cases k ON k.id=c.case_id WHERE c.id=?").get(id); }
  private row(conversationId: string, messageId: string): DesktopReply | undefined {
    const row = this.sql.prepare(`SELECT ${columns} FROM desktop_replies WHERE conversation_id=? AND message_command_id=?`).get(conversationId, messageId) as DesktopReply | undefined;
    return row && { ...row, contextTruncated: Boolean(row.contextTruncated) };
  }
  private update(conversationId: string, messageId: string, text: string, state: DesktopReply["state"], error: DesktopReply["error"] = null) {
    this.sql.transaction(() => this.sql.prepare(`UPDATE desktop_replies SET text=?,state=?,error=?,updated_at=?,revision=?
      WHERE conversation_id=? AND message_command_id=? AND state='streaming'`).run(text, state, error, new Date().toISOString(), this.revision(), conversationId, messageId))();
  }
  read(conversationId: string, after: number) {
    if (!this.owner(conversationId)) return { status: 404, body: { error: "conversation_not_found" } };
    const rows = this.sql.prepare(`SELECT ${columns} FROM desktop_replies WHERE conversation_id=? AND revision>? ORDER BY revision LIMIT 101`).all(conversationId, after) as DesktopReply[];
    const replies = rows.slice(0, 100).map(row => ({ ...row, contextTruncated: Boolean(row.contextTruncated) }));
    return { status: 200, body: { conversationId, replies, nextAfter: replies.at(-1)?.revision ?? after, hasMore: rows.length > 100 } };
  }
  start(conversationId: string, messageId: string) {
    if (!this.owner(conversationId)) return { status: 404, body: { error: "conversation_not_found" } };
    const previous = this.row(conversationId, messageId);
    if (previous) return { status: 200, body: previous };
    if (this.closed || this.active.size >= 1) return { status: 409, body: { error: "reply_busy" } };
    const current = this.sql.prepare("SELECT sequence FROM desktop_conversation_messages WHERE conversation_id=? AND command_id=?").get(conversationId, messageId) as { sequence: number } | undefined;
    if (!current) return { status: 404, body: { error: "message_not_found" } };
    // Reserve a whole reply's maximum size before invoking a chargeable model.
    const used = (this.sql.prepare("SELECT coalesce(sum(length(cast(text AS BLOB))),0) AS bytes FROM desktop_replies").get() as { bytes: number }).bytes;
    const count = (this.sql.prepare("SELECT count(*) AS count FROM desktop_replies").get() as { count: number }).count;
    if (used + outputLimit > 32 * 1024 * 1024 || count >= 10000) return { status: 409, body: { error: "reply_capacity_reached" } };
    let model: LlmProvider;
    try { model = this.provider(); if (!model.streamTools) throw new Error(); }
    catch { return { status: 503, body: { error: "streaming_model_unavailable" } };
    }
    // Keep complete recent user/assistant pairs, never partial assistant generations.
    const rows = this.sql.prepare(`SELECT m.text,r.text AS response FROM desktop_conversation_messages m
      LEFT JOIN desktop_replies r ON r.conversation_id=m.conversation_id AND r.message_command_id=m.command_id AND r.state='completed'
      WHERE m.conversation_id=? AND m.sequence<=? ORDER BY m.sequence DESC LIMIT 100`).all(conversationId, current.sequence) as Array<{ text: string; response: string | null }>;
    let bytes = 0, included = 0; const messages: TurnMessage[] = [];
    for (const row of rows) {
      const size = Buffer.byteLength(row.text) + Buffer.byteLength(row.response ?? "");
      if (bytes + size > 65536) break;
      bytes += size; included++;
      messages.unshift({ role: "user", content: row.text }, ...(row.response ? [{ role: "assistant" as const, content: row.response }] : []));
    }
    const now = new Date().toISOString();
    this.sql.transaction(() => this.sql.prepare(`INSERT INTO desktop_replies VALUES(?,?,?,'streaming','',?,?,?, ?,NULL)`)
      .run(conversationId, messageId, this.revision(), now, now, messages.length, Number(included < current.sequence)))();
    this.generate(model, conversationId, messageId, messages);
    return { status: 202, body: this.row(conversationId, messageId)! };
  }
  cancel(conversationId: string, messageId: string) {
    if (!this.owner(conversationId)) return { status: 404, body: { error: "conversation_not_found" } };
    const row = this.row(conversationId, messageId);
    if (!row) return { status: 404, body: { error: "reply_not_found" } };
    this.active.get(`${conversationId}:${messageId}`)?.stop("cancelled");
    return { status: 200, body: this.row(conversationId, messageId)! };
  }
  close() {
    this.closed = true;
    for (const entry of this.active.values()) { try { entry.stop("interrupted", "host_stopped"); } catch { entry.abort.abort(); } }
  }
  private generate(model: LlmProvider, conversationId: string, messageId: string, messages: TurnMessage[]) {
    const key = `${conversationId}:${messageId}`, abort = new AbortController();
    let text = "", settled = false, flush: ReturnType<typeof setTimeout> | undefined;
    const persist = () => { flush = undefined; if (!settled) this.update(conversationId, messageId, text, "streaming"); };
    const finish = (state: DesktopReply["state"], error: DesktopReply["error"] = null) => {
      if (settled) return;
      clearTimeout(flush); this.update(conversationId, messageId, text, state, error); settled = true;
    };
    const stop = (state: "cancelled" | "interrupted", error: DesktopReply["error"] = null) => {
      try { finish(state, error); } finally { abort.abort(); }
    };
    this.active.set(key, { abort, stop });
    const timer = setTimeout(() => { try { stop("interrupted", "timeout"); } catch { abort.abort(); } }, this.timeoutMs);
    void (async () => {
      try {
        const result = await model.streamTools!({ system, messages, tools: [] }, {
          signal: abort.signal,
          onTextDelta: delta => {
            if (settled || abort.signal.aborted) return;
            if (Buffer.byteLength(text) + Buffer.byteLength(delta) > outputLimit) {
              finish("failed", "output_limit"); abort.abort(); throw new Error("reply output limit");
            }
            text += delta;
            if (!flush) flush = setTimeout(() => { try { persist(); } catch { settled = true; abort.abort(); } }, 100);
          },
        });
        if (!settled) {
          if (!result.done || result.toolCalls.length || result.text !== text || !text.trim()) finish("failed", "invalid_completion");
          else finish("completed");
        }
      } catch { if (!settled) { try { finish("failed", "provider_failed"); } catch { /* Durable streaming state is recovered as interrupted at next host startup. */ } } }
      finally { clearTimeout(timer); clearTimeout(flush); this.active.delete(key); }
    })();
  }
}

export function registerDesktopReplyRoutes(app: FastifyInstance, service: DesktopReplyService) {
  const id = { type: "string", pattern: "^[a-zA-Z0-9_-]{1,100}$" };
  const root = "/api/desktop/conversations/:conversationId/replies";
  app.get(root, { schema: { params: { type: "object", required: ["conversationId"], properties: { conversationId: id }, additionalProperties: false },
    querystring: { type: "object", required: ["after"], properties: { after: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER } }, additionalProperties: false } } }, async (request, reply) => {
    const result = service.read((request.params as { conversationId: string }).conversationId, (request.query as { after: number }).after);
    return reply.code(result.status).send(result.body);
  });
  for (const operation of ["", "/cancel"] as const) app.post(`${root}/:messageId${operation}`, { schema: {
    params: { type: "object", required: ["conversationId", "messageId"], properties: { conversationId: id, messageId: id }, additionalProperties: false },
  } }, async (request, reply) => {
    if (!DesktopReplyCommandSchema.safeParse(request.body).success) return reply.code(400).send({ error: "invalid_reply_command" });
    const { conversationId, messageId } = request.params as { conversationId: string; messageId: string };
    const result = operation ? service.cancel(conversationId, messageId) : service.start(conversationId, messageId);
    return reply.code(result.status).send(result.body);
  });
  app.addHook("onClose", async () => service.close());
}
