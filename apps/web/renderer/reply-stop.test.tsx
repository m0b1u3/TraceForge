// @vitest-environment jsdom
import React,{act} from "react";
import {createRoot} from "react-dom/client";
import {expect,it,vi} from "vitest";
import {ReplyStop} from "./reply-stop";
it("uses the owned cancel endpoint, prevents double dispatch and does not retry uncertainty",async()=>{
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
 let finish!:(value:any)=>void;
 const request=vi.fn(()=>new Promise<any>(resolve=>{finish=resolve;}));
 const node=document.createElement("div"),root=createRoot(node);
 try{
  await act(async()=>root.render(<ReplyStop bridge={{protocolVersion:1,request}} conversationId="c" messageId="m"/>));
  await act(async()=>{node.querySelector("button")!.click();node.querySelector("button")!.click();});expect(request).toHaveBeenCalledOnce();
  expect(request).toHaveBeenCalledWith({path:"/api/desktop/conversations/c/replies/m/cancel",method:"POST",body:"{}"});
  await act(async()=>finish({status:503,body:{}}));expect(node.textContent).toContain("尚未确认停止");expect(request).toHaveBeenCalledOnce();expect(node.querySelector("button")!.disabled).toBe(false);
 }finally{act(()=>root.unmount());}
});
it("rejects a cancellation receipt belonging to another reply",async()=>{
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
 const request=vi.fn(async()=>({status:200,body:{conversationId:"other",messageCommandId:"m",state:"cancelled",revision:1,text:"",createdAt:"2026-09-21T00:00:00Z",updatedAt:"2026-09-21T00:00:00Z",contextMessages:0,contextTruncated:false,error:null}}));
 const node=document.createElement("div"),root=createRoot(node);
 try{await act(async()=>root.render(<ReplyStop bridge={{protocolVersion:1,request}} conversationId="c" messageId="m"/>));await act(async()=>node.querySelector("button")!.click());expect(node.textContent).toContain("尚未确认停止");}
 finally{act(()=>root.unmount());}
});
