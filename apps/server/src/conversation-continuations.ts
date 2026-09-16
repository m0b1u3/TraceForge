import type Database from "better-sqlite3";
import {createHash} from "node:crypto";
import type {TurnMessage} from "@traceforge/llm";
import {readConversationAttachments} from "./conversation-attachments.js";

export interface ContinuationCipher { encrypt(text:string):Buffer; decrypt(bytes:Buffer):string }
const hash=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Optional host-encrypted cache. Never an execution checkpoint or authority to replay tools. */
export class ConversationContinuations {
  constructor(private sql:Database.Database,private cipher:ContinuationCipher){
    sql.exec("CREATE TABLE IF NOT EXISTS desktop_continuations(conversation_id TEXT NOT NULL,message_id TEXT NOT NULL,sealed BLOB NOT NULL,PRIMARY KEY(conversation_id,message_id))");
  }
  private binding(conversationId:string,messageId:string,response:string){
    const rows=this.sql.prepare(`SELECT m.command_id,m.text,r.text AS reply FROM desktop_conversation_messages m
      LEFT JOIN desktop_replies r ON r.conversation_id=m.conversation_id AND r.message_command_id=m.command_id AND r.state='completed'
      WHERE m.conversation_id=? AND m.sequence<=(SELECT sequence FROM desktop_conversation_messages WHERE conversation_id=? AND command_id=?) ORDER BY m.sequence`).all(conversationId,conversationId,messageId) as {command_id:string;text:string;reply:string|null}[];
    return hash(rows.map(row=>[row.command_id,row.text,row.command_id===messageId?response:row.reply,readConversationAttachments(this.sql,conversationId,row.command_id)]));
  }
  save(conversationId:string,messageId:string,response:string,messages:TurnMessage[]){
    const row=this.sql.prepare("SELECT text FROM desktop_conversation_messages WHERE conversation_id=? AND command_id=?").get(conversationId,messageId) as {text:string}|undefined;
    if(!row)return;
    if(!messages.some(message=>message.continuation)||!validMessages(messages))return;
    const text=JSON.stringify({version:1,conversationId,messageId,binding:this.binding(conversationId,messageId,response),messages});
    if(Buffer.byteLength(text)>4*1048576)return;
    const sealed=this.cipher.encrypt(text);
    this.sql.transaction(()=>{
      this.sql.prepare("DELETE FROM desktop_continuations WHERE NOT EXISTS(SELECT 1 FROM desktop_conversation_messages m WHERE m.conversation_id=desktop_continuations.conversation_id AND m.command_id=desktop_continuations.message_id)").run();
      let size=(this.sql.prepare("SELECT coalesce(sum(length(sealed)),0) AS bytes FROM desktop_continuations").get() as {bytes:number}).bytes;
      // Cache eviction never removes visible conversation or execution records.
      while(size+sealed.length>32*1048576){
        const oldest=this.sql.prepare("SELECT rowid,length(sealed) AS bytes FROM desktop_continuations ORDER BY rowid LIMIT 1").get() as {rowid:number;bytes:number}|undefined;
        if(!oldest)return;
        this.sql.prepare("DELETE FROM desktop_continuations WHERE rowid=?").run(oldest.rowid);size-=oldest.bytes;
      }
      this.sql.prepare("INSERT OR REPLACE INTO desktop_continuations VALUES (?,?,?)").run(conversationId,messageId,sealed);
    })();
  }
  read(conversationId:string,messageId:string,response:string):TurnMessage[]|undefined{
    try{
      const row=this.sql.prepare(`SELECT c.sealed,m.text FROM desktop_continuations c JOIN desktop_conversation_messages m ON m.conversation_id=c.conversation_id AND m.command_id=c.message_id
        JOIN desktop_replies r ON r.conversation_id=c.conversation_id AND r.message_command_id=c.message_id WHERE c.conversation_id=? AND c.message_id=? AND r.state='completed' AND r.text=?`).get(conversationId,messageId,response) as {sealed:Buffer;text:string}|undefined;
      if(!row)return;
      const value=JSON.parse(this.cipher.decrypt(row.sealed));
      if(value.version!==1||value.conversationId!==conversationId||value.messageId!==messageId||value.binding!==this.binding(conversationId,messageId,response)||!validMessages(value.messages))return;
      return value.messages;
    }catch{return;}
  }
}

function validMessages(messages:unknown):messages is TurnMessage[]{
  if(!Array.isArray(messages)||!messages.length||messages.length>64)return false;
  const pending=new Set<string>(),used=new Set<string>();
  for(const message of messages){
    if(!message||!["assistant","user","tool"].includes(message.role)||typeof message.content!=="string")return false;
    if(message.role==="tool"){
      if(!pending.delete(message.toolCallId)||message.toolCalls?.length)return false;
    }else{
      if(pending.size)return false;
      if(message.toolCalls){
        if(message.role!=="assistant"||!Array.isArray(message.toolCalls))return false;
        for(const call of message.toolCalls){if(!call||typeof call.id!=="string"||!call.id||used.has(call.id)||typeof call.name!=="string")return false;used.add(call.id);pending.add(call.id);}
      }
    }
    if(message.continuation&&(message.role!=="assistant"||typeof message.continuation.connection!=="string"||!["openai","responses","anthropic"].includes(message.continuation.state?.protocol)))return false;
  }
  return pending.size===0&&messages.at(-1).role==="assistant"&&!messages.at(-1).toolCalls?.length;
}
