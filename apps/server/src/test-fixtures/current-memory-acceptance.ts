import {mkdtemp,mkdir,writeFile} from "node:fs/promises";
import {join} from "node:path";
import {randomBytes} from "node:crypto";
import Fastify from "fastify";
import type {LlmProvider} from "@traceforge/llm";
import {createDb,getSqliteClient} from "../db/client.js";
import {registerConversationRoutes} from "../conversation-routes.js";
import {DesktopReplyService} from "../desktop-replies.js";
export const currentMemoryLimits={maximumModelCalls:16,maximumDurationMs:180000,modelCallTimeoutMs:45000};
export async function runCurrentMemoryAcceptance(provider:LlmProvider,options:{outputParent:string;mode:string;modelIdentity:unknown;maximumModelCalls?:number|null}){
  await mkdir(options.outputParent,{recursive:true});const root=await mkdtemp(join(options.outputParent,"current-memory-"));
  const report={root,mode:options.mode,model:options.modelIdentity,status:"failed",failure:null as string|null,calls:[] as string[],checks:{savedCurrent:false,sourceSurvivesCompletion:false,freshRead:false},limitations:["Synthetic conversation; no targets or command execution","A bounded probe is not universal model reliability"]};
  const db=createDb(join(root,"state.db")),sql=getSqliteClient(db),app=Fastify();registerConversationRoutes(app,db);
  const deadline=AbortSignal.timeout(currentMemoryLimits.maximumDurationMs);
  const model:LlmProvider={...provider,contextLimits:provider.contextLimits,extractJson:args=>provider.extractJson(args),runTools:args=>provider.runTools(args),streamTools:(args,handlers)=>{
    const limit=options.maximumModelCalls===undefined?currentMemoryLimits.maximumModelCalls:options.maximumModelCalls;
    if(limit!==null&&report.calls.length>=limit)throw Error("call_budget");report.calls.push("stream");
    return provider.streamTools!(args,{...handlers,signal:AbortSignal.any([deadline,AbortSignal.timeout(45000),...(handlers.signal?[handlers.signal]:[])])});
  }};
  const service=new DesktopReplyService(sql,()=>model);
  try{
    const c=(await app.inject({method:"POST",url:"/api/desktop/conversations",payload:{commandId:"create",title:"Neutral current-memory probe"}})).json().id;
    const marker=`neutral-${randomBytes(6).toString("hex")}`;
    async function answer(id:string,text:string){
      await app.inject({method:"POST",url:`/api/desktop/conversations/${c}/messages`,payload:{commandId:id,text}});service.start(c,id);
      for(;;){deadline.throwIfAborted();const reply=(service.read(c,0).body as any).replies.find((r:any)=>r.messageCommandId===id);
        if(reply&&!['streaming','queued'].includes(reply.state)){if(reply.state!=="completed")throw Error(`reply_${reply.state}`);return reply;}
        await new Promise(resolve=>setTimeout(resolve,50));}
    }
    await answer("statement",`请把本条消息保存成一条有来源的记忆笔记：我的测试标记是 ${marker}，状态仍未验证。保存后再确认，不执行任何其他操作。`);
    const notes=sql.prepare("SELECT body FROM desktop_knowledge_versions WHERE conversation_id=?").all(c) as {body:string}[];
    const note=notes.map(n=>JSON.parse(n.body)).find(n=>n.text.includes(marker)&&n.sources.some((s:any)=>s.id==="statement"&&s.part==="message"));
    report.checks.savedCurrent=!!note;
    const {ConversationKnowledge}=await import("../conversation-knowledge.js");
    const result=note?await new ConversationKnowledge(sql,c,1).execute({id:"inspect",name:"memory_topics",input:{key:note.key}},"inspect",model,deadline) as any:null;
    report.checks.sourceSurvivesCompletion=result?.versions[0]?.sourceState==="unchanged";
    const reply=await answer("readback","请现在重新读取刚才那条消息的原文，核对测试标记和未验证状态，再回答。不要仅凭摘要或已有回答复述。");
    report.checks.freshRead=reply.originalReadCount>0&&reply.text.includes(marker);
    if(!Object.values(report.checks).every(Boolean))throw Error("memory_checks_failed");report.status="passed";
  }catch(error){report.failure=error instanceof Error?error.message:"failed";}
  finally{service.close();await app.close();sql.close();await writeFile(join(root,"report.json"),JSON.stringify(report,null,2),{mode:0o600});}
  return report;
}
