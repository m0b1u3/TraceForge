import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import type { LlmProvider, StreamToolsHandlers, RunToolsArgs, RunTurn } from "@traceforge/llm";
import { createDb, getSqliteClient } from "./db/client.js";
import { registerConversationRoutes } from "./conversation-routes.js";
import { DesktopReplyService, registerDesktopReplyRoutes } from "./desktop-replies.js";
import { DesktopReplySchema } from "@traceforge/shared/desktop-replies";
import { validateConversationRequest } from "../../desktop/src/conversation-bridge.js";

const cleanup: Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0))await close();});
async function fixture(timeout=120000){
  const db=createDb(":memory:"),sql=getSqliteClient(db),app=Fastify();
  let handlers!:StreamToolsHandlers,args!:RunToolsArgs,finish!:(turn:RunTurn)=>void,fail!:(error:Error)=>void;
  const provider:LlmProvider={extractJson:vi.fn(),runTools:vi.fn(),streamTools:vi.fn((input,callbacks)=>{
    args=input;handlers=callbacks;
    return new Promise<RunTurn>((resolve,reject)=>{finish=resolve;fail=reject;callbacks.signal?.addEventListener("abort",()=>reject(new Error("aborted")),{once:true});});
  })};
  let available=true;
  const service=new DesktopReplyService(sql,()=>{if(!available)throw new Error("secret should not escape");return provider;},timeout);
  registerConversationRoutes(app,db);registerDesktopReplyRoutes(app,service);await app.ready();
  cleanup.push(async()=>{await app.close();sql.close();});
  const call=(url:string,body?:object)=>app.inject({url,method:body?"POST":"GET",...(body?{payload:body}:{})});
  const conversation=(await call("/api/desktop/conversations",{commandId:"create",title:"Neutral discussion"})).json();
  const base=`/api/desktop/conversations/${conversation.id}`;
  await call(`${base}/messages`,{commandId:"message",text:"Explain the next step without executing it"});
  return {sql,app,service,provider,base,conversation,call,unavailable:()=>{available=false;},args:()=>args,handlers:()=>handlers,finish:(text:string)=>finish({text,done:true,toolCalls:[]}),invalid:()=>finish({text:"partial",done:true,toolCalls:[{id:"tool",name:"not.authorized",input:{}}]}),fail:()=>fail(new Error("upstream secret"))};
}
it("persists real deltas before completion; reads and repeated commands never invoke twice",async()=>{
  const f=await fixture();
  expect((await f.call(`${f.base}/replies?after=0`)).json().replies).toEqual([]);
  expect(f.provider.streamTools).not.toHaveBeenCalled();
  const started=await f.call(`${f.base}/replies/message`,{});
  expect(started.statusCode).toBe(202);expect(f.args().tools).toEqual([]);
  expect(DesktopReplySchema.parse(started.json()).state).toBe("streaming");
  f.handlers().onTextDelta?.("First part ");
  await vi.waitFor(async()=>expect((await f.call(`${f.base}/replies?after=0`)).json().replies[0].text).toBe("First part "));
  const partial=(await f.call(`${f.base}/replies?after=0`)).json().replies[0];
  expect(partial.state).toBe("streaming");
  expect((await f.call(`${f.base}/replies/message`,{})).statusCode).toBe(200);
  f.handlers().onTextDelta?.("and final.");f.finish("First part and final.");
  await vi.waitFor(async()=>expect((await f.call(`${f.base}/replies?after=${partial.revision}`)).json().replies[0].state).toBe("completed"));
  await f.call(`${f.base}/replies/message`,{});expect(f.provider.streamTools).toHaveBeenCalledTimes(1);
  expect((await f.call(`${f.base}/execution`)).statusCode).toBe(404);
});
it("cancel flushes partial text and ignores late deltas/completion",async()=>{
  const f=await fixture();await f.call(`${f.base}/replies/message`,{});f.handlers().onTextDelta?.("partial");
  const stop=(await f.call(`${f.base}/replies/message/cancel`,{})).json();
  expect(stop).toMatchObject({state:"cancelled",text:"partial"});expect(f.handlers().signal?.aborted).toBe(true);
  f.handlers().onTextDelta?.("late");f.finish("partiallate");
  expect((await f.call(`${f.base}/replies/message`,{})).json()).toEqual(stop);
  expect(f.provider.streamTools).toHaveBeenCalledTimes(1);
});
it("host restart recovers interrupted snapshots without replaying inference",async()=>{
  const f=await fixture();await f.call(`${f.base}/replies/message`,{});f.handlers().onTextDelta?.("saved");
  f.service.close();
  const factory=vi.fn(()=>f.provider),restored=new DesktopReplyService(f.sql,factory);
  expect(restored.read(f.conversation.id,0).body).toMatchObject({replies:[{state:"interrupted",text:"saved",error:"host_stopped"}]});
  expect(restored.start(f.conversation.id,"message").body).toMatchObject({state:"interrupted"});
  expect(factory).not.toHaveBeenCalled();restored.close();
});
it("recovers a crash-left streaming row with a new cursor",async()=>{
  const f=await fixture();await f.call(`${f.base}/replies/message`,{});f.service.close();
  const old=(await f.call(`${f.base}/replies?after=0`)).json().replies[0];
  f.sql.prepare("UPDATE desktop_replies SET state='streaming',text='durable partial'").run();
  const restored=new DesktopReplyService(f.sql,()=>f.provider);
  expect(restored.read(f.conversation.id,old.revision).body).toMatchObject({replies:[{state:"interrupted",text:"durable partial"}]});restored.close();
});
it("bounds concurrency, output, runtime and hides provider errors",async()=>{
  const f=await fixture();await f.call(`${f.base}/replies/message`,{});
  await f.call(`${f.base}/messages`,{commandId:"second",text:"Second message"});
  expect((await f.call(`${f.base}/replies/second`,{})).statusCode).toBe(409);
  f.handlers().onTextDelta?.("partial");f.fail();
  await vi.waitFor(async()=>expect((await f.call(`${f.base}/replies?after=0`)).body).toContain("provider_failed"));
  expect((await f.call(`${f.base}/replies?after=0`)).body).not.toContain("upstream secret");
  await f.call(`${f.base}/replies/second`,{});
  expect(()=>f.handlers().onTextDelta?.("字".repeat(22000))).toThrow();
  expect((await f.call(`${f.base}/replies?after=0`)).body).toContain("output_limit");
  const timed=await fixture(10);await timed.call(`${timed.base}/replies/message`,{});
  await vi.waitFor(async()=>expect((await timed.call(`${timed.base}/replies?after=0`)).body).toContain('"error":"timeout"'));
});
it("uses only saved same-conversation history and completed prior replies",async()=>{
  const f=await fixture();await f.call(`${f.base}/replies/message`,{});f.handlers().onTextDelta?.("Answer");f.finish("Answer");
  await vi.waitFor(async()=>expect((await f.call(`${f.base}/replies?after=0`)).body).toContain('"state":"completed"'));
  await f.call(`${f.base}/messages`,{commandId:"second",text:"Follow up"});
  await f.call(`${f.base}/replies/second`,{});
  expect(f.args().messages).toEqual([{role:"user",content:"Explain the next step without executing it"},{role:"assistant",content:"Answer"},{role:"user",content:"Follow up"}]);
});
it("rejects unsupported models, injected authority, unknown ownership and tool-bearing completion",async()=>{
  const f=await fixture();
  for(const body of [{tools:["shell"]},{provider:"other"},{messages:[]}])expect((await f.call(`${f.base}/replies/message`,body)).statusCode).toBe(400);
  expect((await f.call(`${f.base}/replies/missing`,{})).statusCode).toBe(404);
  expect((await f.call("/api/desktop/conversations/other/replies/message",{})).statusCode).toBe(404);
  await f.call(`${f.base}/replies/message`,{});f.handlers().onTextDelta?.("partial");f.invalid();
  await vi.waitFor(async()=>expect((await f.call(`${f.base}/replies?after=0`)).body).toContain("invalid_completion"));
  const u=await fixture();u.unavailable();const result=await u.call(`${u.base}/replies/message`,{});
  expect(result.statusCode).toBe(503);expect(result.body).not.toContain("secret");expect(u.provider.streamTools).not.toHaveBeenCalled();
});
it("desktop IPC exposes only exact cursor reads and empty start/stop commands",()=>{
  const base="/api/desktop/conversations/example/replies";
  expect(validateConversationRequest({path:`${base}?after=0`,method:"GET"}).method).toBe("GET");
  expect(validateConversationRequest({path:`${base}/message`,method:"POST",body:"{}"}).body).toBe("{}");
  expect(validateConversationRequest({path:`${base}/message/cancel`,method:"POST",body:"{}"}).method).toBe("POST");
  for(const request of [{path:`${base}?after=9007199254740992`,method:"GET"},{path:`${base}/message`,method:"POST",body:'{"tools":[]}'},{path:`${base}/message/cancel`,method:"GET"}])expect(()=>validateConversationRequest(request)).toThrow();
});
