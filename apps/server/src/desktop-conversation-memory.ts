import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { LlmProvider } from "@traceforge/llm";
import { SemanticContextCompactor, summarizeHistory } from "@traceforge/cognitive-runtime";
import { resolveContextBudget } from "@traceforge/shared/model-context";
import { readConversationOriginal } from "./conversation-history-reader.js";

type OriginalRow={sequence:number;id:string;text:string;response:string|null};
function* originalRows(sql:Database.Database,conversationId:string,boundary:number,inclusive:boolean):Generator<OriginalRow>{
  const query=sql.prepare(`SELECT m.sequence,m.command_id AS id,m.text,r.text AS response FROM desktop_conversation_messages m
    LEFT JOIN desktop_replies r ON r.conversation_id=m.conversation_id AND r.message_command_id=m.command_id AND r.state='completed'
    WHERE NOT EXISTS (SELECT 1 FROM desktop_replies pending WHERE pending.conversation_id=m.conversation_id AND pending.message_command_id=m.command_id AND pending.state IN ('queued','withdrawn','cancelled'))
    AND m.conversation_id=? AND m.sequence${inclusive?"<=":"<"}? ORDER BY m.sequence LIMIT 32 OFFSET ?`);
  for(let offset=0;;offset+=32){
    const rows=query.all(conversationId,boundary,offset) as OriginalRow[];
    for(const row of rows)yield row;
    if(rows.length<32)break;
  }
}
function coverage(rows:Iterable<OriginalRow>){
  const hash=createHash("sha256").update("[");let count=0;const first:OriginalRow[]=[],last:OriginalRow[]=[];
  for(const row of rows){if(count)hash.update(",");hash.update(JSON.stringify(row));count++;
    if(first.length<8)first.push(row);last.push(row);if(last.length>8)last.shift();}
  hash.update("]");
  return {count,digest:hash.digest("hex"),selected:[...new Map([...first,...last].map(row=>[row.id,row])).values()]};
}

/** A derived reading aid. Original user/assistant messages remain authoritative
 * storage; summaries neither replace them nor create execution permission. */
