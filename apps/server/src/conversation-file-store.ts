import type Database from "better-sqlite3";
import {randomUUID,createHash} from "node:crypto";
import type {MessageAttachment} from "@traceforge/shared/message-attachments";
import {readPdfPages} from "./pdf-pages.js";

export class ConversationFileStore{
  constructor(private sql:Database.Database){sql.exec(`CREATE TABLE IF NOT EXISTS desktop_attachment_files(
    id TEXT PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL,bytes BLOB NOT NULL,digest TEXT NOT NULL,pages INTEGER,
    conversation_id TEXT,command_id TEXT,created_at INTEGER NOT NULL,
    FOREIGN KEY(conversation_id,command_id) REFERENCES desktop_conversation_messages(conversation_id,command_id) ON DELETE CASCADE);
    CREATE TRIGGER IF NOT EXISTS desktop_attachment_files_physical_insert BEFORE INSERT ON desktop_attachment_files BEGIN
      SELECT execution_physical_admit(execution_floor,maximum_database_bytes,maximum_wal_bytes,
        length(NEW.bytes)+2048,'execution') FROM execution_physical_policy WHERE id=1; END;`);}
  async import(name:string,bytes:Buffer):Promise<MessageAttachment>{
    if(!name||name.length>200||bytes.length>32*1048576||!bytes.length)throw new Error("file_size_or_name_invalid");
    let pages:number|undefined;let kind:string;
    if(/\.pdf$/i.test(name)){kind="document";pages=(await readPdfPages(bytes)).pages;}
    else if(/\.(txt|md|json|csv|log|yaml|yml|xml|html|css|js|ts|py|sh)$/i.test(name)){
      kind="text";const text=new TextDecoder("utf-8",{fatal:true}).decode(bytes);if(text.includes("\0"))throw new Error("invalid_text");
    }else throw new Error("large_file_type_unsupported");
    return this.sql.transaction(()=>{
      this.sql.prepare("DELETE FROM desktop_attachment_files WHERE conversation_id IS NULL AND created_at<?").run(Date.now()-7*86400000);
      const id=randomUUID();
      this.sql.prepare("INSERT INTO desktop_attachment_files VALUES(?,?,?,?,?,?,NULL,NULL,?)").run(id,name,kind,bytes,createHash("sha256").update(bytes).digest("hex"),pages??null,Date.now());
      return {kind:"reference",id,name} as const;
    })();
  }
  canClaim(items:MessageAttachment[]){return items.every(item=>item.kind!=="reference"||!!this.sql.prepare("SELECT 1 FROM desktop_attachment_files WHERE id=? AND name=? AND conversation_id IS NULL").get(item.id,item.name));}
  claim(items:MessageAttachment[],conversationId:string,commandId:string){
    for(const item of items)if(item.kind==="reference"){
      const result=this.sql.prepare("UPDATE desktop_attachment_files SET conversation_id=?,command_id=? WHERE id=? AND name=? AND conversation_id IS NULL").run(conversationId,commandId,item.id,item.name);
      if(result.changes!==1)throw new Error("attachment_not_available");
    }
  }
  read(id:string,conversationId:string,commandId:string,content=false){
    return this.sql.prepare(`SELECT name,kind,digest,pages,length(bytes) AS size${content?",bytes":""} FROM desktop_attachment_files WHERE id=? AND conversation_id=? AND command_id=?`).get(id,conversationId,commandId) as {name:string;kind:string;digest:string;pages:number|null;size:number;bytes?:Buffer}|undefined;
  }
}
