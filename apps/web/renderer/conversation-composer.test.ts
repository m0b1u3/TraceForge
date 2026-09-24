// @vitest-environment jsdom
import React,{act} from "react";
import {createRoot} from "react-dom/client";
import {Simulate} from "react-dom/test-utils";
import {expect,it,afterEach} from "vitest";
import {ConversationComposer} from "./conversation-composer";
import type {ConversationRun} from "./conversation-execution";
afterEach(()=>{localStorage.clear();document.body.replaceChildren();});
it("always saves a conversation message; task changes cannot silently forward the draft",async()=>{
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  let runs:ConversationRun[]=[{runId:"first",messageCommandId:null,goal:"First",status:"running",revision:1,workItems:[{id:"work",title:"First candidate",status:"running"}],outputs:[]}];
  let draft="";const calls:any[]=[],sent:boolean[]=[];
  const bridge={protocolVersion:1 as const,request:async(input:any)=>{if(input.method==="GET"&&input.path==="/api/desktop/approval-preference")return {status:200,body:{revision:0,routineApprovalRequired:true}};calls.push(input);const body=JSON.parse(input.body);return {status:200,body:{desktopReceipt:{version:1,conversationId:"conversation",commandId:body.commandId,operation:"input",resourceId:body.commandId}}};}};
  const node=document.createElement("div");document.body.append(node);const root=createRoot(node);
  const render=()=>root.render(React.createElement(ConversationComposer,{bridge,conversationId:"conversation",runs,draft,onChange:value=>{draft=value;render();},onNewMessage:reply=>{sent.push(reply===true);},onSettings:()=>{},disabled:false,onBusy:()=>{},inputRef:React.createRef<HTMLTextAreaElement>()}));
  try{
    await act(async()=>render());const field=node.querySelector("textarea")!;
    await act(async()=>{field.value="Additional observation";Simulate.change(field);});
    runs=[{...runs[0]!,workItems:[{id:"second",title:"Second candidate",status:"running"}]}];await act(async()=>render());
    expect(node.querySelector("select")).toBeNull();expect(calls).toHaveLength(0);
    await act(async()=>node.querySelector<HTMLButtonElement>('[aria-label="发送给助手"]')!.click());
    expect(sent).toEqual([true]);expect(calls).toHaveLength(0);expect(draft).toBe("Additional observation");
  }finally{act(()=>root.unmount());}
});
