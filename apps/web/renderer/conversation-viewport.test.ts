// @vitest-environment jsdom
import React,{act} from "react";
import {createRoot} from "react-dom/client";
import {expect,it} from "vitest";
import {ConversationViewport} from "./conversation-viewport";
it("preserves reading position during updates and explicitly returns to latest",async()=>{
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  const node=document.createElement("div");document.body.append(node);const root=createRoot(node);
  try{
    await act(async()=>root.render(React.createElement(ConversationViewport,{identity:"first",follow:true,children:"First"})));
    const scroll=node.querySelector<HTMLElement>(".conversation-scroll")!;
    Object.defineProperty(scroll,"scrollHeight",{configurable:true,value:1000});Object.defineProperty(scroll,"clientHeight",{value:300});
    await act(async()=>{scroll.scrollTop=100;scroll.dispatchEvent(new Event("scroll",{bubbles:true}));});
    await act(async()=>root.render(React.createElement(ConversationViewport,{identity:"first",follow:true,children:"Updated"})));
    expect(scroll.scrollTop).toBe(100);expect(node.textContent).toContain("回到最新内容");
    await act(async()=>node.querySelector("button")!.click());expect(scroll.scrollTop).toBe(1000);
    expect(node.querySelector("button")).toBeNull();
  }finally{act(()=>root.unmount());node.remove();}
});
