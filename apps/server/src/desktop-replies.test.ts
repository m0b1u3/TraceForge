import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import type { LlmProvider, StreamToolsHandlers, RunToolsArgs, RunTurn } from "@traceforge/llm";
import { createDb, getSqliteClient } from "./db/client.js";
import { registerConversationRoutes } from "./conversation-routes.js";
import { DesktopReplyService, registerDesktopReplyRoutes } from "./desktop-replies.js";
import { DesktopReplySchema } from "@traceforge/shared/desktop-replies";
import { validateConversationRequest } from "../../desktop/src/conversation-bridge.js";
import { createConversationTaskPort } from "./conversation-task-port.js";

const cleanup: Array<()=>Promise<void>>=[];
it("edits and reorders only pending replies, pauses durably and reconciles lost acknowledgements",async()=>{
  const f=await fixture();await f.call(`${f.base}/replies/message`,{});
  for(const id of ["second","third"]){await f.call(`${f.base}/messages`,{commandId:id,text:id});await f.call(`${f.base}/replies/${id}`,{});}
  const queue=async()=>(await f.call(`${f.base}/reply-queue`)).json();
  const apply=async(commandId:string,operation:object)=>f.call(`${f.base}/reply-queue`,{commandId,expectedRevision:(await queue()).revision,operation});
  expect((await apply("pause",{kind:"pause",paused:true})).statusCode).toBe(200);
  const edit={commandId:"edit",expectedRevision:(await queue()).revision,operation:{kind:"edit",messageId:"second",text:"edited second"}};
  const edited=await f.call(`${f.base}/reply-queue`,edit);expect(edited.statusCode).toBe(200);
  expect((await f.call(`${f.base}/reply-queue`,edit)).json()).toEqual(edited.json());
  expect((await f.call(`${f.base}/reply-queue`,{...edit,commandId:"stale"})).statusCode).toBe(409);
  expect((await apply("order",{kind:"reorder",ids:["third","second"]})).statusCode).toBe(200);
  f.handlers().onTextDelta?.("first answer");f.finish("first answer");await vi.waitFor(()=>expect(f.service.read(f.conversation.id,0).body).toMatchObject({replies:expect.arrayContaining([expect.objectContaining({state:"completed"})])}));
  expect(f.provider.streamTools).toHaveBeenCalledTimes(1);
  await apply("resume",{kind:"pause",paused:false});
  await vi.waitFor(()=>expect(f.provider.streamTools).toHaveBeenCalledTimes(2));
  expect(f.args().messages.at(-1)?.content).toBe("third");
  expect(JSON.stringify(f.args().messages)).not.toContain("edited second");
  expect((await apply("late",{kind:"edit",messageId:"third",text:"too late"})).statusCode).toBe(409);
  f.handlers().onTextDelta?.("third answer");f.finish("third answer");
  await vi.waitFor(()=>expect(f.provider.streamTools).toHaveBeenCalledTimes(3));
  expect(f.args().messages.at(-1)?.content).toBe("edited second");
  expect(f.args().messages).toContainEqual({role:"assistant",content:"third answer"});
  f.handlers().onTextDelta?.("second answer");f.finish("second answer");await vi.waitFor(()=>expect((f.service.readQueue(f.conversation.id).body as any).items).toHaveLength(0));
});
it("queue commands cannot mutate a different conversation or dispatched message",async()=>{
  const f=await fixture();await f.call(`${f.base}/replies/message`,{});
  const command={commandId:"change",expectedRevision:0,operation:{kind:"edit",messageId:"message",text:"changed"}};
  expect((await f.call(`${f.base}/reply-queue`,command)).statusCode).toBe(409);
  expect((await f.call("/api/desktop/conversations/missing/reply-queue",command)).statusCode).toBe(404);
  expect((await f.call(`${f.base}/reply-queue`,{...command,operation:{kind:"pause",paused:true,scope:"all"}})).statusCode).toBe(400);
  f.service.close();
});
it("one conversation loop reads history then proposes a task and reopens without replay",async()=>{
  const db=createDb(":memory:"),sql=getSqliteClient(db),app=Fastify();
  registerConversationRoutes(app,db);
  const request=vi.fn(async()=>({status:200,body:{definitions:[{kind:"neutral",version:1}],runs:[],truncated:false}}));
  const tasks=createConversationTaskPort(sql,request);
  let count=0;
  const model:LlmProvider={extractJson:vi.fn(),runTools:vi.fn(),streamTools:vi.fn(async(args,handlers)=>{
    expect(args.tools.some(tool=>tool.name==="task_request")).toBe(true);
    expect(args.tools.some(tool=>tool.name==="conversation_read")).toBe(true);
    expect(args.tools.some(tool=>tool.name==="memory_recall")).toBe(true);
    if(count++===0)return {text:"",done:false,toolCalls:[{id:"read",name:"conversation_read",input:{id:"source"}}]};
    if(count===2){
      expect(JSON.parse(args.messages.at(-1)!.content).text).toContain("Earlier detail");
      return {text:"",done:false,toolCalls:[{id:"request",name:"task_request",input:{scenarioKind:"neutral",definitionVersion:1}}]};
    }
    handlers.onTextDelta?.("Please review the requested scope.");
    return {text:"Please review the requested scope.",done:true,toolCalls:[]};
  })};
  const service=new DesktopReplyService(sql,()=>model,10000,tasks);registerDesktopReplyRoutes(app,service);
  await app.ready();cleanup.push(async()=>{await app.close();sql.close();});
  const conversation=(await app.inject({url:"/api/desktop/conversations",method:"POST",payload:{commandId:"create",title:"Task"}})).json();
  await app.inject({url:`/api/desktop/conversations/${conversation.id}/messages`,method:"POST",payload:{commandId:"source",text:"Earlier detail"}});
  await app.inject({url:`/api/desktop/conversations/${conversation.id}/messages`,method:"POST",payload:{commandId:"message",text:"Read the earlier detail and continue the task"}});
  service.start(conversation.id,"message");
  await vi.waitFor(()=>expect(service.read(conversation.id,0).body).toMatchObject({replies:[{state:"completed",taskRequest:{scenarioKind:"neutral",definitionVersion:1},recallCount:1,originalReadCount:1}]}));
  service.close();
  const restored=new DesktopReplyService(sql,()=>model,10000,tasks);
  expect(restored.start(conversation.id,"message").body).toMatchObject({taskRequest:{scenarioKind:"neutral",definitionVersion:1}});
  expect(model.streamTools).toHaveBeenCalledTimes(3);expect(request).toHaveBeenCalledTimes(1);restored.close();
});
afterEach(async()=>{for(const close of cleanup.splice(0))await close();});
it("rejects retired review commands and never upgrades a saved read-only intent",async()=>{
  const f=await fixture();
  expect((await f.call(`${f.base}/replies/message`,{review:[{id:"source"}]})).statusCode).toBe(400);
  f.sql.exec("CREATE TABLE desktop_source_reviews(conversation_id TEXT,message_id TEXT)");
  f.sql.prepare("INSERT INTO desktop_source_reviews VALUES(?,?)").run(f.conversation.id,"message");
  expect((await f.call(`${f.base}/replies/message`,{})).json()).toEqual({error:"source_review_retired"});
  expect(f.provider.streamTools).not.toHaveBeenCalled();
});
it("queues follow-ups once and assembles context after the preceding answer", async()=>{
  const f=await fixture();
  await f.call(`${f.base}/replies/message`,{});
  await f.call(`${f.base}/messages`,{commandId:"second",text:"Continue using that result"});
  expect((await f.call(`${f.base}/replies/second`,{})).json().state).toBe("queued");
  expect((await f.call(`${f.base}/replies/second`,{})).json().state).toBe("queued");
  expect(f.provider.streamTools).toHaveBeenCalledTimes(1);
  f.handlers().onTextDelta?.("Saved first result"); f.finish("Saved first result");
  await vi.waitFor(()=>expect(f.provider.streamTools).toHaveBeenCalledTimes(2));
  expect(f.args().messages).toContainEqual({role:"assistant",content:"Saved first result"});
  f.handlers().onTextDelta?.("Follow-up complete"); f.finish("Follow-up complete");
  await vi.waitFor(()=>expect(f.service.read(f.conversation.id,0).body).toMatchObject({replies:expect.arrayContaining([expect.objectContaining({messageCommandId:"second",state:"completed"})])}));
});
it("stopping the current reply cancels its queued follow-ups without inference",async()=>{
  const f=await fixture(); await f.call(`${f.base}/replies/message`,{});
  await f.call(`${f.base}/messages`,{commandId:"second",text:"Queued instruction"});
  await f.call(`${f.base}/replies/second`,{});
  await f.call(`${f.base}/replies/message/cancel`,{});
  expect(f.service.read(f.conversation.id,0).body).toMatchObject({replies:[{state:"cancelled"},{state:"cancelled"}]});
  await new Promise(resolve=>setTimeout(resolve,10));
  expect(f.provider.streamTools).toHaveBeenCalledTimes(1);
});
it("a withdrawn queued message is not executed and restart does not replay the queue",async()=>{
  const f=await fixture(); await f.call(`${f.base}/replies/message`,{});
  for(const commandId of ["withdraw","pending"]){
    await f.call(`${f.base}/messages`,{commandId,text:"Queued instruction"});
    await f.call(`${f.base}/replies/${commandId}`,{});
  }
  expect((await f.call(`${f.base}/replies/withdraw/cancel`,{})).json().state).toBe("cancelled");
  f.service.close();
  const restored=new DesktopReplyService(f.sql,()=>f.provider);
  expect(restored.start(f.conversation.id,"pending").body).toMatchObject({state:"interrupted",error:"host_stopped"});
  expect(f.provider.streamTools).toHaveBeenCalledTimes(1); restored.close();
});
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
  expect(started.statusCode).toBe(202);expect(f.args().tools.map(tool => tool.name)).toEqual(["conversation_read_sources", "conversation_search", "conversation_read", "conversation_attachments", "conversation_attachment_read", "memory_recall", "memory_update", "memory_topics"]);
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
it("persists streaming public reasoning and preserves it on cancellation without late writes", async () => {
  const f = await fixture(); await f.call(`${f.base}/replies/message`, {});
  f.handlers().onReasoningDelta?.("Public progress");
  await vi.waitFor(async () => expect((await f.call(`${f.base}/replies?after=0`)).json().replies[0]).toMatchObject({ state: "streaming", text: "", reasoning: "Public progress" }));
  const stopped = (await f.call(`${f.base}/replies/message/cancel`, {})).json();
  expect(stopped).toMatchObject({ state: "cancelled", reasoning: "Public progress" });
  f.handlers().onReasoningDelta?.("late"); f.finish("late answer");
  expect((await f.call(`${f.base}/replies?after=0`)).json().replies[0].reasoning).toBe("Public progress");
  expect(f.provider.streamTools).toHaveBeenCalledOnce();
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
  expect((await f.call(`${f.base}/replies/second`,{})).json()).toMatchObject({state:"queued"});
  f.handlers().onTextDelta?.("partial");f.fail();
  await vi.waitFor(async()=>expect((await f.call(`${f.base}/replies?after=0`)).body).toContain("provider_failed"));
  expect((await f.call(`${f.base}/replies?after=0`)).body).not.toContain("upstream secret");
  await f.call(`${f.base}/replies/second`,{});
  await vi.waitFor(()=>expect(f.provider.streamTools).toHaveBeenCalledTimes(2));
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
  expect(JSON.parse(f.args().messages[0].content).references).toEqual([{id:"message",sequence:1,excerpt:"Explain the next step without executing it"}]);
  expect(f.args().messages.slice(1)).toEqual([{role:"user",content:"Explain the next step without executing it"},{role:"assistant",content:"Answer"},{role:"user",content:"Follow up"}]);
});

