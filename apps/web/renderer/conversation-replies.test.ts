// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ConversationReply, useConversationReplies } from "./conversation-replies";
import type { DesktopReply } from "@traceforge/shared/desktop-replies";

afterEach(()=>{vi.useRealTimers();document.body.replaceChildren();});
const row:DesktopReply={conversationId:"conversation",messageCommandId:"message",revision:1,state:"streaming",text:"Saved partial",createdAt:"2026-09-08T00:00:00.000Z",updatedAt:"2026-09-08T00:00:00.000Z",contextMessages:1,contextTruncated:false,error:null};
it("keeps failed tool results visible even when the model claims completion",async()=>{
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  const node=document.createElement("div"),root=createRoot(node);
  try{
    await act(async()=>root.render(React.createElement(ConversationReply,{bridge:{protocolVersion:1,request:vi.fn()},conversationId:"conversation",messageId:"message",ready:true,otherActive:false,refresh(){},reply:{...row,state:"completed",text:"已记住",toolActivity:[{ordinal:1,tool:"memory_update",outcome:"failed",input:"{}",output:'{"error":"memory_revision_conflict"}'}]}})));
    expect(node.textContent).toContain("memory_update · 未成功");
    expect(node.textContent).toContain("助手文字不代表该操作已完成");
  }finally{act(()=>root.unmount());}
});
it("shows actual historical read activity without a separate review mode", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  const node=document.createElement("div"),root=createRoot(node);
  try {
    await act(async()=>root.render(React.createElement(ConversationReply,{bridge:{protocolVersion:1,request:vi.fn()},conversationId:"conversation",messageId:"message",ready:true,otherActive:false,refresh(){},reply:{...row,state:"failed",text:"已经检查完成",error:"provider_failed",recallCount:3,originalReadCount:1}})));
    expect(node.textContent).toContain("本次已查阅历史原文 1 段"); expect(node.textContent).not.toContain("已查阅本次对话原文 3 次");
    expect(node.textContent).not.toContain("原文复核");
  } finally { act(()=>root.unmount()); }
});
it("shows queued messages with an explicit withdrawal action, not a failure",async()=>{
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  const request=vi.fn(async()=>({status:200,body:{...row,state:"cancelled",text:""}}));
  const node=document.createElement("div"),root=createRoot(node);
  try{
    await act(async()=>root.render(React.createElement(ConversationReply,{bridge:{protocolVersion:1,request},conversationId:"conversation",messageId:"message",reply:{...row,state:"queued",text:""},ready:true,otherActive:true,refresh(){}})));
    expect(node.textContent).toContain("消息已排队");
    expect(node.textContent).not.toContain("没有正常完成");
    expect(request).not.toHaveBeenCalled();
    await act(async()=>node.querySelector("button")!.click());
    expect(request).toHaveBeenCalledWith({path:"/api/desktop/conversations/conversation/replies/message/cancel",method:"POST",body:"{}"});
  }finally{act(()=>root.unmount());}
});
it("reads summary sources on demand without generating or executing HTML", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const request = vi.fn(async () => ({ status: 200, body: { conversationId: "conversation", messageId: "message", entries: [{ id: "earlier", summary: "An earlier summary", user: "<script>text</script>", assistant: "Earlier response" }] } }));
  const node = document.createElement("div"); document.body.append(node); const root = createRoot(node);
  try {
    await act(async () => root.render(React.createElement(ConversationReply, { bridge: { protocolVersion: 1, request }, conversationId: "conversation", messageId: "message", reply: { ...row, contextTruncated: true }, ready: true, otherActive: false, refresh() {} })));
    expect(request).not.toHaveBeenCalled();
    await act(async () => [...node.querySelectorAll("button")].find(button => button.textContent === "查看历史摘要与原文")!.click());
    expect(request).toHaveBeenCalledWith({ path: "/api/desktop/conversations/conversation/replies/message/memory", method: "GET" });
    expect(node.querySelector("script")).toBeNull(); expect(node.textContent).toContain("Earlier response");
  } finally { act(() => root.unmount()); }
});
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
it.each(["compacting", "recalling", "recovering"] as const)("keeps a clear stop action during %s", async phase => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const request = vi.fn(async () => ({ status: 200, body: { ...row, phase, state: "cancelled" } }));
  const node = document.createElement("div"); document.body.append(node); const root = createRoot(node);
  try {
    await act(async () => root.render(React.createElement(ConversationReply, { bridge: { protocolVersion: 1, request }, conversationId: "conversation", messageId: "message", reply: { ...row, text: "", phase }, ready: true, otherActive: false, refresh() {} })));
    expect(node.querySelector('[role="status"]')?.textContent).toBe({ compacting: "正在整理上下文", recalling: "正在查阅对话原文", recovering: "正在调整上下文" }[phase]);
    const stop = [...node.querySelectorAll("button")].find(button => button.textContent === "停止回复")!;
    expect(stop.disabled).toBe(false); await act(async () => stop.click()); expect(request).toHaveBeenCalledTimes(1);
  } finally { act(() => root.unmount()); }
});
