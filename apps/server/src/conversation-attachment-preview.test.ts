import Fastify from "fastify";
import {it,expect} from "vitest";
import {PDFDocument} from "pdf-lib";
import {createDb,getSqliteClient} from "./db/client.js";
import {registerConversationRoutes} from "./conversation-routes.js";
import {validateConversationRequest} from "../../desktop/src/conversation-bridge.js";

it("previews owned attachments without model calls, pages PDFs, rejects paths and changed identities",async()=>{
 const db=createDb(":memory:"),sql=getSqliteClient(db),app=Fastify();registerConversationRoutes(app,db);
 try{
  const c=(await app.inject({method:"POST",url:"/api/desktop/conversations",payload:{commandId:"create",title:"Preview"}})).json().id;
  const pdf=await PDFDocument.create();pdf.addPage();pdf.addPage();
  const attachments=[{kind:"text",name:"notes.html",text:"<script>not executable</script>"+"x".repeat(18000)},{kind:"document",name:"neutral.pdf",mediaType:"application/pdf",data:Buffer.from(await pdf.save()).toString("base64")}];
  expect((await app.inject({method:"POST",url:`/api/desktop/conversations/${c}/messages`,payload:{commandId:"message",text:"Attached",attachments}})).statusCode).toBe(201);
  const path=`/api/desktop/conversations/${c}/attachments/preview`;
  const read=(input:object)=>app.inject({method:"POST",url:path,payload:input});
  expect(validateConversationRequest({path,method:"POST",body:JSON.stringify({messageId:"message",index:0})}).path).toBe(path);
  expect(()=>validateConversationRequest({path,method:"POST",body:JSON.stringify({messageId:"message",index:0,path:"/etc/passwd"})})).toThrow();
  const first=await read({messageId:"message",index:0});expect(first.statusCode).toBe(200);expect(first.headers["cache-control"]).toBe("no-store");
  expect(first.json()).toMatchObject({kind:"text",nextOffset:16000});
  const next=await read({messageId:"message",index:0,offset:16000,expectedDigest:first.json().digest});expect(next.json().nextOffset).toBeNull();
  expect((await read({messageId:"message",index:0,expectedDigest:"a".repeat(64)})).statusCode).toBe(409);
  expect((await read({messageId:"missing",index:0})).statusCode).toBe(404);
  expect((await read({messageId:"message",index:0,page:2})).statusCode).toBe(400);
  const second=await read({messageId:"message",index:1,page:2});expect(second.statusCode).toBe(200);expect(second.json()).toMatchObject({kind:"pdf",page:2,pages:2});
  expect((await PDFDocument.load(Buffer.from(second.json().data,"base64"))).getPageCount()).toBe(1);
  expect((await read({messageId:"message",index:1,page:3})).statusCode).toBe(409);
 }finally{await app.close();sql.close();}
});