it("adds traceable cached summaries for omitted conversation history without deleting original messages", async () => {
  const f = await fixture();
  vi.mocked(f.provider.extractJson).mockImplementation(async input => ({ entries: JSON.parse(input.user).entries.map((entry: { id: string }) => ({ id: entry.id, text: "Earlier discussion; retain limitations and unfinished questions." })) }));
  for (let i = 0; i < 24; i++) await f.call(`${f.base}/messages`, { commandId: `long_${i}`, text: "Historical context ".repeat(300) });
  await f.call(`${f.base}/replies/long_23`, {});
  await vi.waitFor(() => expect(f.provider.streamTools).toHaveBeenCalledTimes(1));
  expect(f.args().messages[0].content).toContain("untrusted_incomplete_conversation_summary");
  expect(f.args().messages[0].content).toContain("originalMessageIds");
  expect((f.sql.prepare("SELECT count(*) AS n FROM desktop_conversation_messages").get() as { n: number }).n).toBe(25);
  expect((f.sql.prepare("SELECT count(*) AS n FROM desktop_conversation_memory").get() as { n: number }).n).toBeGreaterThan(0);
  const path = `${f.base}/replies/long_23/memory`;
  expect(validateConversationRequest({ path, method: "GET" }).path).toBe(path);
  const memory = (await f.call(path)).json(); expect(memory.entries[0].user).toContain("Explain");
  expect(memory.entries[0].summary).toContain("limitations");
  expect(f.provider.streamTools).toHaveBeenCalledTimes(1);
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
