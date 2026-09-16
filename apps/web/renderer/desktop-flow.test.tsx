// @vitest-environment jsdom
import React,{act} from "react";
import {createRoot} from "react-dom/client";
import {it,expect,vi} from "vitest";
import {ReplyQueue} from "./reply-queue";
import {ArtifactPreviewProvider,ArtifactPreviewPanel,useArtifactPreview} from "./artifact-preview";
import {conversationRuntimeView,mergeRunSnapshots} from "./conversation-runtime-view";

it("projects host revisions without making task completion up",()=>{
 const run={runId:"r",revision:3,status:"running",workItems:[],outputs:[],messageCommandId:null,goal:"g"};
 expect(mergeRunSnapshots([run],[{...run,revision:2,status:"completed"}])).toEqual([run]);
 expect(conversationRuntimeView([], [run],true,false).label).toContain("任务执行中");
 expect(conversationRuntimeView([], [run],true,true).ready).toBe(false);
});
it("reconciles the identical queue command after an unknown response",async()=>{
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;localStorage.clear();
 const view={conversationId:"c",revision:1,paused:false,items:[{messageId:"m",text:"Waiting"}]};
 let attempts=0;const commands:string[]=[];
 const request=vi.fn(async(input:any)=>{if(input.method==="GET")return {status:200,body:view};commands.push(input.body);if(attempts++===0)throw Error("lost");return {status:200,body:{...view,revision:2,paused:true}};});
 const node=document.createElement("div"),root=createRoot(node);
 try{
  await act(async()=>root.render(<ReplyQueue bridge={{protocolVersion:1,request}} conversationId="c" onChanged={()=>{}}/>));
  await act(async()=>[...node.querySelectorAll("button")].find(b=>b.textContent==="暂停接续")!.click());
  expect(node.textContent).toContain("请求结果尚未确认");
  expect(localStorage.getItem("traceforge.reply-queue.c")).toContain('"kind":"pause"');
  await act(async()=>[...node.querySelectorAll("button")].find(b=>b.textContent==="核对队列原请求")!.click());
  expect(commands).toHaveLength(2);expect(commands[0]).toBe(commands[1]);
  expect(node.textContent).toContain("已暂停接续");
 }finally{act(()=>root.unmount());localStorage.clear();}
});
it("keeps preview tabs scoped to the selected conversation and renders HTML as text",async()=>{
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
 const bridge={protocolVersion:1 as const,request:vi.fn()};
 function Open(){const p=useArtifactPreview();return <button onClick={()=>p!.open({kind:"text",conversationId:"a",sourceId:"s",title:"output",text:"<script>never execute</script>"})}>Open</button>;}
 const node=document.createElement("div"),root=createRoot(node);
 const draw=(id:string)=><ArtifactPreviewProvider><Open/><ArtifactPreviewPanel bridge={bridge} conversationId={id}/></ArtifactPreviewProvider>;
 try{
  await act(async()=>root.render(draw("a")));await act(async()=>node.querySelector("button")!.click());
  expect(node.querySelector("script")).toBeNull();expect(node.textContent).toContain("never execute");
  await act(async()=>root.render(draw("b")));expect(node.querySelector("aside")).toBeNull();
  await act(async()=>root.render(draw("a")));expect(node.textContent).toContain("never execute");expect(bridge.request).not.toHaveBeenCalled();
 }finally{act(()=>root.unmount());}
});
it("ignores an attachment response after switching conversations",async()=>{
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
 let finish!:(value:any)=>void;
 const bridge={protocolVersion:1 as const,request:vi.fn(()=>new Promise<any>(resolve=>{finish=resolve;}))};
 function Open(){const p=useArtifactPreview();return <button onClick={()=>p!.open({kind:"attachment",conversationId:"a",messageId:"m",index:0,title:"notes"})}>Open</button>;}
 const node=document.createElement("div"),root=createRoot(node);
 const draw=(id:string)=><ArtifactPreviewProvider><Open/><ArtifactPreviewPanel bridge={bridge} conversationId={id}/></ArtifactPreviewProvider>;
 try{
  await act(async()=>root.render(draw("a")));await act(async()=>node.querySelector("button")!.click());
  await act(async()=>root.render(draw("b")));
  await act(async()=>finish({status:200,body:{conversationId:"a",messageId:"m",index:0,name:"notes",digest:"a".repeat(64),kind:"text",text:"private to a",nextOffset:null}}));
  expect(node.textContent).not.toContain("private to a");expect(node.querySelector("aside")).toBeNull();
 }finally{act(()=>root.unmount());}
});