export class DesktopConversationMemory {
  constructor(private readonly sql: Database.Database) {
    sql.exec(`CREATE TABLE IF NOT EXISTS desktop_conversation_memory (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS desktop_conversation_memory_views (conversation_id TEXT NOT NULL, message_id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(conversation_id,message_id));
      CREATE TRIGGER IF NOT EXISTS desktop_conversation_memory_physical_insert BEFORE INSERT ON desktop_conversation_memory BEGIN
        SELECT execution_physical_admit(execution_floor,maximum_database_bytes,maximum_wal_bytes,
          length(CAST(NEW.body AS BLOB))+2048,'execution') FROM execution_physical_policy WHERE id=1; END;
      CREATE TRIGGER IF NOT EXISTS desktop_conversation_memory_views_physical_insert BEFORE INSERT ON desktop_conversation_memory_views BEGIN
        SELECT execution_physical_admit(execution_floor,maximum_database_bytes,maximum_wal_bytes,
          length(CAST(NEW.body AS BLOB))+2048,'execution') FROM execution_physical_policy WHERE id=1; END;
      CREATE TRIGGER IF NOT EXISTS desktop_conversation_memory_views_physical_update BEFORE UPDATE ON desktop_conversation_memory_views BEGIN
        SELECT execution_physical_admit(execution_floor,maximum_database_bytes,maximum_wal_bytes,
          max(0,length(CAST(NEW.body AS BLOB))-length(CAST(OLD.body AS BLOB)))+2048,'execution') FROM execution_physical_policy WHERE id=1; END;`);
  }
  record(conversationId: string, messageId: string, body: string) {
    if (Buffer.byteLength(body) > 32768) throw new Error("Conversation memory entry exceeds its size limit");
    this.sql.prepare("INSERT INTO desktop_conversation_memory_views VALUES (?,?,?) ON CONFLICT(conversation_id,message_id) DO UPDATE SET body=excluded.body").run(conversationId, messageId, body);
  }
  read(conversationId: string, messageId: string) {
    const row = this.sql.prepare("SELECT body FROM desktop_conversation_memory_views WHERE conversation_id=? AND message_id=?").get(conversationId, messageId) as { body: string } | undefined;
    if (!row) return { conversationId, messageId, entries: [] };
    const value = JSON.parse(row.body);
    if (value.version === 2) {
      const original=coverage(originalRows(this.sql,conversationId,value.coveredThroughSequence,true));
      if (original.count !== value.coveredMessages || original.digest !== value.sourceDigest)
        throw new Error("Conversation memory historical coverage changed");
    }
    return { conversationId, messageId, entries: value.summaries.map((summary: { id: string; text: string }) => {
      const original = this.sql.prepare(`SELECT m.text AS user,r.text AS assistant FROM desktop_conversation_messages m LEFT JOIN desktop_replies r
        ON r.conversation_id=m.conversation_id AND r.message_command_id=m.command_id AND r.state='completed' WHERE m.conversation_id=? AND m.command_id=?`)
        .get(conversationId, summary.id) as { user: string; assistant: string | null } | undefined;
      const digest = value.sourceDigestFormat === "conversation-original-v1"
        ? readConversationOriginal(this.sql, conversationId, summary.id, value.coveredThroughSequence)?.digest
        : original && createHash("sha256").update(JSON.stringify(original)).digest("hex");
      if (!original || digest !== value.sourceDigests[summary.id]) throw new Error("Conversation memory source changed");
      return { id: summary.id, summary: summary.text, user: original?.user ?? "", assistant: original?.assistant ?? null };
    }) };
  }
  async prepare(conversationId: string, before: number, provider: LlmProvider, signal: AbortSignal): Promise<string | undefined> {
    if (before <= 1) return undefined;
    if(!this.sql.prepare(`SELECT 1 FROM desktop_conversation_messages m WHERE m.conversation_id=? AND m.sequence<?
      AND NOT EXISTS (SELECT 1 FROM desktop_replies pending WHERE pending.conversation_id=m.conversation_id
        AND pending.message_command_id=m.command_id AND pending.state IN ('queued','withdrawn','cancelled')) LIMIT 1`).get(conversationId,before))return undefined;
    const cache = {
      get: (key: string) => (this.sql.prepare("SELECT body FROM desktop_conversation_memory WHERE id=? AND conversation_id=?").get(key, conversationId) as { body: string } | undefined)?.body,
      put: (key: string, text: string) => {
        this.sql.prepare("INSERT OR IGNORE INTO desktop_conversation_memory VALUES (?,?,?)").run(key, conversationId, text);
      },
    };
    const compactor = new SemanticContextCompactor({ extractJson: input => provider.extractJson(input) }, cache, 16000);
    const budget = resolveContextBudget(provider.contextLimits);
    const hash=createHash("sha256").update("[");let count=0;const first:OriginalRow[]=[],last:OriginalRow[]=[];
    const source=function*(sql:Database.Database){for(const row of originalRows(sql,conversationId,before,false)){
      if(count)hash.update(",");hash.update(JSON.stringify(row));count++;
      if(first.length<8)first.push(row);last.push(row);if(last.length>8)last.shift();yield row;
    }};
    const history = await summarizeHistory(source(this.sql), { id: conversationId, caseId: conversationId, runId: conversationId, consumer: "desktop-conversation" },
      budget.input, Math.min(8192, budget.output, Math.max(128, Math.floor(budget.target / 4))), compactor, cache, signal);
    if(history.covered!==count)throw new Error("Conversation memory coverage is incomplete");
    hash.update("]");
    // The existing detail viewer shows bounded source examples. The summary
    // itself now covers every row before the boundary, not just those examples.
    const selected=[...new Map([...first,...last].map(row=>[row.id,row])).values()];
    const summaries = selected.map((row, index) => ({ id: row.id, text: index === 0 ? `合并摘要（覆盖此前 ${count} 条消息，不仅是下方这一条原文）：\n${history.summary}` : "这条原文已纳入上方的历史合并摘要。" }));
    return JSON.stringify({ trust: "untrusted_incomplete_conversation_summary", conversationId,
      version: 2, coveredThroughSequence: before - 1, coveredMessages: count, historyDigest: history.digest,
      sourceDigest: hash.digest("hex"),
      originalMessageIds: selected.map(row => row.id), omittedMessageCount: 0, detailExamplesOmitted: count - selected.length,
      sourceDigestFormat: "conversation-original-v1",
      sourceDigests: Object.fromEntries(selected.map(row => [row.id, readConversationOriginal(this.sql, conversationId, row.id, before - 1)!.digest])),
      summaries });
  }
}
