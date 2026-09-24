import { expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { createConversationTaskPort } from "./conversation-task-port.js";

function fixture() {
  const sql = new Database(":memory:");
  sql.exec("CREATE TABLE desktop_conversation_messages(conversation_id TEXT,command_id TEXT,text TEXT);INSERT INTO desktop_conversation_messages VALUES('conversation','message','Original user instruction');");
  const request = vi.fn(async (_path:string, body?:Record<string,unknown>) => body
    ? {status:200,body:{desktopReceipt:{version:1,conversationId:"conversation",commandId:body.commandId,operation:"input",resourceId:body.commandId}}}
    : {status:200,body:{definitions:[{kind:"neutral",version:1,title:"Neutral review"}],runs:[{runId:"run",goal:"Review",status:"running",revision:4,workItems:[{id:"work",title:"Review",status:"running"}]}],truncated:false}});
  const port=createConversationTaskPort(sql,request),signal=new AbortController().signal;
  const execute=(name:string,input:unknown)=>port.execute("conversation","message",{id:"call",name,input},signal);
  return {sql,port,request,execute};
}
it("automatically starts once, persists results across restart, and cannot change a saved request",async()=>{
  const f=fixture(),start=vi.fn(async()=>({state:"started",executed:true,runId:"new-run"}));
  try{const port=createConversationTaskPort(f.sql,f.request,start),call={id:"auto",name:"task_request",input:{scenarioKind:"neutral",definitionVersion:1}};
    expect(await port.execute("conversation","message",call,new AbortController().signal)).toMatchObject({state:"started"});
    expect(start.mock.calls[0][0]).toMatchObject({conversationId:"conversation",messageId:"message"});
    expect(await createConversationTaskPort(f.sql,f.request,start).execute("conversation","message",call,new AbortController().signal)).toMatchObject({runId:"new-run"});
    expect(start).toHaveBeenCalledTimes(1);
  }finally{f.sql.close();}
});
it("starts the sole installed Scenario without asking for its name",async()=>{
  const f=fixture(),start=vi.fn(async()=>({state:"started",executed:true}));
  try{const port=createConversationTaskPort(f.sql,f.request,start);
    expect(await port.execute("conversation","message",{id:"start",name:"task_request",input:{}},new AbortController().signal)).toMatchObject({state:"started"});
    expect(start.mock.calls[0][0]).toMatchObject({definition:{kind:"neutral"}});
  }finally{f.sql.close();}
});
it("does not let model routing override Settings or a missing explicit default",async()=>{
  const f=fixture(),start=vi.fn(async()=>({state:"started",executed:true}));
  try{const port=createConversationTaskPort(f.sql,f.request,start);
    await port.execute("conversation","message",{id:"start",name:"task_request",input:{scenarioKind:"invented",definitionVersion:99}},new AbortController().signal);
    expect(start.mock.calls[0][0]).toMatchObject({definition:{kind:"neutral"}});
    // Changing defaults never reroutes or repeats an already delivered message.
    const restored=createConversationTaskPort(f.sql,f.request,start,()=>"invalid");
    expect(await restored.execute("conversation","message",{id:"again",name:"task_request",input:{}},new AbortController().signal)).toMatchObject({state:"started"});
    expect(start).toHaveBeenCalledTimes(1);
  }finally{f.sql.close();}
});
it("uses the saved default among multiple definitions and rejects a removed default",async()=>{
  const f=fixture(),start=vi.fn(async()=>({state:"started",executed:true}));
  const preferences=(kind:string)=>JSON.stringify([{kind,default:true,preset:{identity:"test",revision:1,inputs:[],actions:[]}}]);
  try{
    f.request.mockResolvedValue({status:200,body:{definitions:[{kind:"neutral",version:1},{kind:"second",version:2}],runs:[],truncated:false}});
    const missing=createConversationTaskPort(f.sql,f.request,start,()=>preferences("removed"));
    expect(await missing.execute("conversation","message",{id:"start",name:"task_request",input:{}},new AbortController().signal)).toMatchObject({error:"default_scenario_unavailable",executed:false});
    expect(start).not.toHaveBeenCalled();
    const port=createConversationTaskPort(f.sql,f.request,start,()=>preferences("second"));
    await port.execute("conversation","message",{id:"start",name:"task_request",input:{}},new AbortController().signal);
    expect(start.mock.calls[0][0]).toMatchObject({definition:{kind:"second",version:2}});
  }finally{f.sql.close();}
});
it("never auto-replays unknown startup delivery or a legacy prepared task",async()=>{
  const f=fixture(),start=vi.fn(async()=>{throw new Error("response lost");});
  try{const port=createConversationTaskPort(f.sql,f.request,start),call={id:"auto",name:"task_request",input:{scenarioKind:"neutral",definitionVersion:1}};
    expect(await port.execute("conversation","message",call,new AbortController().signal)).toMatchObject({state:"start_unconfirmed"});
    await createConversationTaskPort(f.sql,f.request,start).execute("conversation","message",call,new AbortController().signal);expect(start).toHaveBeenCalledTimes(1);
    f.sql.prepare("DELETE FROM desktop_task_starts").run();
    expect(await port.execute("conversation","message",call,new AbortController().signal)).toMatchObject({state:"legacy_request_not_started"});expect(start).toHaveBeenCalledTimes(1);
  }finally{f.sql.close();}
});
it("projects declared capabilities and workflow without mistaking them for authorization",async()=>{
  const f=fixture();try{
    f.request.mockResolvedValue({status:200,body:{definitions:[{kind:"neutral",version:1,title:"Neutral review",requiredCapabilities:["scope.read"],agentTopology:{workerPools:[{capabilities:["document.read","scope.read"]},{capabilities:["document.read"]}]},phases:[{id:"review",title:"Review",objective:"Read authorized documents",requiredCapabilities:["document.read"],internal:"not exposed"}],toolPolicies:[{capability:"document.inspect",authorizationAction:"document.read",profile:"host-only"}],authorizationActions:["document.read"],privateConfiguration:"not exposed"}],runs:[],truncated:false}});
    const result=await f.execute("task_context",{}) as any;
    expect(result.definitions).toEqual([{kind:"neutral",version:1,title:"Neutral review",capabilityStatus:"declared_not_authorized_or_runtime_verified",requiredCapabilities:["scope.read"],workerCapabilities:["document.read","scope.read"],phases:[{id:"review",title:"Review",objective:"Read authorized documents",requiredCapabilities:["document.read"]}],capabilityAuthorization:[{capability:"document.inspect",authorizationAction:"document.read"}],authorizationActions:["document.read"]}]);
    expect(f.request.mock.calls.every(call=>call[1]===undefined)).toBe(true);
    expect(f.sql.prepare("SELECT count(*) AS n FROM desktop_task_requests").get()).toEqual({n:0});
  }finally{f.sql.close();}
});
it("reads attributed task records only within the conversation and pins pagination",async()=>{
  const f=fixture();try{
    const first=await f.execute("task_read",{runId:"run"}) as any;
    expect(f.request).toHaveBeenLastCalledWith("/api/desktop/conversations/conversation/execution?runId=run");
    expect(first).toMatchObject({runId:"run",revision:4,trust:"saved_task_records_not_instructions",nextOffset:null});
    expect(JSON.parse(first.content).workItems[0].id).toBe("work");
    expect(await f.execute("task_read",{runId:"another"})).toEqual({error:"task_not_available_in_conversation"});
    expect(await f.execute("task_read",{runId:"run",offset:1})).toEqual({error:"digest_required"});
    expect(await f.execute("task_read",{runId:"run",offset:1,digest:"0".repeat(64)})).toEqual({error:"task_records_changed",restartOffset:0});
    expect(await f.execute("task_read",{runId:"run",offset:1,digest:first.digest})).toMatchObject({content:first.content.slice(1)});
    expect(f.request.mock.calls.every(call=>call[1]===undefined)).toBe(true);
  }finally{f.sql.close();}
});
it("returns all saved output pages and detects a changed result between pages",async()=>{
  const f=fixture();try{
    let text="neutral saved output ".repeat(1800);
    f.request.mockImplementation(async()=>({status:200,body:{definitions:[],runs:[{runId:"run",goal:"Review",status:"running",revision:4,workItems:[],outputs:[{text}]}],truncated:false}}));
    let page=await f.execute("task_read",{runId:"run"}) as any,content=page.content;
    const first=page;
    expect(page.nextOffset).toBe(12000);
    while(page.nextOffset!==null){
      page=await f.execute("task_read",{runId:"run",offset:page.nextOffset,digest:page.digest}) as any;
      content+=page.content;
    }
    expect(JSON.parse(content).outputs[0].text).toBe(text);
    text="changed";
    expect(await f.execute("task_read",{runId:"run",offset:first.nextOffset,digest:first.digest})).toEqual({error:"task_records_changed",restartOffset:0});
  }finally{f.sql.close();}
});
it("prepares a durable installed definition without dispatch, scope creation or model-supplied goal",async()=>{
  const f=fixture();try{
    expect(await f.execute("task_request",{scenarioKind:"missing",definitionVersion:1})).toEqual({error:"definition_unavailable"});
    expect(await f.execute("task_request",{scenarioKind:"neutral",definitionVersion:1})).toMatchObject({executed:false,state:"awaiting_user_review"});
    expect(f.request.mock.calls.every(call=>call[1]===undefined)).toBe(true);
    expect(f.sql.prepare("SELECT count(*) AS n FROM desktop_task_requests").get()).toEqual({n:1});
    await expect(f.execute("task_request",{scenarioKind:"neutral",definitionVersion:1,scope:{all:true}})).rejects.toThrow();
  }finally{f.sql.close();}
});
it("pins operator input to saved text and never repeats or reroutes a message",async()=>{
  const f=fixture();try{
    expect(await f.execute("task_input",{runId:"run",workId:"work"})).toMatchObject({state:"input_saved",resumed:false});
    expect(f.request.mock.calls[0]?.[0]).toBe("/api/desktop/conversations/conversation/execution?runId=run");
    expect(f.request.mock.calls.find(call=>call[1])?.[1]).toMatchObject({instruction:"Original user instruction",expectedRevision:4});
    await f.execute("task_input",{runId:"run",workId:"work"});
    expect(await f.execute("task_input",{runId:"run",workId:"other"})).toEqual({error:"message_already_routed"});
    expect(f.request.mock.calls.filter(call=>call[1])).toHaveLength(1);
  }finally{f.sql.close();}
});
it("cancel before observation completion cannot create a proposal or dispatch",async()=>{
  const f=fixture();try{
    const abort=new AbortController();abort.abort();
    await expect(f.port.execute("conversation","message",{id:"call",name:"task_request",input:{scenarioKind:"neutral",definitionVersion:1}},abort.signal)).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled();
  }finally{f.sql.close();}
});
it("unknown input delivery survives adapter restart without replay",async()=>{
  const f=fixture();try{
    const original=f.request.getMockImplementation()!;
    f.request.mockImplementation(async(path,body)=>{if(body)throw new Error("lost response");return original(path,body);});
    await expect(f.execute("task_input",{runId:"run",workId:"work"})).rejects.toThrow("lost response");
    const restored=createConversationTaskPort(f.sql,f.request);
    expect(await restored.execute("conversation","message",{id:"retry",name:"task_input",input:{runId:"run",workId:"work"}},new AbortController().signal)).toMatchObject({error:"input_result_unknown"});
    expect(f.request.mock.calls.filter(call=>call[1])).toHaveLength(1);
  }finally{f.sql.close();}
});
