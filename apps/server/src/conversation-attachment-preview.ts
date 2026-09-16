import {createHash} from "node:crypto";
import type Database from "better-sqlite3";
import type {FastifyInstance} from "fastify";
import {AttachmentPreviewRequestSchema,AttachmentPreviewSchema} from "@traceforge/shared/message-attachments";
import {readConversationAttachments} from "./conversation-attachments.js";
import {ConversationFileStore} from "./conversation-file-store.js";
import {ConversationAttachmentReader} from "./conversation-attachment-reader.js";

export function registerAttachmentPreview(app:FastifyInstance,sql:Database.Database){
  app.post("/api/desktop/conversations/:conversationId/attachments/preview",async(request,reply)=>{
    reply.header("Cache-Control","no-store");
    const c=(request.params as {conversationId:string}).conversationId,input=AttachmentPreviewRequestSchema.safeParse(request.body);
    if(!input.success)return reply.code(400).send({error:"invalid_preview"});
    const {messageId,index,page,offset,expectedDigest}=input.data;
    const row=sql.prepare("SELECT m.sequence FROM desktop_conversation_messages m JOIN desktop_conversations c ON c.id=m.conversation_id JOIN cases k ON k.id=c.case_id WHERE c.id=? AND m.command_id=?").get(c,messageId) as {sequence:number}|undefined;
    if(!row)return reply.code(404).send({error:"attachment_unavailable"});
    const source=readConversationAttachments(sql,c,messageId)[index];if(!source)return reply.code(404).send({error:"attachment_unavailable"});
    const digest=createHash("sha256").update(JSON.stringify(source)).digest("hex");
    if(expectedDigest&&expectedDigest!==digest)return reply.code(409).send({error:"attachment_changed"});
    const base={conversationId:c,messageId,index,digest,name:source.name};
    try{
      if(source.kind==="text"){
        if(page!==undefined|| (offset??0)>source.text.length)return reply.code(400).send({error:"invalid_range"});
        const start=offset??0;
        if(start>0&&/[\uDC00-\uDFFF]/.test(source.text[start]??"")&&/[\uD800-\uDBFF]/.test(source.text[start-1]))return reply.code(400).send({error:"invalid_range"});
        let end=Math.min(source.text.length,start+16000);
        if(end<source.text.length&&/[\uD800-\uDBFF]/.test(source.text[end-1]))end--;
        return AttachmentPreviewSchema.parse({...base,kind:"text",text:source.text.slice(offset??0,end),nextOffset:end<source.text.length?end:null});
      }
      if(source.kind==="audio")return reply.code(415).send({error:"preview_unsupported"});
      const isPdf=source.kind==="document"||(source.kind==="reference"&&new ConversationFileStore(sql).read(source.id,c,messageId)?.kind==="pdf");
      if(isPdf&&offset!==undefined||!isPdf&&page!==undefined)return reply.code(400).send({error:"invalid_range"});
      const found=await new ConversationAttachmentReader(sql,c,row.sequence).executeAsync({id:"preview",name:"conversation_attachment_read",input:{messageId,index,digest,...(isPdf?{startPage:page??1,endPage:page??1}:offset!==undefined?{offset}:{})}});
      const attachment=found.attachment,info=found.result as {pages?:number;nextOffset?:number|null};
      if(!attachment)return reply.code(409).send({error:"preview_unavailable"});
      reply.header("Cache-Control","no-store");
      if(attachment.kind==="text")return AttachmentPreviewSchema.parse({...base,kind:"text",text:attachment.text,nextOffset:info.nextOffset??null});
      if(attachment.kind==="image")return AttachmentPreviewSchema.parse({...base,kind:"image",mediaType:attachment.mediaType,data:attachment.data});
      if(attachment.kind==="document")return AttachmentPreviewSchema.parse({...base,kind:"pdf",mediaType:attachment.mediaType,data:attachment.data,page:page??1,pages:info.pages});
      return reply.code(415).send({error:"preview_unsupported"});
    }catch{return reply.code(409).send({error:"preview_unavailable"});}
  });
}
