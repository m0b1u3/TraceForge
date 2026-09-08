// @vitest-environment jsdom
import React,{act} from "react";
import {createRoot} from "react-dom/client";
import {Simulate} from "react-dom/test-utils";
import {expect,it,afterEach} from "vitest";
import {ConversationComposer} from "./conversation-composer";
import type {ConversationRun} from "./conversation-execution";
afterEach(()=>{localStorage.clear();document.body.replaceChildren();});
it("pins typed input to the visible task and refuses to reroute after it ends",async()=>{
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  let runs:ConversationRun[]=[{runId:"first",messageCommandId:null,goal:"First",status:"running",revision:1,workItems:[{id:"work",title:"First candidate",status:"running"}],outputs:[]}];
  let draft="";const calls:any[]=[];
  const bridge={protocolVersion:1 as const,request:async(input:any)=>{calls.push(input);const body=JSON.parse(input.body);return {status:200,body:{desktopReceipt:{version:1,conversationId:"conversation",commandId:body.commandId,operation:"input",resourceId:body.commandId}}};}};
  const node=document.createElement("div");document.body.append(node);const root=createRoot(node);
  const render=()=>root.render(React.createElement(ConversationComposer,{bridge,conversationId:"conversation",runs,draft,onChange:value=>{draft=value;render();},onNewMessage:()=>{throw new Error("Must not create a new investigation");},onSettings:()=>{},disabled:false,onBusy:()=>{},inputRef:React.createRef<HTMLTextAreaElement>()}));
  try{
    await act(async()=>render());const field=node.querySelector("textarea")!;
    await act(async()=>{field.value="Additional observation";Simulate.change(field);});
    runs=[{...runs[0]!,workItems:[{id:"second",title:"Second candidate",status:"running"}]}];await act(async()=>render());
    expect(node.textContent).toContain("草稿没有转发");expect(node.querySelector<HTMLButtonElement>('[aria-label="保存到宿主"]')!.disabled).toBe(true);expect(calls).toHaveLength(0);
    await act(async()=>{const select=node.querySelector("select")!;select.value=JSON.stringify(["first","second"]);Simulate.change(select);});
    await act(async()=>node.querySelector<HTMLButtonElement>('[aria-label="发送补充信息"]')!.click());
    expect(JSON.parse(calls[0].body)).toMatchObject({workId:"second",instruction:"Additional observation",runId:"first"});expect(draft).toBe("");
  }finally{act(()=>root.unmount());}
});
