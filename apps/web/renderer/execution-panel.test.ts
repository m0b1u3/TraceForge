// @vitest-environment jsdom
import {afterEach,expect,it,vi} from "vitest";
import React,{act} from "react";
import {createRoot} from "react-dom/client";
import {ExecutionPanel} from "./execution-panel";
let dispose:(()=>void)|undefined;
afterEach(()=>{act(()=>dispose?.());document.body.replaceChildren();localStorage.clear();});
async function mount(evidenceOnly=false,runs:unknown[]=[]){
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  const request=vi.fn(async(input:any)=>input.method==="GET"?{status:200,body:{runs}}:{status:500,body:{}});
  const node=document.createElement("div");document.body.append(node);const root=createRoot(node);dispose=()=>root.unmount();
  await act(async()=>root.render(React.createElement(ExecutionPanel,{bridge:{protocolVersion:1,request},conversationId:"first",messages:[],evidenceOnly})));
  return {node,request};
}
it("shows task records without a second start or scope form, and never dispatches on mount",async()=>{
  const {node,request}=await mount();expect(node.textContent).toContain("在对话中描述任务即可开始");
  expect(node.querySelector("input,textarea,select")).toBeNull();expect(request.mock.calls.every(([r])=>r.method==="GET")).toBe(true);
});
it("keeps evidence view read-only",async()=>{
  const {node}=await mount(true);expect(node.textContent).toContain("任务输出与引用");expect(node.querySelector("button")).toBeNull();
});
it("preserves explicit stop and its exact recovery identity",async()=>{
  const {node,request}=await mount(false,[{runId:"run",goal:"Task",status:"running",revision:3,outputs:[],workItems:[]}]);
  const button=(text:string)=>[...node.querySelectorAll("button")].find(b=>b.textContent===text)!;
  await act(async()=>button("停止任务").click());
  const first=request.mock.calls.find(([r])=>r.method==="POST")![0];
  expect(JSON.parse(first.body)).toMatchObject({runId:"run",expectedRevision:3});
  await act(async()=>button("核对原请求").click());
  expect(request.mock.calls.filter(([r])=>r.method==="POST")[1][0]).toEqual(first);
});
