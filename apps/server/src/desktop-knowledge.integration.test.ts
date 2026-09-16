import {expect,it,vi} from "vitest";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import Fastify from "fastify";
import type {LlmProvider} from "@traceforge/llm";
import {createDb,getSqliteClient} from "./db/client.js";
import {registerConversationRoutes} from "./conversation-routes.js";
import {DesktopReplyService} from "./desktop-replies.js";

it("persists sourced topic sections in the production conversation loop and reuses them after restart without new synthesis",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"tf-knowledge-")),path=join(directory,"state.db");
  let db=createDb(path),sql=getSqliteClient(db),app=Fastify();registerConversationRoutes(app,db);
  let turns=0;
  const provider:LlmProvider={extractJson:vi.fn(),runTools:vi.fn(),streamTools:vi.fn(async(args,handlers)=>{
    turns++;
    if(turns===1)return {text:"",done:false,toolCalls:[{id:"find",name:"memory_recall",input:{query:"condition"}}]};
    if(turns===2){
      const found=JSON.parse(args.messages.at(-1)!.content).matches[0];
      return {text:"",done:false,toolCalls:[{id:"remember",name:"memory_update",input:{key:"conditions",kind:"topic",title:"Current conditions",text:"An initial condition remains unresolved, not a verified conclusion.",expectedRevision:0,status:"active",sources:[{id:found.id,digest:found.digest}]}}]};
    }
    if(turns===4){
      expect(args.messages.some(m=>m.content.includes('"trust":"untrusted_topic_memory"')&&m.content.includes("initial condition remains unresolved"))).toBe(true);
    }
    handlers.onTextDelta?.("Saved context, not proof.");return {text:"Saved context, not proof.",done:true,toolCalls:[]};
  })};
  let replies=new DesktopReplyService(sql,()=>provider);
  try{
    const conversation=(await app.inject({method:"POST",url:"/api/desktop/conversations",payload:{commandId:"create",title:"Knowledge"}})).json();
    const send=(id:string,text:string)=>app.inject({method:"POST",url:`/api/desktop/conversations/${conversation.id}/messages`,payload:{commandId:id,text}});
    await send("source","The initial condition remains unresolved.");await send("request","Remember our current conditions.");
    replies.start(conversation.id,"request");
    await vi.waitFor(()=>expect(replies.read(conversation.id,0).body).toMatchObject({replies:[{state:"completed"}]}));
    expect(sql.prepare("SELECT count(*) AS n FROM desktop_knowledge_versions").get()).toEqual({n:1});
    replies.close();await app.close();sql.close();db=createDb(path);sql=getSqliteClient(db);app=Fastify();registerConversationRoutes(app,db);replies=new DesktopReplyService(sql,()=>provider);
    expect(turns).toBe(3);expect(provider.extractJson).not.toHaveBeenCalled();
    await send("next","Continue our discussion.");replies.start(conversation.id,"next");
    await vi.waitFor(()=>expect(replies.read(conversation.id,0).body).toMatchObject({replies:[{state:"completed"},{state:"completed"}]}));
    expect(turns).toBe(4);expect(provider.extractJson).not.toHaveBeenCalled();
    expect(sql.prepare("SELECT count(*) AS n FROM desktop_knowledge_versions").get()).toEqual({n:1});
  }finally{replies.close();await app.close();sql.close();await rm(directory,{recursive:true,force:true});}
});
