import React,{useEffect,useMemo,useState} from "react";
import {desktopJournalStorage} from "./desktop-journal-storage";
import type {DesktopConversations} from "./desktop-conversation-transport";
import type {SavedMessage} from "./conversation-client";
import {ExecutionController} from "./execution-controller";
import {EvidenceReference} from "./evidence-reference";
type Run={runId:string;goal:string;status:string;revision:number;workItems:Array<{id:string;title:string;status:string}>;outputs:Array<{id:string;summary:string;refs:string[]}>};
/** Inspector is a projection, never a second task-start or authorization flow. */
export function ExecutionPanel({bridge,conversationId,evidenceOnly=false}:{bridge:DesktopConversations;conversationId:string;messages:SavedMessage[];evidenceOnly?:boolean;inline?:boolean;intent?:{scenarioKind:string;definitionVersion:number}}){
  const [runs,setRuns]=useState<Run[]>([]),[loaded,setLoaded]=useState(false),[error,setError]=useState(""),[busy,setBusy]=useState(false),[refresh,setRefresh]=useState(0);
  const controller=useMemo(()=>new ExecutionController(bridge,desktopJournalStorage(),conversationId),[bridge,conversationId]);
  let pending:ReturnType<typeof getPending>=null,damaged=false;
  function getPending(){return controller.pending;}
  try{pending=getPending();}catch{damaged=true;}
  useEffect(()=>{let active=true,timer:ReturnType<typeof setTimeout>;
    async function read(){try{const response=await bridge.request({path:`/api/desktop/conversations/${conversationId}/execution`,method:"GET"});const body=response.body as {runs:Run[]};
      if(response.status!==200||!Array.isArray(body?.runs))throw new Error();
      if(active){setRuns(body.runs);setLoaded(true);}
    }catch{if(active)setError("暂时无法读取任务状态。");}
    if(active)timer=setTimeout(read,2000);}
    void read();return()=>{active=false;clearTimeout(timer);};
  },[bridge,conversationId,refresh]);
  async function write(operation?:{path:string;body:Record<string,unknown>}){setBusy(true);setError("");try{await controller.execute(operation);setRefresh(v=>v+1);}catch(cause){setError((cause as Error).message);}finally{setBusy(false);}}
  return <section className="execution-panel" aria-label="任务记录"><h2>{evidenceOnly?"任务输出与引用":"任务进展"}</h2>
    {!loaded&&<p role="status">正在读取任务…</p>}
    {loaded&&!runs.length&&<p>{evidenceOnly?"尚无任务输出。":"在对话中描述任务即可开始，无需在这里设置授权。"}</p>}
    {runs.map(run=><article key={run.runId} className="execution-run"><h3>{run.goal}</h3><p>{run.status}</p>
      {!evidenceOnly&&!["completed","cancelled","failed"].includes(run.status)&&<button disabled={busy||damaged||!!pending} onClick={()=>void write({path:`/api/desktop/conversations/${conversationId}/execution/cancel`,body:{commandId:crypto.randomUUID(),runId:run.runId,expectedRevision:run.revision}})}>停止任务</button>}
      <ul>{run.workItems.map(work=><li key={work.id}>{work.title} · {work.status}</li>)}</ul>
      {run.outputs.map(output=><div key={output.id}><p>{output.summary}</p><details><summary>查看依据</summary>{output.refs.map(ref=><EvidenceReference key={ref} bridge={bridge} conversationId={conversationId} runId={run.runId} reference={ref}/>)}</details></div>)}
    </article>)}
    {error&&<p role="alert">{error}<button onClick={()=>{setError("");setRefresh(v=>v+1);}}>重新读取</button></p>}
    {damaged&&<p role="alert">待处理记录无法读取，请保留记录。</p>}
    {pending&&!evidenceOnly&&<button disabled={busy||damaged} onClick={()=>void write()}>核对原请求</button>}
  </section>;
}
