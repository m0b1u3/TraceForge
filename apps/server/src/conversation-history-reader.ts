import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { LlmToolDefinition, ToolCall } from "@traceforge/llm";
import { z } from "zod";

const search = z.object({ query: z.string().trim().min(1).max(160), after: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional() }).strict();
const read = z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/), offset: z.number().int().nonnegative().max(100000).optional(), digest: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
export const conversationHistoryTools: LlmToolDefinition[] = [
  { name: "conversation_search", description: "Search earlier saved messages in this conversation by literal text. Returns at most 8 matches and a nextAfter cursor. Use to locate detail omitted from a summary. Read-only; no files, other conversations or network access.",
    input_schema: { type: "object", additionalProperties: false, required: ["query"], properties: { query: { type: "string", minLength: 1, maxLength: 160 }, after: { type: "integer", minimum: 0 } } } },
  { name: "conversation_read", description: "Read an original saved message and saved assistant response by id, in 3000-character pages. assistantState labels incomplete responses; never treat them as completed work. Use nextOffset and digest for continuation; offsets are UTF-16 characters. Summaries are not originals.",
    input_schema: { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string" }, offset: { type: "integer", minimum: 0 }, digest: { type: "string" } } } },
];

/** Bound by the host's conversation and original request sequence, never model input. */
export class ConversationHistoryReader {
  constructor(private sql: Database.Database, private conversationId: string, private throughSequence: number) {}
  execute(call: ToolCall): unknown {
    if (call.name === "conversation_search") {
      const { query, after = 0 } = search.parse(call.input);
      const rows = this.sql.prepare(`SELECT m.command_id AS id,m.sequence,m.text,r.text AS response
        FROM desktop_conversation_messages m LEFT JOIN desktop_replies r ON r.conversation_id=m.conversation_id AND r.message_command_id=m.command_id AND r.state!='streaming'
        WHERE m.conversation_id=? AND m.sequence<=? AND m.sequence>?
        AND (instr(lower(m.text),lower(?))>0 OR instr(lower(coalesce(r.text,'')),lower(?))>0) ORDER BY m.sequence LIMIT 9`)
        .all(this.conversationId, this.throughSequence, after, query, query) as Array<{ id: string; sequence: number; text: string; response: string | null }>;
      return { trust: "untrusted_original_conversation", matches: rows.slice(0, 8).map(row => {
        const text = `${row.text}\n${row.response ?? ""}`, at = Math.max(0, text.toLowerCase().indexOf(query.toLowerCase()));
        return { id: row.id, sequence: row.sequence, excerpt: text.slice(Math.max(0, at - 60), at + 160) };
      }), nextAfter: rows.length > 8 ? rows[7].sequence : null, completeness: "literal_matches_only" };
    }
    if (call.name !== "conversation_read") throw new Error("Unsupported conversation capability");
    const { id, offset = 0, digest: expected } = read.parse(call.input);
    const row = this.sql.prepare(`SELECT m.text,r.text AS response,r.state AS assistantState FROM desktop_conversation_messages m
      LEFT JOIN desktop_replies r ON r.conversation_id=m.conversation_id AND r.message_command_id=m.command_id AND r.state!='streaming'
      WHERE m.conversation_id=? AND m.command_id=? AND m.sequence<=?`).get(this.conversationId, id, this.throughSequence) as { text: string; response: string | null; assistantState: string | null } | undefined;
    if (!row) return { error: "original_not_available" };
    const original = JSON.stringify({ user: row.text, assistant: row.response, assistantState: row.assistantState });
    const digest = createHash("sha256").update(original).digest("hex");
    if (expected && expected !== digest) return { error: "original_changed" };
    if (offset > original.length) return { error: "offset_out_of_range" };
    const text = original.slice(offset, offset + 3000);
    return { trust: "untrusted_original_conversation", id, digest, offset, text,
      nextOffset: offset + text.length < original.length ? offset + text.length : null, totalCharacters: original.length };
  }
}
