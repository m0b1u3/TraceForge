import React,{useEffect,useRef,useState} from "react";
import {ReplyQueueViewSchema,ReplyQueueCommandSchema,type ReplyQueueCommand} from "@traceforge/shared/desktop-reply-queue";
import type {DesktopConversations} from "./desktop-conversation-transport";
import {desktopJournalStorage} from "./desktop-journal-storage";

export function ReplyQueue({bridge,conversationId,onChanged}:{bridge:DesktopConversations;conversationId:string;onChanged():void}){
  const [view,setView]=useState<ReturnType<typeof ReplyQueueViewSchema.parse>>(),[error,setError]=useState(""),[busy,setBusy]=useState(false),[edit,setEdit]=useState<{id:string;text:string}>();
  const [readError,setReadError]=useState(false);
  const [pending,setPending]=useState<ReplyQueueCommand>();const alive=useRef(true),locked=useRef(false);
  const path=`/api/desktop/conversations/${conversationId}/reply-queue`,key=`traceforge.reply-queue.${conversationId}`;
  const storage=desktopJournalStorage();
  useEffect(()=>{alive.current=true;let timer:ReturnType<typeof setTimeout>;let cancelled=false;
    try{const raw=storage.getItem(key);if(raw&&raw!=="null")setPending(ReplyQueueCommandSchema.parse(JSON.parse(raw)));}catch{setError("待处理队列命令损坏，请保留记录后检查。");locked.current=true;}
    const poll=async()=>{try{const r=await bridge.request({path,method:"GET"});if(r.status!==200)throw Error();const next=ReplyQueueViewSchema.parse(r.body);if(next.conversationId!==conversationId)throw Error();if(!cancelled){setView(old=>old&&old.revision>next.revision?old:next);setReadError(false);}}catch{if(!cancelled)setReadError(true);}if(!cancelled)timer=setTimeout(poll,2000);};void poll();
    return()=>{alive.current=false;cancelled=true;clearTimeout(timer);};
  },[bridge,conversationId]);
  async function apply(operation?:ReplyQueueCommand["operation"]){
    if(locked.current||!view)return;locked.current=true;setBusy(true);setError("");
    try{
      const command=pending??{commandId:crypto.randomUUID(),expectedRevision:view.revision,operation:operation!};
      storage.setItem(key,JSON.stringify(command));setPending(command);
      const result=await bridge.request({path,method:"POST",body:JSON.stringify(command)});
      if(!alive.current)return;
      if(result.status===409){storage.setItem(key,"null");setPending(undefined);setError((result.body as {error?:string})?.error==="queue_capacity"?"队列变更记录已达到存储上限，未应用修改。已有任务不受影响。":"队列已变化或消息已开始处理，未应用修改。请重新核对。");return;}
      if(result.status!==200)throw Error();const next=ReplyQueueViewSchema.parse(result.body);if(next.conversationId!==conversationId)throw Error();
      storage.setItem(key,"null");setPending(undefined);setView(old=>old&&old.revision>next.revision?old:next);setEdit(undefined);onChanged();
    }catch{if(alive.current)setError("请求结果尚未确认；核对原请求不会重复执行修改。");}
    finally{locked.current=false;if(alive.current)setBusy(false);}
  }
  if(!view?.items.length&&!view?.paused&&!error&&!readError&&!pending)return null;
  return <section className="reply-queue" aria-label="待处理消息"><details open={!!pending||!!edit}>
    <summary>待处理消息 · {view?.items.length??0}{view?.paused?" · 已暂停接续":""}</summary>
    <p className="local-receipt">仅管理未开始的回复；暂停接续不会停止当前任务。</p>
    {view&&<button disabled={busy||!!pending} onClick={()=>void apply({kind:"pause",paused:!view.paused})}>{view.paused?"恢复接续":"暂停接续"}</button>}
    {view?.items.map((item,index)=><div className="queue-item" key={item.messageId}><p>{item.text}</p>
      <button disabled={busy||!!pending} onClick={()=>setEdit({id:item.messageId,text:item.text})}>修改消息</button>
      <button disabled={busy||!!pending||index===0} onClick={()=>{const ids=view.items.map(i=>i.messageId);[ids[index-1],ids[index]]=[ids[index],ids[index-1]];void apply({kind:"reorder",ids});}}>提前处理</button>
      <button disabled={busy||!!pending} onClick={()=>void apply({kind:"remove",messageId:item.messageId})}>撤回排队</button>
      {edit?.id===item.messageId&&<form onSubmit={e=>{e.preventDefault();void apply({kind:"edit",messageId:edit.id,text:edit.text});}}><textarea aria-label="修改待处理消息" value={edit.text} maxLength={16000} onChange={e=>setEdit({...edit,text:e.target.value})}/><button disabled={busy||!!pending||!edit.text.trim()}>保存修改</button><button type="button" onClick={()=>setEdit(undefined)}>取消修改</button></form>}
    </div>)}
  </details>{pending&&<button disabled={busy} onClick={()=>void apply()}>核对队列原请求</button>}{readError&&<p role="alert">队列暂时无法读取，未自动重试发送。</p>}{error&&<p role="alert">{error}</p>}</section>;
}
