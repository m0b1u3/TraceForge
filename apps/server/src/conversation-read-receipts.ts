import type Database from "better-sqlite3";

/** Read activity projected from the existing tool log, never a reply mode or completion gate. */
export function conversationReadReceipts(sql: Database.Database, conversationId: string, messageId: string) {
  const rows = sql.prepare("SELECT tool,result_json FROM desktop_reply_reads WHERE conversation_id=? AND message_id=? ORDER BY ordinal").all(conversationId, messageId) as { tool: string; result_json: string }[];
  return rows.flatMap(row => {
    const result = JSON.parse(row.result_json);
    if (row.tool === "conversation_read" && !result.error && typeof result.text === "string" && result.text.length && typeof result.digest === "string")
      return [{ id: result.id, digest: result.digest, start: result.offset, end: result.offset + result.text.length }];
    if (row.tool === "conversation_read_sources" && !result.error && Array.isArray(result.sources))
      return result.sources.filter((s: {text?:unknown;digest?:unknown}) => typeof s.text === "string" && s.text.length && typeof s.digest === "string").map((s: {id:string;digest:string;text:string}) => ({id:s.id,digest:s.digest,start:0,end:s.text.length}));
    return [];
  });
}
