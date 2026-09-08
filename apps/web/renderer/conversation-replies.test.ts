// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ConversationReply, useConversationReplies } from "./conversation-replies";
import type { DesktopReply } from "@traceforge/shared/desktop-replies";

afterEach(()=>{vi.useRealTimers();document.body.replaceChildren();});
const row:DesktopReply={conversationId:"conversation",messageCommandId:"message",revision:1,state:"streaming",text:"Saved partial",createdAt:"2026-09-08T00:00:00.000Z",updatedAt:"2026-09-08T00:00:00.000Z",contextMessages:1,contextTruncated:false,error:null};
it("restores and reconnects through cursor reads without generating again",async()=>{
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;vi.useFakeTimers();
  const calls:any[]=[];let offline=false,final=false;
  const bridge={protocolVersion:1 as const,request:async(input:any)=>{calls.push(input);if(offline)throw new Error();const after=Number(input.path.split("after=")[1]);const current={...row,...(final?{revision:2,state:"completed",text:"Saved partial and final"}:{})};return {status:200,body:{conversationId:"conversation",replies:after<current.revision?[current]:[],nextAfter:Math.max(after,current.revision),hasMore:false}};}};
  function View(){const data=useConversationReplies(bridge,"conversation");return React.createElement("div",null,data.error?"offline":"online",data.replies.get("message")?.text);}
  const node=document.createElement("div");document.body.append(node);const root=createRoot(node);
  try{
    await act(async()=>root.render(React.createElement(View)));expect(node.textContent).toContain("Saved partial");
    offline=true;await act(async()=>{await vi.advanceTimersByTimeAsync(250);});expect(node.textContent).toContain("offlineSaved partial");
    offline=false;final=true;await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});expect(node.textContent).toContain("onlineSaved partial and final");
    expect(calls.every(call=>call.method==="GET")).toBe(true);expect(calls.at(-1).path).toContain("after=1");
  }finally{act(()=>root.unmount());}
});
it("stops only after an explicit click and renders model text without HTML execution",async()=>{
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;const request=vi.fn(async()=>({status:200,body:{...row,state:"cancelled"}})),refresh=vi.fn();
  const node=document.createElement("div");document.body.append(node);const root=createRoot(node);
  try{
    await act(async()=>root.render(React.createElement(ConversationReply,{bridge:{protocolVersion:1,request},conversationId:"conversation",messageId:"message",reply:{...row,text:"<img src=x onerror=alert(1)>"},ready:true,otherActive:false,refresh})));
    expect(request).not.toHaveBeenCalled();expect(node.querySelector("img")).toBeNull();
    await act(async()=>[...node.querySelectorAll("button")].find(button=>button.textContent==="停止回复")!.click());
    expect(request).toHaveBeenCalledWith({path:"/api/desktop/conversations/conversation/replies/message/cancel",method:"POST",body:"{}"});expect(refresh).toHaveBeenCalled();
  }finally{act(()=>root.unmount());}
});
