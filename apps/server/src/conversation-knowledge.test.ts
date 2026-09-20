import {expect,it,vi} from "vitest";
import Fastify from "fastify";
import {createDb,getSqliteClient} from "./db/client.js";
import {registerConversationRoutes} from "./conversation-routes.js";
import {ConversationKnowledge} from "./conversation-knowledge.js";
import {ConversationHistoryReader,readConversationOriginal} from "./conversation-history-reader.js";
import type {LlmProvider} from "@traceforge/llm";

async function fixture(){
  const db=createDb(":memory:"),sql=getSqliteClient(db),app=Fastify();registerConversationRoutes(app,db);
  const c=(await app.inject({method:"POST",url:"/api/desktop/conversations",payload:{commandId:"create",title:"Memory"}})).json();
  for(const [i,text] of ["Original condition was absent.","A later observation contradicts the first assumption.","x".repeat(15000)].entries())await app.inject({method:"POST",url:`/api/desktop/conversations/${c.id}/messages`,payload:{commandId:`m${i+1}`,text}});
  // Original-reader tables normally exist through DesktopReplyService.
  sql.exec("CREATE TABLE IF NOT EXISTS desktop_replies(conversation_id TEXT,message_command_id TEXT,state TEXT,text TEXT)");
  const model:LlmProvider={extractJson:vi.fn(async()=>({ids:["m2"]})),runTools:vi.fn()};
  const memory=new ConversationKnowledge(sql,c.id,3),signal=new AbortController().signal;
  const execute=(name:string,input:unknown,command="command")=>memory.execute({id:command,name,input},command,model,signal);
  const refs=["m1","m2"].map(id=>({id,digest:readConversationOriginal(sql,c.id,id,3)!.digest}));
  return {sql,c,memory,model,refs,execute,close:async()=>{await app.close();sql.close();}};
}
it("respects an explicit upper bound even for completed reordered messages",async()=>{
  const f=await fixture();try{
    f.sql.prepare("INSERT INTO desktop_replies VALUES(?,?,?,?)").run(f.c.id,"m2","completed","condition");
    const memory=new ConversationKnowledge(f.sql,f.c.id,1);
    const read=(input:unknown)=>memory.execute({id:"read",name:"memory_recall",input},"read",f.model,new AbortController().signal);
    expect((await read({query:"condition"}) as any).matches.map((m:any)=>m.id)).toContain("m2");
    expect((await read({query:"condition",before:1}) as any).matches.map((m:any)=>m.id)).not.toContain("m2");
    expect((await read({query:"condition",after:1,before:1}) as any).totalCandidates).toBe(0);
  }finally{await f.close();}
});
it("performs bounded semantic recall, validates source IDs and explicitly falls back",async()=>{
  const f=await fixture();try{
    const result=await f.execute("memory_recall",{query:"corrected hypothesis",semantic:true}) as any;
    expect(result.semanticStatus).toBe("used");expect(result.matches[0].id).toBe("m2");expect(result.matches[0].digest).toBe(f.refs[1].digest);
    (f.model.extractJson as any).mockResolvedValue({ids:["foreign"]});
    const fallback=await f.execute("memory_recall",{query:"condition",semantic:true}) as any;
    expect(fallback.semanticStatus).toBe("unavailable_lexical_fallback");expect(fallback.matches[0].id).toBe("m1");
    const bounded=await f.execute("memory_recall",{query:"condition",before:1}) as any;expect(bounded.totalCandidates).toBe(1);
  }finally{await f.close();}
});
it("user-message sources survive assistant completion but reject actual edits and invented digests",async()=>{
  const f=await fixture();try{
    f.sql.prepare("INSERT INTO desktop_replies VALUES(?,?,?,?)").run(f.c.id,"m3","streaming","partial");
    const reader=new ConversationHistoryReader(f.sql,f.c.id,3);
    const found=reader.execute({id:"find",name:"conversation_search",input:{query:"xxx"}}) as any;
    const source=found.matches[0].messageSource;
    const note={key:"current",kind:"topic",title:"Current statement",text:"User's statement",expectedRevision:0,status:"active",sources:[source]};
    expect(await f.execute("memory_update",note)).toMatchObject({status:"saved"});
    f.sql.prepare("UPDATE desktop_replies SET state='completed',text='assistant final'").run();
    expect((await f.execute("memory_topics",{key:"current"}) as any).versions[0].sourceState).toBe("unchanged");
    expect(reader.execute({id:"reread",name:"conversation_read",input:source})).toMatchObject({digest:source.digest,messageSource:source});
    expect(reader.execute({id:"batch",name:"conversation_read_sources",input:{sources:[source],maxTokens:8192}})).toMatchObject({sources:[{id:"m3",digest:source.digest}]});
    expect(await f.execute("memory_update",{...note,sources:[{id:"current",digest:"not-a-digest"}]},"invalid")).toMatchObject({error:"invalid_memory_update",recovery:expect.stringContaining("No memory was written")});
    f.sql.prepare("UPDATE desktop_conversation_messages SET text='different' WHERE command_id='m3'").run();
    expect((await f.execute("memory_topics",{key:"current"}) as any).versions[0].sourceState).toBe("changed_or_missing");
  }finally{await f.close();}
});
it("versions notes with provenance, CAS and idempotency; invalidates without losing history",async()=>{
  const f=await fixture();try{
    const first={key:"conditions",kind:"topic",title:"Current conditions",text:"Initial interpretation",expectedRevision:0,status:"active",sources:[f.refs[0]]};
    expect(await f.execute("memory_update",first)).toMatchObject({revision:1});
    expect(await f.execute("memory_update",first)).toMatchObject({revision:1});
    expect(await f.execute("memory_update",{...first,text:"Different"})).toEqual({error:"memory_command_conflict"});
    expect(await f.execute("memory_update",first,"stale")).toMatchObject({error:"memory_revision_conflict"});
    expect(await f.execute("memory_update",{...first,key:"other",sources:[{...f.refs[0],digest:"0".repeat(64)}]},"bad")).toMatchObject({error:"memory_source_changed_or_unavailable"});
    await f.execute("memory_update",{...first,expectedRevision:1,text:"Original interpretation disproved",status:"invalidated",sources:f.refs},"correct");
    const history=await f.execute("memory_topics",{key:"conditions"}) as any;
    expect(history.versions.map((n:any)=>n.revision)).toEqual([2,1]);expect(f.memory.overview(1024).notes).toEqual([]);
    const other=new ConversationKnowledge(f.sql,"another",3);expect(other.overview(1024).notes).toEqual([]);
  }finally{await f.close();}
});
it("marks altered sources and preserves unrelated sections on update",async()=>{
  const f=await fixture();try{
    const note={kind:"topic",title:"Topic",text:"Derived, not proof",expectedRevision:0,status:"active",sources:[f.refs[0]]};
    await f.execute("memory_update",{...note,key:"first"},"first");await f.execute("memory_update",{...note,key:"second"},"second");
    await f.execute("memory_update",{...note,key:"first",expectedRevision:1,text:"Changed section"},"update");
    expect((await f.execute("memory_topics",{key:"second"}) as any).versions[0].text).toBe("Derived, not proof");
    f.sql.prepare("UPDATE desktop_conversation_messages SET text='changed' WHERE command_id='m1'").run();
    expect(f.memory.overview(2048).notes.every(n=>n.sourceState==="changed_or_missing")).toBe(true);
  }finally{await f.close();}
});
it("keeps small original sources when an earlier ranked original exceeds its independent budget",async()=>{
  const f=await fixture();try{
    const reader=new ConversationHistoryReader(f.sql,f.c.id,3),large={id:"m3",digest:readConversationOriginal(f.sql,f.c.id,"m3",3)!.digest};
    const result=reader.execute({id:"read",name:"conversation_read_sources",input:{sources:[large,...f.refs],maxTokens:512}}) as any;
    expect(result.sources.map((s:any)=>s.id)).toEqual(["m1","m2"]);expect(result.skipped[0].id).toBe("m3");expect(result.truncated).toBe(true);
  }finally{await f.close();}
});
it("excludes records changed while semantic inference is running, and respects cancellation",async()=>{
  const f=await fixture();try{
    (f.model.extractJson as any).mockImplementation(async()=>{f.sql.prepare("UPDATE desktop_conversation_messages SET text='changed during inference' WHERE command_id='m2'").run();return {ids:["m2"]};});
    const result=await f.execute("memory_recall",{query:"corrected hypothesis",semantic:true}) as any;
    expect(result.changedDuringRecall).toEqual(["m2"]);expect(result.matches).toEqual([]);
    const abort=new AbortController();abort.abort();
    await expect(f.memory.execute({id:"cancelled",name:"memory_topics",input:{}},"cancelled",f.model,abort.signal)).rejects.toThrow();
  }finally{await f.close();}
});
