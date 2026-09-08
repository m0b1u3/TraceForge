import React,{useEffect,useMemo,useRef,useState} from "react";
import {ArrowUp,GearSix} from "@phosphor-icons/react";
import {ExecutionController} from "./execution-controller";
import {RunControl} from "./run-control";
import type {ConversationRun} from "./conversation-execution";
import type {DesktopConversations} from "./desktop-conversation-transport";
import {shouldSendOnEnter} from "./preview-state";

export function conversationTargets(runs:ConversationRun[]){return runs.filter(run=>["running","paused"].includes(run.status)).flatMap(run=>run.workItems.filter(work=>!["completed","cancelled"].includes(work.status)).map(work=>({key:JSON.stringify([run.runId,work.id]),run,work})));}
/** One composer, explicit routing. A typed draft pins its destination until the user changes it. */
export function ConversationComposer({bridge,conversationId,runs,draft,onChange,onNewMessage,onSettings,disabled,onBusy,inputRef}:{
  bridge:DesktopConversations;conversationId?:string;runs:ConversationRun[]|null;draft:string;onChange(value:string):void;onNewMessage(reply?:boolean):void;
  onSettings():void;disabled:boolean;onBusy(value:boolean):void;inputRef:React.RefObject<HTMLTextAreaElement>;
}){
  const controller=useMemo(()=>conversationId?new ExecutionController(bridge,localStorage,conversationId):null,[bridge,conversationId]);
  const [mode,setMode]=useState(draft?"choose":"auto"),[busy,setBusy]=useState(false),[notice,setNotice]=useState(""),[error,setError]=useState("");
  const alive=useRef(true);useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const candidates=conversationTargets(runs??[]),active=(runs??[]).filter(run=>["running","paused"].includes(run.status));
  const destination=mode==="auto"?(candidates.length===1?candidates[0]!.key:active.length?"":"chat"):mode==="choose"?"":mode;
  const ordinary=destination==="new"||destination==="chat";
  const target=candidates.find(item=>item.key===destination);
  let pending:ReturnType<typeof pendingOperation>=null,invalid=false;
  function pendingOperation(){return controller?.pending??null;}
  try{pending=pendingOperation();}catch{invalid=true;}
  const unavailable=disabled||busy||!!pending||invalid||!!conversationId&&runs===null;
  const sendable=!unavailable&&!!draft.trim()&&(ordinary||!!target)&&draft.length<=(ordinary?16000:8000);
  async function send(reconcile=false){
    if(!reconcile&& !sendable || !controller)return;
    const original=reconcile?pending:undefined;
    setBusy(true);onBusy(true);setError("");setNotice("");
    try{
      const receipt=await controller.execute(reconcile?undefined:{path:`/api/desktop/conversations/${conversationId}/execution/input`,body:{commandId:crypto.randomUUID(),runId:target!.run.runId,workId:target!.work.id,expectedRevision:target!.run.revision,instruction:draft.trim()}});
      if(alive.current){
        if(receipt.operation==="input"){
          if(!reconcile||original?.body.instruction===draft.trim())onChange("");
          setMode("auto");setNotice("补充信息已保存，将供后续处理使用；不会自动恢复调查、重试工具或扩大授权。");
        }else setNotice("原请求已核对，请查看最新调查状态。");
      }
    }catch(cause){if(alive.current)setError(cause instanceof Error?cause.message:"未确认保存，草稿仍保留。");}
    finally{if(alive.current)setBusy(false);onBusy(false);}
  }
  function submit(){if(!sendable)return;if(ordinary)onNewMessage(destination==="chat");else void send();}
  return <>
    {<div className="composer-routing">
      <label>发送到<select aria-label="消息用途" disabled={disabled||busy||!!pending||!!conversationId&&runs===null} value={destination} onChange={event=>{setMode(event.target.value);setNotice("");}}>
        <option value="">选择本条消息的用途</option><option value="chat">与助手对话（不执行工具）</option><option value="new">仅保存调查说明，稍后授权启动</option>
        {candidates.map(item=><option key={item.key} value={item.key}>补充：{item.work.title}{active.length>1?` · ${item.run.goal}`:""}{item.run.status==="paused"?"（已暂停）":""}</option>)}
      </select></label>
      {mode!=="auto"&&!ordinary&&destination&&!target&&<p role="alert">原接收任务已结束或不再可用，请明确选择新的用途。草稿没有转发。</p>}
      {target&&<p>{target.run.status==="paused"?"调查已暂停。":""}补充给“{target.work.title}”，不改变原授权；不要输入密码或令牌。</p>}
      {conversationId&&runs===null&&<p role="status">正在核对调查状态，暂不发送消息。</p>}
      {conversationId&&(target?[target.run]:active.length===1?active:[]).map(run=><RunControl key={run.runId} bridge={bridge} conversationId={conversationId} runId={run.runId} revision={run.revision} status={run.status}/>)}
    </div>}
    <form className="composer host-composer" onSubmit={event=>{event.preventDefault();submit();}}>
      <textarea ref={inputRef} aria-label={target?"补充信息":destination==="chat"?"发送消息":"保存调查说明"} placeholder={target?"补充观察或调整要求…":destination==="chat"?"提问，或一起梳理调查思路…":"描述你的调查目标…"} disabled={disabled||busy||!!pending||invalid} value={draft} maxLength={16000} rows={1}
        onChange={event=>{if(mode==="auto")setMode(destination||"choose");onChange(event.target.value);}}
        onKeyDown={event=>{if(shouldSendOnEnter({key:event.key,shiftKey:event.shiftKey,isComposing:event.nativeEvent.isComposing,keyCode:event.keyCode})){event.preventDefault();submit();}}}/>
      <button className="send primary icon-button" aria-label={target?"发送补充信息":destination==="chat"?"发送给助手":"保存到宿主"} title={target?"发送补充信息":destination==="chat"?"发送给已配置模型，不执行工具":"保存说明，随后确认授权"} disabled={!sendable}><ArrowUp aria-hidden="true"/></button>
      <div className="composer-footnote"><button type="button" onClick={onSettings}><GearSix aria-hidden="true"/>模型设置</button><span title="草稿仅在当前窗口会话保留，退出前请发送或复制。Enter 发送，Shift+Enter 换行。">{draft.length?`${draft.length} / ${ordinary?16000:8000} · 窗口草稿`:"Enter 发送 · Shift+Enter 换行"}</span></div>
    </form>
    {draft.length>8000&&!ordinary&&<p role="alert">补充信息最多 8000 字符，请缩短内容；现有草稿未截断。</p>}
    {pending&&<button disabled={busy||invalid} onClick={()=>void send(true)}>核对待处理请求</button>}
    {invalid&&<p role="alert">待处理请求记录损坏，发送已暂停。请保留记录并核对宿主状态。</p>}
    {error&&<p role="alert">{error}</p>}{notice&&<p role="status" className="local-receipt">{notice}</p>}
  </>;
}
