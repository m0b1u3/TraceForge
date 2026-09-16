import {expect,it} from "vitest";
import Fastify from "fastify";
import {PDFDocument} from "pdf-lib";
import {createDb,getSqliteClient} from "./db/client.js";
import {registerConversationRoutes} from "./conversation-routes.js";
import {ConversationAttachmentReader} from "./conversation-attachment-reader.js";
import {randomBytes} from "node:crypto";

it("imports host files, binds references once, pages PDFs and slices large text without leaking bytes",async()=>{
  const db=createDb(":memory:"),sql=getSqliteClient(db),app=Fastify();registerConversationRoutes(app,db);
  try{
    const c=(await app.inject({method:"POST",url:"/api/desktop/conversations",payload:{commandId:"first",title:"Files"}})).json();
    const pdf=await PDFDocument.create();for(let n=0;n<3;n++)pdf.addPage().drawText(`Page ${n+1}`);
    await pdf.attach(randomBytes(1100000),"synthetic-data.bin");
    const original=await pdf.save();expect(original.length).toBeGreaterThan(1048576);
    const ref=(await app.inject({method:"POST",url:"/api/desktop/attachment-import",payload:{name:"book.pdf",data:Buffer.from(original).toString("base64")}})).json();
    expect(ref).toMatchObject({kind:"reference",name:"book.pdf"});expect(ref.data).toBeUndefined();
    const url=`/api/desktop/conversations/${c.id}/messages`,payload={commandId:"m1",text:"Read",attachments:[ref]};
    expect((await app.inject({method:"POST",url,payload})).statusCode).toBe(201);
    expect((await app.inject({method:"POST",url,payload})).statusCode).toBe(200);
    expect((await app.inject({method:"POST",url,payload:{...payload,commandId:"m2"}})).statusCode).toBe(409);
    const reader=new ConversationAttachmentReader(sql,c.id,2);
    const matches=(reader.execute({id:"index",name:"conversation_attachments",input:{}}).result as any).matches;
    expect(matches[0]).toMatchObject({pages:3,storedKind:"document"});
    const input={messageId:"m1",index:0,digest:matches[0].digest,startPage:2,endPage:3};
    const result=await reader.executeAsync({id:"read",name:"conversation_attachment_read",input});
    expect(result.result).toMatchObject({startPage:2,endPage:3,pages:3});
    expect((await PDFDocument.load(Buffer.from((result.attachment as any).data,"base64"))).getPageCount()).toBe(2);
    expect((await new ConversationAttachmentReader(sql,"other",2).executeAsync({id:"read",name:"conversation_attachment_read",input})).result).toEqual({error:"attachment_not_available"});
    const text="a".repeat(1100000)+"tail";
    const txt=(await app.inject({method:"POST",url:"/api/desktop/attachment-import",payload:{name:"large.txt",data:Buffer.from(text).toString("base64")}})).json();
    expect((await app.inject({method:"POST",url,payload:{commandId:"m2",text:"Read text",attachments:[txt]}})).statusCode).toBe(201);
    const meta=(reader.execute({id:"index",name:"conversation_attachments",input:{query:"large"}}).result as any).matches[0];
    const part=await reader.executeAsync({id:"part",name:"conversation_attachment_read",input:{messageId:"m2",index:0,digest:meta.digest,offset:1100000}});
    expect(part.attachment).toMatchObject({kind:"text",text:"tail"});expect(part.result).toMatchObject({nextOffset:null});
    sql.prepare("UPDATE desktop_attachment_files SET bytes=? WHERE id=?").run(Buffer.from("Changed"),txt.id);
    expect((await reader.executeAsync({id:"part",name:"conversation_attachment_read",input:{messageId:"m2",index:0,digest:meta.digest}})).result).toEqual({error:"attachment_changed"});
  }finally{await app.close();sql.close();}
});
