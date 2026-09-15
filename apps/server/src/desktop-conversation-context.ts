import type Database from "better-sqlite3";
import type { LlmProvider, TurnMessage } from "@traceforge/llm";
import { estimateContextTokens, resolveContextBudget, ModelContextOverflowError } from "@traceforge/shared/model-context";

/** Recent complete pairs only. Earlier messages remain available to summary and readback. */
export function prepareConversationContext(sql: Database.Database, conversationId: string, through: number, model: LlmProvider, system: string, recovering = false) {
  const rows = sql.prepare(`SELECT m.sequence,m.text,r.text AS response FROM desktop_conversation_messages m
    LEFT JOIN desktop_replies r ON r.conversation_id=m.conversation_id AND r.message_command_id=m.command_id AND r.state='completed'
    WHERE m.conversation_id=? AND m.sequence<=? ORDER BY m.sequence DESC LIMIT 10001`).all(conversationId, through) as Array<{ sequence: number; text: string; response: string | null }>;
  if (!rows.length || rows.length > 10000) throw new Error("Conversation history capacity exceeded");
  const budget = resolveContextBudget(model.contextLimits);
  const recentBudget = recovering ? Math.floor(budget.target * 0.25) : estimateContextTokens(rows) > budget.trigger ? Math.floor(budget.target * 0.6) : budget.trigger;
  let bytes = 0, tokens = 0, included = 0, before = through;
  const messages: TurnMessage[] = [];
  for (const row of rows) {
    const size = Buffer.byteLength(row.text) + Buffer.byteLength(row.response ?? ""), rowTokens = estimateContextTokens(row);
    if (included && (tokens + rowTokens > recentBudget || bytes + size > 1048576)) break;
    if (tokens + rowTokens + estimateContextTokens(system) + 2048 > budget.input || bytes + size > 1048576) throw new ModelContextOverflowError("local_guard");
    bytes += size; tokens += rowTokens; included++; before = row.sequence;
    messages.unshift({ role: "user", content: row.text }, ...(row.response ? [{ role: "assistant" as const, content: row.response }] : []));
  }
  const interrupted = sql.prepare(`SELECT r.text,r.state,m.command_id AS id FROM desktop_conversation_messages m JOIN desktop_replies r
    ON r.conversation_id=m.conversation_id AND r.message_command_id=m.command_id
    WHERE m.conversation_id=? AND m.sequence=(SELECT max(sequence) FROM desktop_conversation_messages WHERE conversation_id=? AND sequence<?)
    AND r.state IN ('interrupted','cancelled','failed') AND length(r.text)>0`).get(conversationId, conversationId, through) as { text: string; state: string; id: string } | undefined;
  if (interrupted) messages.splice(Math.max(0, messages.length - 1), 0, { role: "user", content: JSON.stringify({
    trust: "untrusted_incomplete_assistant_fragment", messageId: interrupted.id, state: interrupted.state,
    excerpt: interrupted.text.slice(0, 2000), truncated: interrupted.text.length > 2000,
    guidance: "The preceding reply was not completed. If asked to continue it, use conversation_read for missing detail; do not present this fragment as completed work.",
  }) });
  return { messages, before, truncated: included < rows.length };
}
