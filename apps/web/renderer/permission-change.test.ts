// @vitest-environment jsdom
import React,{act} from "react";
import {createRoot} from "react-dom/client";
import {Simulate} from "react-dom/test-utils";
import {expect,it} from "vitest";
import {PermissionChange} from "./permission-change";
it.each([true,false])("reconciles a stored permission decision approved=%s after remount without creating another decision",async approved=>{
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;localStorage.clear();
  const input={commandId:"original",runId:"run",expectedRevision:7,expectedScopeRevision:1,scope:{targets:["first"]},reason:"Reviewed",confirmed:true,resolution:{workId:"work",requestId:"request",approved}};
  localStorage.setItem("traceforge:permission-change:conversation:run",JSON.stringify(input));const calls:any[]=[];
  const bridge={protocolVersion:1 as const,async request(value:any){calls.push(value);return {status:200,body:{commandId:"original",runId:"run",automaticResume:true,resolution:{approved,requestId:"request",workId:"work"}}};}};
  const node=document.createElement("div");document.body.append(node);const root=createRoot(node);
  try{
    await act(async()=>root.render(React.createElement(PermissionChange,{bridge,conversationId:"conversation",runId:"run",canChange:false})));
    expect(calls).toHaveLength(0);
    await act(async()=>[...node.querySelectorAll("button")].find(b=>b.textContent==="核对原授权变更")!.click());
    expect(calls).toHaveLength(1);expect(JSON.parse(calls[0].body)).toEqual(input);expect(localStorage.length).toBe(0);
  }finally{act(()=>root.unmount());node.remove();localStorage.clear();}
});
it("opens a pending model request without executing it and explicitly rejects into the unchanged scope",async()=>{
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;localStorage.clear();const posts:any[]=[];
  const state={expectedRevision:7,expectedScopeRevision:1,scope:{targets:["first"]},expiresAt:"2099-01-01T00:00:00.000Z",requests:[{workId:"work",id:"request",reason:"Need another resource",scope:{targets:["second"]}}],form:{version:1,description:"Scope",fields:[{path:["targets"],label:"Targets",description:"Exact resources",type:"string-list",required:false}]},policy:{allowedActions:[],deniedActions:[],resources:[]}};
  const bridge={protocolVersion:1 as const,async request(input:any){if(input.method==="GET")return {status:200,body:state};const body=JSON.parse(input.body);posts.push(body);return {status:200,body:{commandId:body.commandId,runId:"run",automaticResume:true,resolution:body.resolution}};}};
  const node=document.createElement("div");document.body.append(node);const root=createRoot(node);
  try{
    await act(async()=>root.render(React.createElement(PermissionChange,{bridge,conversationId:"conversation",runId:"run",inspectRevision:7})));
    expect(node.textContent).toContain("Need another resource");expect(posts).toHaveLength(0);
    const reason=node.querySelector<HTMLInputElement>('input:not([type="checkbox"])')!;
    await act(async()=>{reason.value="Use existing resources";Simulate.change(reason);});
    const reject=[...node.querySelectorAll("button")].find(b=>b.textContent==="拒绝并继续原工作")!;
    expect(reject.disabled).toBe(true);
    await act(async()=>node.querySelector<HTMLInputElement>('[aria-label="拒绝权限申请"] input')!.click());
    await act(async()=>reject.click());
    expect(posts).toHaveLength(1);expect(posts[0]).toMatchObject({scope:{targets:["first"]},resolution:{workId:"work",requestId:"request",approved:false},confirmed:true});
    expect(node.textContent).toContain("原授权内调整");expect(localStorage.length).toBe(0);
  }finally{act(()=>root.unmount());node.remove();localStorage.clear();}
});
it("reviews existing scope, persists an uncertain request and reconciles the same command after remount without resuming",async()=>{
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;localStorage.clear();
  let lost=true;const posts:any[]=[];
  const state={expectedRevision:4,expectedScopeRevision:1,scope:{autonomous:false},expiresAt:"2099-01-01T00:00:00.000Z",form:{version:1,description:"Scope",fields:[{path:["autonomous"],label:"Autonomy",description:"Run only",type:"boolean",required:false}]},policy:{allowedActions:[],deniedActions:[],resources:[]}};
  const bridge={protocolVersion:1 as const,async request(input:any){if(input.method==="GET")return {status:200,body:state};const body=JSON.parse(input.body);posts.push(body);if(lost)throw new Error("offline");return {status:200,body:{commandId:body.commandId,runId:"run",automaticResume:false}};}};
  const node=document.createElement("div");document.body.append(node);let root=createRoot(node);
  const mount=()=>root.render(React.createElement(PermissionChange,{bridge,conversationId:"conversation",runId:"run"}));
  const click=async(text:string)=>act(async()=>[...node.querySelectorAll("button")].find(b=>b.textContent===text)!.click());
  try{
    await act(async()=>mount());expect(posts).toHaveLength(0);await click("变更任务授权");
    const reason=node.querySelector("input")!;await act(async()=>{reason.value="Reviewed change";Simulate.change(reason);});
    expect(node.querySelector<HTMLInputElement>('input[type="checkbox"]:not([role="switch"])')!.checked).toBe(false);
    await act(async()=>node.querySelector<HTMLInputElement>('input[type="checkbox"]:not([role="switch"])')!.click());await click("核对授权");expect(posts).toHaveLength(0);
    await act(async()=>node.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());await click("确认变更授权");
    expect(posts).toHaveLength(1);expect(posts[0].scope).toEqual({autonomous:true});expect(localStorage.length).toBe(1);
    act(()=>root.unmount());root=createRoot(node);await act(async()=>mount());expect(posts).toHaveLength(1);
    lost=false;await click("核对原授权变更");expect(posts[1]).toEqual(posts[0]);expect(localStorage.length).toBe(0);expect(node.textContent).toContain("不会恢复任务");
  }finally{act(()=>root.unmount());node.remove();localStorage.clear();}
});
