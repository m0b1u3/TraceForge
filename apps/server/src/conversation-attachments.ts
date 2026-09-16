import type Database from "better-sqlite3";
import { MessageAttachmentsSchema } from "@traceforge/shared/message-attachments";

export function initializeConversationAttachments(sql:Database.Database){
  sql.exec(`CREATE TABLE IF NOT EXISTS desktop_message_attachments (
    conversation_id TEXT NOT NULL, command_id TEXT NOT NULL, content_json TEXT NOT NULL,
    PRIMARY KEY(conversation_id,command_id),
    FOREIGN KEY(conversation_id,command_id) REFERENCES desktop_conversation_messages(conversation_id,command_id) ON DELETE CASCADE)`);
}
export function readConversationAttachments(sql:Database.Database,conversationId:string,commandId:string){
  if(!sql.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='desktop_message_attachments'").get())return [];
  const row=sql.prepare("SELECT content_json FROM desktop_message_attachments WHERE conversation_id=? AND command_id=?").get(conversationId,commandId) as {content_json:string}|undefined;
  return row?MessageAttachmentsSchema.parse(JSON.parse(row.content_json)):[];
}
