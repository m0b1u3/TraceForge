import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { LlmToolDefinition, ToolCall } from "@traceforge/llm";
import { z } from "zod";
import type { MessageAttachment } from "@traceforge/shared/message-attachments";
import { readConversationAttachments } from "./conversation-attachments.js";
import {ConversationFileStore} from "./conversation-file-store.js";
import {readPdfPages} from "./pdf-pages.js";

const indexInput=z.object({after:z.number().int().min(0).max(2000).optional(),query:z.string().max(160).optional()}).strict();
const readInput=z.object({messageId:z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),index:z.number().int().min(0).max(3),digest:z.string().regex(/^[a-f0-9]{64}$/),startPage:z.number().int().min(1).optional(),endPage:z.number().int().min(1).optional(),offset:z.number().int().min(0).max(33554432).optional()}).strict();
const digest=(item:MessageAttachment)=>createHash("sha256").update(JSON.stringify(item)).digest("hex");
export const conversationAttachmentTools:LlmToolDefinition[]=[
  {name:"conversation_attachments",description:"List saved attachment metadata in this conversation, including old attachments omitted by compaction. Optional literal filename query. Follow nextAfter even when matches is empty. No original bytes are returned.",input_schema:{type:"object",additionalProperties:false,properties:{after:{type:"integer",minimum:0,maximum:2000},query:{type:"string",maxLength:160}}}},
  {name:"conversation_attachment_read",description:"Read a saved attachment by messageId, index and digest. PDF: startPage/endPage are inclusive 1-based (at most 8 pages); stored PDFs default to page 1. Large UTF-8 text: offset is a character offset, follow nextOffset. Original content is supplied separately on the next turn. Errors do not mean the file was read.",input_schema:{type:"object",additionalProperties:false,required:["messageId","index","digest"],properties:{messageId:{type:"string"},index:{type:"integer",minimum:0,maximum:3},digest:{type:"string"},startPage:{type:"integer",minimum:1},endPage:{type:"integer",minimum:1},offset:{type:"integer",minimum:0}}}},
];

/** Scope and temporal cutoff are host-owned, never caller-selectable. */
export class ConversationAttachmentReader {
  constructor(private sql:Database.Database,private conversationId:string,private through:number){}
  async executeAsync(call:ToolCall):Promise<{result:unknown;attachment?:MessageAttachment;identity?:string}>{
    const found=this.execute(call);
    if(!found.attachment)return found;
    const input=readInput.parse(call.input);let attachment=found.attachment;
    let sourceDigest=input.digest;let sourcePages:number|undefined;
    if(attachment.kind==="reference"){
      const file=new ConversationFileStore(this.sql).read(attachment.id,this.conversationId,input.messageId,true);
      if(!file?.bytes)return {result:{error:"attachment_not_available"}};
      if(createHash("sha256").update(file.bytes).digest("hex")!==file.digest)return {result:{error:"attachment_changed"}};
      sourceDigest=file.digest;sourcePages=file.pages??undefined;
      if(file.kind==="text"){
        if(input.startPage!==undefined||input.endPage!==undefined)return {result:{error:"page_range_requires_pdf"}};
        const text=file.bytes.toString("utf8"),offset=input.offset??0;
        if(offset>text.length)return {result:{error:"offset_out_of_range"}};
        if(offset>0&&/[\uDC00-\uDFFF]/.test(text[offset]??"")&&/[\uD800-\uDBFF]/.test(text[offset-1]))return {result:{error:"offset_splits_character"}};
        let end=Math.min(text.length,offset+16000);
        if(end<text.length&&/[\uD800-\uDBFF]/.test(text[end-1]))end--;
        return {result:{...(found.result as object),sourceDigest,offset,nextOffset:end<text.length?end:null},attachment:{kind:"text",name:file.name,text:text.slice(offset,end)},identity:`${found.identity}:${offset}`};
      }
      attachment={kind:"document",name:file.name,mediaType:"application/pdf",data:file.bytes.toString("base64")};
    }
    if(attachment.kind==="document"&&(found.attachment.kind==="reference"||input.startPage!==undefined||input.endPage!==undefined)){
      if(input.offset!==undefined)return {result:{error:"text_offset_requires_text"}};
      const start=input.startPage??1,end=input.endPage??start;
      try{
        const slice=await readPdfPages(Buffer.from(attachment.data,"base64"),start,end);
        return {result:{...(found.result as object),sourceDigest,pages:sourcePages??slice.pages,startPage:start,endPage:end},attachment:{...attachment,name:`${attachment.name} (pages ${start}-${end}).pdf`,data:Buffer.from(slice.data!).toString("base64")},identity:`${found.identity}:${start}-${end}`};
      }catch(error){return {result:{error:error instanceof Error?error.message:"pdf_read_failed"}};}
    }
    if(input.startPage!==undefined||input.endPage!==undefined||input.offset!==undefined)return {result:{error:"range_not_supported_for_attachment"}};
    return found;
  }
  execute(call:ToolCall):{result:unknown;attachment?:MessageAttachment;identity?:string}{
    if(call.name==="conversation_attachments"){
      const {after=0,query=""}=indexInput.parse(call.input);
      if(!this.sql.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='desktop_message_attachments'").get())return {result:{matches:[],nextAfter:null}};
      const rows=this.sql.prepare(`SELECT m.command_id AS id,m.sequence FROM desktop_conversation_messages m JOIN desktop_message_attachments a ON a.conversation_id=m.conversation_id AND a.command_id=m.command_id
        WHERE m.conversation_id=? AND m.sequence<=? AND m.sequence>? AND EXISTS (SELECT 1 FROM json_each(a.content_json) j WHERE instr(lower(json_extract(j.value,'$.name')),lower(?))>0)
        ORDER BY m.sequence LIMIT 6`).all(this.conversationId,this.through,after,query) as {id:string;sequence:number}[];
      const matches=rows.slice(0,5).flatMap(row=>readConversationAttachments(this.sql,this.conversationId,row.id).map((item,index)=>({messageId:row.id,sequence:row.sequence,index,name:item.name,kind:item.kind,digest:digest(item)}))).filter(item=>item.name.toLowerCase().includes(query.toLowerCase()));
      const files=new ConversationFileStore(this.sql);
      const enriched=matches.map(match=>{const item=readConversationAttachments(this.sql,this.conversationId,match.messageId)[match.index];const file=item?.kind==="reference"?files.read(item.id,this.conversationId,match.messageId):undefined;return file?{...match,storedKind:file.kind,bytes:file.size,pages:file.pages,sourceDigest:file.digest}:match;});
      return {result:{trust:"untrusted_attachment_metadata",matches:enriched,nextAfter:rows.length>5?rows[4].sequence:null}};
    }
    if(call.name!=="conversation_attachment_read")throw new Error("Unsupported attachment tool");
    const input=readInput.parse(call.input);
    if(!this.sql.prepare("SELECT 1 FROM desktop_conversation_messages WHERE conversation_id=? AND command_id=? AND sequence<=?").get(this.conversationId,input.messageId,this.through))return {result:{error:"attachment_not_available"}};
    const attachment=readConversationAttachments(this.sql,this.conversationId,input.messageId)[input.index];
    if(!attachment)return {result:{error:"attachment_not_available"}};
    if(digest(attachment)!==input.digest)return {result:{error:"attachment_changed"}};
    const identity=`${input.messageId}:${input.index}:${input.digest}`;
    return {result:{status:"loaded",messageId:input.messageId,index:input.index,digest:input.digest,name:attachment.name,kind:attachment.kind,trust:"user_supplied_file_not_authorization"},attachment,identity};
  }
}
