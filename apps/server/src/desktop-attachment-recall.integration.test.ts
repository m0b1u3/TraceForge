import {expect,it,vi} from "vitest";
import Fastify from "fastify";
import type {LlmProvider} from "@traceforge/llm";
import {createDb,getSqliteClient} from "./db/client.js";
import {registerConversationRoutes} from "./conversation-routes.js";
import {DesktopReplyService} from "./desktop-replies.js";
import {PDFDocument} from "pdf-lib";

it("feeds only requested PDF pages through the actual desktop tool loop",async()=>{
  const db=createDb(":memory:"),sql=getSqliteClient(db),app=Fastify();registerConversationRoutes(app,db);
  let service:DesktopReplyService|undefined;
  try{
    const doc=await PDFDocument.create();for(let n=1;n<=3;n++)doc.addPage([200+n,300]);
    const ref=(await app.inject({method:"POST",url:"/api/desktop/attachment-import",payload:{name:"reference.pdf",data:Buffer.from(await doc.save()).toString("base64")}})).json();
    const c=(await app.inject({method:"POST",url:"/api/desktop/conversations",payload:{commandId:"create",title:"PDF"}})).json();
    await app.inject({method:"POST",url:`/api/desktop/conversations/${c.id}/messages`,payload:{commandId:"read",text:"Read page 2",attachments:[ref]}});
    let turn=0;
    const model:LlmProvider={extractJson:vi.fn(),runTools:vi.fn(),streamTools:vi.fn(async(args,handlers)=>{
      if(turn++===0){expect(args.messages.at(-1)?.attachments?.[0].kind).toBe("reference");return {done:false,text:"",toolCalls:[{id:"list",name:"conversation_attachments",input:{}}]};}
      if(turn===2){const match=JSON.parse(args.messages.at(-1)!.content).matches[0];return {done:false,text:"",toolCalls:[{id:"read",name:"conversation_attachment_read",input:{messageId:match.messageId,index:match.index,digest:match.digest,startPage:2,endPage:2}}]};}
      const part=args.messages.at(-1)!.attachments![0];expect(part.kind).toBe("document");
      const pdf=await PDFDocument.load(Buffer.from((part as any).data,"base64"));expect(pdf.getPageCount()).toBe(1);expect(pdf.getPage(0).getWidth()).toBe(202);
      handlers.onTextDelta?.("Page read");return {done:true,text:"Page read",toolCalls:[]};
    })};
    service=new DesktopReplyService(sql,()=>model);service.start(c.id,"read");
    await vi.waitFor(()=>expect(service!.read(c.id,0).body).toMatchObject({replies:[{state:"completed"}]}));
    expect(turn).toBe(3);
    const receipts=JSON.stringify(sql.prepare("SELECT result_json FROM desktop_reply_reads").all());
    expect(receipts).toContain("startPage");expect(receipts).not.toContain("JVBER");
  }finally{service?.close();await app.close();sql.close();}
});

it.each([true,false])("reloads omitted binary originals in the actual conversation loop (supported=%s)",async supported=>{
  const db=createDb(":memory:"),sql=getSqliteClient(db),app=Fastify();registerConversationRoutes(app,db);
  let service:DesktopReplyService|undefined;
  try{
    const c=(await app.inject({method:"POST",url:"/api/desktop/conversations",payload:{commandId:"create",title:"Recall"}})).json();
    const image={kind:"image",name:"old.png",mediaType:"image/png",data:"iVBORw0KGgo="};
    await app.inject({method:"POST",url:`/api/desktop/conversations/${c.id}/messages`,payload:{commandId:"old",text:"Original",attachments:[image]}});
    for(let n=2;n<=31;n++)sql.prepare("INSERT INTO desktop_conversation_messages VALUES (?,?,?,?,?)").run(c.id,`m${n}`,n,n===31?"Find the old attachment":"Neutral older discussion. ".repeat(200),"now");
    let turn=0;
    const model:LlmProvider={contextLimits:{contextWindowTokens:16384,maxOutputTokens:512},validateInput:()=>{if(!supported)throw new Error("unsupported");},extractJson:async()=>{throw new Error("summary unavailable");},runTools:vi.fn(),streamTools:vi.fn(async(args,handlers)=>{
      if(turn++===0){expect(args.messages.some(m=>m.attachments?.length)).toBe(false);return {text:"",done:false,toolCalls:[{id:"list",name:"conversation_attachments",input:{query:"old.png"}}]};}
      if(turn===2){const listed=JSON.parse(args.messages.findLast(m=>m.role==="tool")!.content).matches[0];const input={messageId:listed.messageId,index:listed.index,digest:listed.digest};return {text:"",done:false,toolCalls:[{id:"read1",name:"conversation_attachment_read",input},{id:"read2",name:"conversation_attachment_read",input}]};}
      const supplied=args.messages.filter(m=>m.attachments?.length);
      expect(supplied).toHaveLength(supported?1:0);
      if(supported){expect(supplied[0].attachments).toEqual([image]);expect(args.messages.at(-2)?.role).toBe("tool");}
      else expect(args.messages.filter(m=>m.role==="tool").at(-1)?.content).toContain("attachment_input_unavailable");
      handlers.onTextDelta?.("Finished");return {text:"Finished",done:true,toolCalls:[]};
    })};
    service=new DesktopReplyService(sql,()=>model);service.start(c.id,"m31");
    await vi.waitFor(()=>expect(service!.read(c.id,0).body).toMatchObject({replies:[{state:"completed",contextTruncated:true}]}));
    const reads=sql.prepare("SELECT result_json FROM desktop_reply_reads").all();expect(JSON.stringify(reads)).not.toContain(image.data);
    expect(model.streamTools).toHaveBeenCalledTimes(3);
  }finally{service?.close();await app.close();sql.close();}
});
