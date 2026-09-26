import type Database from "better-sqlite3";
import {ReplyQueueCommandSchema,type ReplyQueueCommand} from "@traceforge/shared/desktop-reply-queue";

/** Queue presentation/order over existing replies. It does not own execution. */
export class DesktopReplyQueue {
  constructor(private sql:Database.Database){
    sql.exec(`CREATE TABLE IF NOT EXISTS desktop_reply_queue_settings(c TEXT PRIMARY KEY,revision INTEGER NOT NULL,paused INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS desktop_reply_queue_order(c TEXT NOT NULL,m TEXT NOT NULL,position INTEGER NOT NULL,PRIMARY KEY(c,m));
      CREATE TABLE IF NOT EXISTS desktop_reply_queue_commands(c TEXT NOT NULL,id TEXT NOT NULL,request TEXT NOT NULL,prior_text TEXT,result TEXT NOT NULL,PRIMARY KEY(c,id));
      CREATE TRIGGER IF NOT EXISTS desktop_reply_queue_physical BEFORE INSERT ON desktop_reply_queue_commands BEGIN
        SELECT execution_physical_admit(execution_floor,maximum_database_bytes,maximum_wal_bytes,
          length(CAST(NEW.request AS BLOB))+length(CAST(NEW.result AS BLOB))+coalesce(length(CAST(NEW.prior_text AS BLOB)),0)+2048,'execution')
          FROM execution_physical_policy WHERE id=1; END;`);
  }
  touch(c:string){this.sql.prepare("INSERT INTO desktop_reply_queue_settings VALUES(?,1,0) ON CONFLICT(c) DO UPDATE SET revision=revision+1").run(c);}
  paused(c:string){return !!(this.sql.prepare("SELECT paused FROM desktop_reply_queue_settings WHERE c=?").get(c) as {paused:number}|undefined)?.paused;}
  view(c:string){
    const row=this.sql.prepare("SELECT revision,paused FROM desktop_reply_queue_settings WHERE c=?").get(c) as {revision:number;paused:number}|undefined;
    const items=this.sql.prepare(`SELECT r.message_command_id AS messageId,m.text FROM desktop_replies r
      JOIN desktop_conversation_messages m ON m.conversation_id=r.conversation_id AND m.command_id=r.message_command_id
      LEFT JOIN desktop_reply_queue_order q ON q.c=r.conversation_id AND q.m=r.message_command_id
      WHERE r.conversation_id=? AND r.state='queued' ORDER BY coalesce(q.position,1000000000),r.rowid`).all(c) as {messageId:string;text:string}[];
    return {conversationId:c,revision:row?.revision??0,paused:!!row?.paused,items};
  }
  next(){return this.sql.prepare(`SELECT r.conversation_id AS c,r.message_command_id AS m FROM desktop_replies r
    LEFT JOIN desktop_reply_queue_settings s ON s.c=r.conversation_id
    LEFT JOIN desktop_reply_queue_order q ON q.c=r.conversation_id AND q.m=r.message_command_id
    WHERE r.state='queued' AND coalesce(s.paused,0)=0 ORDER BY coalesce(q.position,1000000000),r.rowid LIMIT 1`).get() as {c:string;m:string}|undefined;}
  change(c:string,raw:ReplyQueueCommand,cancel:(m:string)=>void){
    const input=ReplyQueueCommandSchema.parse(raw),encoded=JSON.stringify(input);
    return this.sql.transaction(()=>{
      const prior=this.sql.prepare("SELECT request,result FROM desktop_reply_queue_commands WHERE c=? AND id=?").get(c,input.commandId) as {request:string;result:string}|undefined;
      if(prior)return prior.request===encoded?{status:200,body:JSON.parse(prior.result)}:{status:409,body:{error:"command_conflict"}};
      const state=this.view(c),op=input.operation;
      if(state.revision!==input.expectedRevision)return {status:409,body:{error:"queue_changed"}};
      let oldText:string|null=null;
      if(op.kind==="pause"){
        this.touch(c);this.sql.prepare("UPDATE desktop_reply_queue_settings SET paused=? WHERE c=?").run(Number(op.paused),c);
      }else if(op.kind==="reorder"){
        if(op.ids.length!==state.items.length||new Set(op.ids).size!==op.ids.length||op.ids.some(id=>!state.items.some(i=>i.messageId===id)))return {status:409,body:{error:"queue_changed"}};
        op.ids.forEach((id,index)=>this.sql.prepare("INSERT INTO desktop_reply_queue_order VALUES(?,?,?) ON CONFLICT(c,m) DO UPDATE SET position=excluded.position").run(c,id,index));this.touch(c);
      }else{
        const item=state.items.find(i=>i.messageId===op.messageId);
        if(!item)return {status:409,body:{error:"already_dispatched"}};
        oldText=item.text;
        if(op.kind==="remove")cancel(op.messageId);
        else{
          this.sql.prepare("UPDATE desktop_conversation_messages SET text=? WHERE conversation_id=? AND command_id=?").run(op.text,c,op.messageId);
          this.touch(c);
        }
      }
      const result=this.view(c);
      this.sql.prepare("INSERT INTO desktop_reply_queue_commands VALUES(?,?,?,?,?)").run(c,input.commandId,encoded,oldText,JSON.stringify(result));
      return {status:200,body:result};
    })();
  }
}
