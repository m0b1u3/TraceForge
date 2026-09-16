import {expect,it,vi} from "vitest";
import {createCipheriv,createDecipheriv,randomBytes} from "node:crypto";
import Fastify from "fastify";
import type {LlmProvider,ModelContinuation} from "@traceforge/llm";
import {createDb,getSqliteClient} from "./db/client.js";
import {registerConversationRoutes} from "./conversation-routes.js";
import {DesktopReplyService} from "./desktop-replies.js";
import {ConversationContinuations} from "./conversation-continuations.js";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";

it("restores encrypted complete provider state after service restart without replaying tools; changed/corrupt history falls back",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"tf-continuation-")),path=join(directory,"state.sqlite");
  let db=createDb(path),sql=getSqliteClient(db),app=Fastify();registerConversationRoutes(app,db);
  const key=randomBytes(32),cipher={encrypt(text:string){const iv=randomBytes(12),c=createCipheriv("aes-256-gcm",key,iv);const data=Buffer.concat([c.update(text,"utf8"),c.final()]);return Buffer.concat([iv,c.getAuthTag(),data]);},decrypt(data:Buffer){const d=createDecipheriv("aes-256-gcm",key,data.subarray(0,12));d.setAuthTag(data.subarray(12,28));return Buffer.concat([d.update(data.subarray(28)),d.final()]).toString();}};
  const continuation:ModelContinuation={connection:"test-connection",state:{protocol:"openai",reasoning:"PRIVATE-CONTINUATION"}};
  let calls=0;const tools=vi.fn();
  const model:LlmProvider={extractJson:vi.fn(),runTools:vi.fn(),streamTools:vi.fn(async(args,handlers)=>{
    calls++;
    if(calls===1)return {done:false,text:"",continuation,toolCalls:[{id:"first-call",name:"conversation_attachments",input:{}}]};
    if(calls===2){tools();handlers.onTextDelta?.("First result");return {done:true,text:"First result",continuation,toolCalls:[]};}
    expect(args.messages.filter(m=>m.continuation)).toHaveLength(2);
    const saved=args.messages.find(m=>m.role==="assistant"&&m.toolCalls?.length)?.toolCalls?.[0].id;
    expect(saved).toMatch(/^saved_/);expect(args.messages.some(m=>m.role==="tool"&&m.toolCallId===saved)).toBe(true);
    handlers.onTextDelta?.("Second result");return {done:true,text:"Second result",continuation,toolCalls:[]};
  })};
  let service=new DesktopReplyService(sql,()=>model,10000,undefined,cipher);
  try{
    const c=(await app.inject({method:"POST",url:"/api/desktop/conversations",payload:{commandId:"create",title:"Continuation"}})).json();
    const send=(id:string)=>app.inject({method:"POST",url:`/api/desktop/conversations/${c.id}/messages`,payload:{commandId:id,text:"Continue"}});
    await send("first");service.start(c.id,"first");
    await vi.waitFor(()=>expect(service.read(c.id,0).body).toMatchObject({replies:[{state:"completed"}]}));
    const sealed=sql.prepare("SELECT sealed FROM desktop_continuations").get() as {sealed:Buffer};expect(sealed.sealed.toString()).not.toContain("PRIVATE-CONTINUATION");
    expect(JSON.stringify(service.read(c.id,0))).not.toContain("PRIVATE-CONTINUATION");
    service.close();await app.close();sql.close();
    db=createDb(path);sql=getSqliteClient(db);app=Fastify();registerConversationRoutes(app,db);
    service=new DesktopReplyService(sql,()=>model,10000,undefined,cipher);
    expect(calls).toBe(2);await send("second");service.start(c.id,"second");
    await vi.waitFor(()=>expect(service.read(c.id,0).body).toMatchObject({replies:[{state:"completed"},{state:"completed"}]}));
    expect(calls).toBe(3);expect(tools).toHaveBeenCalledTimes(1);
    const cache=new ConversationContinuations(sql,cipher);
    expect(cache.read(c.id,"first","First result")).toBeDefined();
    expect(cache.read("other","first","First result")).toBeUndefined();
    sql.prepare("UPDATE desktop_replies SET state='interrupted' WHERE message_command_id='first'").run();
    expect(cache.read(c.id,"first","First result")).toBeUndefined();
    sql.prepare("UPDATE desktop_replies SET state='completed' WHERE message_command_id='first'").run();
    sql.prepare("UPDATE desktop_conversation_messages SET text='changed' WHERE command_id='first'").run();
    expect(cache.read(c.id,"first","First result")).toBeUndefined();
    expect(cache.read(c.id,"second","Second result")).toBeUndefined();
    sql.prepare("UPDATE desktop_continuations SET sealed=x'00'").run();
    expect(cache.read(c.id,"first","First result")).toBeUndefined();
  }finally{service.close();await app.close();sql.close();await rm(directory,{recursive:true,force:true});}
});
