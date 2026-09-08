// @vitest-environment jsdom
import {expect,it} from "vitest";
import React,{act} from "react";
import {createRoot} from "react-dom/client";
import {Simulate} from "react-dom/test-utils";
import {McpSettings} from "./mcp-settings";
it("requires confirmation before discovery and retains editable configuration on failure",async()=>{
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  const binding={id:"neutral",version:"1",schemaRevision:1};
  const state={secureStorage:true,connections:[{connection:{id:"first",name:"First",transport:"streamable-http",endpoint:"https://mcp.example/mcp",package:binding,authorizationAction:"read",capability:"read"},revision:1,enabled:false,credentialConfigured:false,catalog:null,reviewedTools:[]}],packages:[{package:binding,title:"Neutral",actions:["read"],capabilities:["read"],resourceKinds:[]}]};
  const operations:string[]=[];const node=document.createElement("div");document.body.append(node);const root=createRoot(node);
  try{
    await act(async()=>root.render(React.createElement(McpSettings,{bridge:{protocolVersion:1,request:async(input)=>{if(input.method==="POST"){operations.push(JSON.parse(input.body!).operation);return {status:409,body:{error:"Unavailable"}};}return {status:200,body:state};}}})));
    const button=(name:string)=>[...node.querySelectorAll("button")].find(b=>b.textContent===name)!;
    await act(async()=>button("测试并发现工具").click());expect(operations).toEqual([]);
    await act(async()=>button("确认测试").click());expect(operations).toEqual(["test"]);
    const name=node.querySelector("input")!;
    await act(async()=>{name.value="Edited";Simulate.change(name);});
    await act(async()=>button("保存连接").click());expect(name.value).toBe("Edited");
    expect(node.querySelector('[role="alert"]')?.textContent).toContain("凭证输入已清空");
    expect(button("测试并发现工具").disabled).toBe(true);
  }finally{act(()=>root.unmount());node.remove();}
});
