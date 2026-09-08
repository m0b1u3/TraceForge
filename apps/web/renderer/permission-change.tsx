import React,{useEffect,useRef,useState} from "react";
import {DesktopPermissionChangeSchema} from "@traceforge/shared/desktop-execution";
import type {DesktopConversations} from "./desktop-conversation-transport";
import {AuthorizationForm} from "./authorization-form";

export function PermissionChange({bridge,conversationId,runId,canChange=true,inspectRevision,onPending}:{bridge:DesktopConversations;conversationId:string;runId:string;canChange?:boolean;inspectRevision?:number;onPending?:(value:boolean)=>void}) {
  const [state,setState]=useState<any>(null),[error,setError]=useState(""),[busy,setBusy]=useState(false),[reason,setReason]=useState("");
  const pending=useRef<Record<string,unknown>|null>(null),locked=useRef(false);
  const [corrupt,setCorrupt]=useState(false);
  const [rejectConfirmed,setRejectConfirmed]=useState(false);
  const storageKey=`traceforge:permission-change:${conversationId}:${runId}`;
  useEffect(()=>{try{const raw=localStorage.getItem(storageKey);if(raw){const value=DesktopPermissionChangeSchema.parse(JSON.parse(raw));if(value.runId!==runId)throw new Error("任务不匹配");pending.current=value;setError("有待核对的授权变更，请先核对原请求。");}}catch{setCorrupt(true);setError("待核对记录无法读取，请保留记录并检查宿主状态。");}},[storageKey]);
  useEffect(()=>{onPending?.(!!state||busy||!!pending.current||corrupt);},[state,busy,error,corrupt,onPending]);
  const path=`/api/desktop/conversations/${conversationId}/execution/${runId}/permissions`;
  async function request(body?:Record<string,unknown>){const result=await bridge.request({path,method:body?"POST":"GET",...(body?{body:JSON.stringify(body)}:{})});if(result.status!==200)throw Object.assign(new Error((result.body as any)?.error??"授权变更失败，请核对任务状态"),{notApplied:result.status===409&&(result.body as any)?.notApplied===true});return result.body as any;}
  async function load(){if(locked.current)return;locked.current=true;setBusy(true);setError("");try{setState(await request());}catch(e){setError((e as Error).message);}finally{locked.current=false;setBusy(false);}}
  useEffect(()=>{let active=true;if(canChange&&inspectRevision!==undefined&&!state&&!pending.current&&!corrupt){void request().then(value=>{if(active&&value.requests?.length)setState(value);}).catch(e=>{if(active)setError((e as Error).message);});}return()=>{active=false;};},[canChange,inspectRevision]);
  const proposal=state?.requests?.[0];
  async function save(scope?:Record<string,unknown>,approved=true){if(locked.current)return false;locked.current=true;setBusy(true);setError("");try{
    if(!pending.current){const input={commandId:crypto.randomUUID(),runId,expectedRevision:state.expectedRevision,expectedScopeRevision:state.expectedScopeRevision,scope,reason,confirmed:true,
      ...(proposal?{resolution:{workId:proposal.workId,requestId:proposal.id,approved}}:{})};localStorage.setItem(storageKey,JSON.stringify(input));pending.current=input;}
    const result=await request(pending.current);
    const expectedResolution=pending.current.resolution as {workId:string;requestId:string;approved:boolean}|undefined;
    if(result.commandId!==pending.current.commandId||result.runId!==runId||result.automaticResume!==!!pending.current.resolution
      || (expectedResolution&&(result.resolution?.workId!==expectedResolution.workId||result.resolution?.requestId!==expectedResolution.requestId||result.resolution?.approved!==expectedResolution.approved)))throw new Error("授权变更回执未核对，请保留当前窗口并核对原请求");
    localStorage.removeItem(storageKey);pending.current=null;setState(null);setReason("");setRejectConfirmed(false);setError(result.resolution?result.resolution.approved?"已批准并继续原工作。后续执行使用你审核后的授权。":"已拒绝并继续原工作。模型会在原授权内调整做法。":"授权变更已核对。该请求不会恢复任务，请查看当前任务状态后再决定是否恢复。");return true;
  }catch(e){if((e as {notApplied?:boolean}).notApplied){try{localStorage.removeItem(storageKey);pending.current=null;setState(null);}catch{setCorrupt(true);}}setError(`${(e as Error).message} 未自动重发；请核对原请求或刷新授权。`);return false;}finally{locked.current=false;setBusy(false);}}
  return <section className="permission-change" aria-label="变更任务授权">
    {!state&&canChange&&!pending.current&&<button disabled={busy||corrupt} onClick={()=>void load()}>变更任务授权</button>}
    {!state&&pending.current&&<button disabled={busy||corrupt} onClick={()=>void save()}>核对原授权变更</button>}
    {state&&<>{proposal?<><h3>智能体申请调整授权</h3><p>{proposal.reason}</p><p>申请本身不会授予权限。请审核下方范围；批准后继续原工作，拒绝后让模型在原授权内调整。有效期不会延长。</p>
      <details><summary>对照当前授权与模型提议</summary><p>当前授权</p><pre>{JSON.stringify(state.scope,null,2)}</pre><p>模型提议（不受信任；只有表单已声明的字段可生效）</p><pre>{JSON.stringify(proposal.scope,null,2)}</pre></details></>:<p>修改已暂停任务的授权。只有当前场景和宿主已支持的能力会生效；保存不会恢复任务，也不会延长原授权有效期。</p>}
      <label>变更原因<input value={reason} maxLength={2000} disabled={busy||!!pending.current} onChange={e=>setReason(e.target.value)}/></label>
      <AuthorizationForm key={`${state.expectedScopeRevision}:${proposal?.id??"manual"}`} contract={state.form} policy={state.policy} initialScope={proposal?.scope??state.scope} expiresAt={state.expiresAt} continuesWork={!!proposal} submitLabel={proposal?"批准并继续原工作":"确认变更授权"} disabled={!canChange||busy||!!pending.current||!reason.trim()} register={scope=>save(scope)}/>
      {proposal&&!pending.current&&<div role="group" aria-label="拒绝权限申请"><label><input type="checkbox" checked={rejectConfirmed} disabled={busy||!canChange} onChange={e=>setRejectConfirmed(e.target.checked)}/>保持原授权，让模型调整做法并继续</label><button disabled={busy||!canChange||!reason.trim()||!rejectConfirmed} onClick={()=>void save(state.scope,false)}>拒绝并继续原工作</button></div>}
      {pending.current?<><p>原请求尚未核对。请保留当前窗口；核对使用同一请求标识，不创建第二次授权变更。</p><button disabled={busy} onClick={()=>void save()}>核对原授权变更</button></>:<button disabled={busy} onClick={()=>setState(null)}>取消变更</button>}
    </>}{error&&<p role="status">{error}</p>}
  </section>;
}
