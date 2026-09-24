import React,{useRef,useState} from "react";
import {Stop} from "@phosphor-icons/react";
import {DesktopReplySchema} from "@traceforge/shared/desktop-replies";
import type {DesktopConversations} from "./desktop-conversation-transport";

/** Stable composer action. Cancellation is explicit; an uncertain result is never auto-retried. */
export function ReplyStop({bridge,conversationId,messageId}:{bridge:DesktopConversations;conversationId:string;messageId:string}){
 const locked=useRef(false),[busy,setBusy]=useState(false),[error,setError]=useState("");
 async function stop(){
  if(locked.current)return;locked.current=true;setBusy(true);setError("");
  try{
   const result=await bridge.request({path:`/api/desktop/conversations/${conversationId}/replies/${messageId}/cancel`,method:"POST",body:"{}"});
   if(![200,202].includes(result.status))throw Error();
   const reply=DesktopReplySchema.parse(result.body);
   if(reply.conversationId!==conversationId||reply.messageCommandId!==messageId||reply.state==="streaming"||reply.state==="queued")throw Error();
  }catch{setError("尚未确认停止结果。已有内容保留，可再次核对停止。");}
  finally{locked.current=false;setBusy(false);}
 }
 return <div className="composer-stop"><button type="button" disabled={busy} onClick={()=>void stop()}><Stop aria-hidden="true"/>{busy?"正在停止…":"停止回复"}</button>{error&&<span role="alert">{error}</span>}</div>;
}
