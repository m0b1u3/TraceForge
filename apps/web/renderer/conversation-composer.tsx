import React, { useMemo, useState } from "react";
import { desktopJournalStorage } from "./desktop-journal-storage";
import { ArrowUp, GearSix } from "@phosphor-icons/react";
import { ExecutionController } from "./execution-controller";
import { RunControl } from "./run-control";
import type { ConversationRun } from "./conversation-execution";
import type { DesktopConversations } from "./desktop-conversation-transport";
import { shouldSendOnEnter } from "./preview-state";

export function conversationTargets(runs:ConversationRun[]){return runs.filter(run=>["running","paused"].includes(run.status)).flatMap(run=>run.workItems.filter(work=>!["completed","cancelled"].includes(work.status)).map(work=>({key:JSON.stringify([run.runId,work.id]),run,work})));}
/** Every message is saved and sent through the same assistant entry point. */
export function ConversationComposer({bridge,conversationId,runs,draft,onChange,onNewMessage,onSettings,disabled,onBusy,inputRef}:{
  bridge:DesktopConversations;conversationId?:string;runs:ConversationRun[]|null;draft:string;onChange(value:string):void;onNewMessage(reply?:boolean):void;
  onSettings():void;disabled:boolean;onBusy(value:boolean):void;inputRef:React.RefObject<HTMLTextAreaElement>;
}){
  const controller=useMemo(()=>conversationId?new ExecutionController(bridge,desktopJournalStorage(),conversationId):null,[bridge,conversationId]);
  const [busy,setBusy]=useState(false),[error,setError]=useState("");
  let pending:ReturnType<typeof pendingOperation>=null,invalid=false;
  function pendingOperation(){return controller?.pending??null;}
  try{pending=pendingOperation();}catch{invalid=true;}
  const sendable=!disabled&&!busy&&!pending&&!invalid&&!!draft.trim()&&draft.length<=16000;
  function submit(){if(sendable)onNewMessage(true);}
  async function reconcile(){
    if(!controller)return;setBusy(true);onBusy(true);setError("");
    try{await controller.execute();}catch(cause){setError(cause instanceof Error?cause.message:"未确认原请求，草稿仍保留。");}
    finally{setBusy(false);onBusy(false);}
  }
  return <>
    {conversationId&&(runs??[]).filter(run=>["running","paused"].includes(run.status)).map(run=><RunControl key={run.runId} bridge={bridge} conversationId={conversationId} runId={run.runId} revision={run.revision} status={run.status}/>)}
    <form className="composer host-composer" onSubmit={event=>{event.preventDefault();submit();}}>
      <textarea ref={inputRef} aria-label="发送消息" placeholder="提问、描述任务，或补充要求…" disabled={disabled||busy||!!pending||invalid} value={draft} maxLength={16000} rows={1}
        onChange={event=>onChange(event.target.value)} onKeyDown={event=>{if(shouldSendOnEnter({key:event.key,shiftKey:event.shiftKey,isComposing:event.nativeEvent.isComposing,keyCode:event.keyCode})){event.preventDefault();submit();}}}/>
      <button className="send primary icon-button" aria-label="发送给助手" title="发送消息；执行任务前核对授权" disabled={!sendable}><ArrowUp aria-hidden="true"/></button>
      <div className="composer-footnote"><button type="button" onClick={onSettings}><GearSix aria-hidden="true"/>模型设置</button><span>{draft.length?`${draft.length} / 16000 · 本地草稿`:"Enter 发送 · Shift+Enter 换行"}</span></div>
    </form>
    {pending&&<button disabled={busy||invalid} onClick={()=>void reconcile()}>核对待处理请求</button>}
    {invalid&&<p role="alert">待处理请求记录损坏，发送已暂停。请保留记录并核对宿主状态。</p>}
    {error&&<p role="alert">{error}</p>}
  </>;
}
