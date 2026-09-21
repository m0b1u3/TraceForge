import { afterEach, expect, it } from "vitest";
import { ScenarioPackageRegistry } from "@traceforge/scenario-sdk";
import { foundationHost, eventually, type FoundationHost } from "./test-fixtures/foundation-host.js";
import { contextPackage, contextBinding, contextText } from "./test-fixtures/context-package.js";
import type { BrokeredHttpTransport } from "@traceforge/execution-node";
import { fixtureMcpNode } from "./test-fixtures/mcp-node.js";
import { DesktopMcpControl } from "./desktop-mcp.js";
const cleanup: Array<()=>Promise<void>>=[];
it("keeps the previously active revision when replacement activation fails",async()=>{
  const {h,f,secrets}=await setup();await enable(h);await h.start();
  await eventually(async()=>!!(await h.state()).workItems[0]?.pendingApproval);
  const control=new DesktopMcpControl(h.sqlite,new ScenarioPackageRegistry([contextPackage(["fixture.read","context.read"])]),()=>null,{transport:f.transport,secrets:{async read(ref){return secrets.get(ref);},async write(ref,value){secrets.set(ref,value);}}});
  control.attach({async activateSource(){
    expect(control.snapshot().connections[0].effective?.revision).toBe(1);
    await h.request("/api/scenarios/runs",{commandId:"during",runId:"during-replacement",caseId:"case",goal:"Neutral pending review",scopeRef:"run:scope",scenarioKind:"neutral",definitionVersion:1});
    throw new Error("injected activation failure");
  },async deactivateSource(){}} as Parameters<DesktopMcpControl["attach"]>[0],()=>{},()=>{});
  await control.operate({operation:"save",expectedRevision:1,connection:{...connection,name:"Replacement",destinationAddresses:["10.0.0.1"]}});
  expect(control.snapshot().connections[0].connection.destinationAddresses).toEqual(["10.0.0.1"]);
  expect(control.snapshot().connections[0].effective?.connection.destinationAddresses).toBeUndefined();
  const tested=await control.operate({operation:"test",id:"first",expectedRevision:2,confirmed:true});
  await expect(control.operate({operation:"activate",id:"first",expectedRevision:2,catalogDigest:tested.connections[0].catalog!.digest,tools:[{name:"observe",enabled:true,resources:[]}],confirmed:true})).rejects.toThrow();
  expect(control.snapshot().connections[0].effective?.revision).toBe(1);
  expect(control.allowed("run","desktop.mcp.first.r1")).toBe(true);
  expect(control.allowed("run","desktop.mcp.first.r2")).toBe(false);
  expect(control.allowed("during-replacement","desktop.mcp.first.r1")).toBe(true);
  expect(control.sources().map(source=>source.source)).toEqual(["desktop.mcp.first.r1"]);
});
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();});
const connection={id:"first",name:"First connection",transport:"streamable-http",endpoint:"https://mcp.example/mcp",package:contextBinding,authorizationAction:"fixture.read",capability:"fixture.read"};
function fixtureTransport() {
  const methods:string[]=[],headers:Record<string,string>[]=[];let changed=false,failure=0;
  const transport:BrokeredHttpTransport=async request=>{
    const rpc=JSON.parse(request.body!.toString());methods.push(rpc.method);headers.push(request.headers);
    if(failure)return {status:failure,headers:[],body:Buffer.from("private-token upstream error"),bodyTruncated:false};
    let result:unknown;
    if(rpc.method==="initialize")result={protocolVersion:"2025-03-26",serverInfo:{name:"neutral",version:changed?"2":"1"},capabilities:{tools:{}},instructions:"DO_NOT_TRUST"};
    else if(rpc.method==="tools/list")result={tools:[{name:"observe",description:"DO_NOT_TRUST",inputSchema:{type:"object",properties:{},additionalProperties:false}}]};
    else if(rpc.method==="tools/call")result={content:[{type:"text",text:"Neutral observation"}]};
    else return {status:202,headers:[],body:Buffer.alloc(0),bodyTruncated:false};
    return {status:200,headers:[{name:"content-type",value:"application/json"}],body:Buffer.from(JSON.stringify({jsonrpc:"2.0",id:rpc.id,result})),bodyTruncated:false};
  };return {transport,methods,headers,change(){changed=true;},fail(status:number){failure=status;}};
}
async function setup(stdio=false) {
  const f=fixtureTransport(),secrets=new Map<string,string>();
  const node=fixtureMcpNode();
  const h=await foundationHost({foundation:{scenarioPackageRegistry:new ScenarioPackageRegistry([contextPackage(["fixture.read","context.read"])]),toolDiscoverySources:[],
    contextResourceContents:[{package:contextBinding,resourceId:"first",content:contextText}],...(stdio?{executionNode:node.node}:{}),desktopMcp:{transport:f.transport,secrets:{async read(ref){return secrets.get(ref);},async write(ref,value){secrets.set(ref,value);}}}},
    model:async args=>{const c=JSON.parse(args.user);if(c.transcript.some((e:{kind:string})=>e.kind==="tool"))return {type:"complete",summary:"Observed",outputs:[]};
      const tool=c.tools.find((t:{source:string})=>t.source.startsWith("desktop.mcp."));if(!tool)return {type:"complete",summary:"No MCP selected",outputs:[]};
      return {type:"invoke_tool",invocation:{id:"first",tool:tool.name,input:{},rationale:"Observe"}};}});
  cleanup.push(()=>h.close());return {h,f,secrets,node};
}
async function enable(h:FoundationHost) {
  await h.request("/api/desktop/mcp",{operation:"save",expectedRevision:0,connection,credential:"private-token"});
  const tested=await h.request("/api/desktop/mcp",{operation:"test",id:"first",expectedRevision:1,confirmed:true});
  await h.request("/api/desktop/mcp",{operation:"activate",id:"first",expectedRevision:1,catalogDigest:tested.connections[0].catalog.digest,tools:[{name:"observe",enabled:true,resources:[]}],confirmed:true});
}
it("records safe diagnostics and invalidates an old successful catalog after a failed retest",async()=>{
  const {h,f}=await setup();
  const saved=await h.request("/api/desktop/mcp",{operation:"save",expectedRevision:0,connection,credential:"private-token"});
  expect(saved.connections[0].inspection.history[0]).toMatchObject({operation:"save",revision:1,success:true});
  expect(saved.connections[0].inspection.lastTest).toBeNull();expect(f.methods).toEqual([]);
  const tested=await h.request("/api/desktop/mcp",{operation:"test",id:"first",expectedRevision:1,confirmed:true});
  expect(tested.connections[0].inspection.lastTest).toMatchObject({revision:1,success:true});
  f.fail(401);
  await expect(h.request("/api/desktop/mcp",{operation:"test",id:"first",expectedRevision:1,confirmed:true})).rejects.toThrow();
  const failed=await h.request("/api/desktop/mcp");
  expect(failed.connections[0].catalog).toBeNull();
  expect(failed.connections[0].inspection.lastTest).toMatchObject({revision:1,success:false,code:"authentication"});
  expect(JSON.stringify(failed)).not.toContain("private-token");
  await expect(h.request("/api/desktop/mcp",{operation:"activate",id:"first",expectedRevision:1,catalogDigest:tested.connections[0].catalog.digest,tools:[{name:"observe",enabled:true,resources:[]}],confirmed:true})).rejects.toThrow();
});
it("saves without networking, explicitly discovers, activates through the tool runtime and preserves approval",async()=>{
  const {h,f}=await setup();
  const saved=await h.request("/api/desktop/mcp",{operation:"save",expectedRevision:0,connection,credential:"private-token"});
  expect(f.methods).toEqual([]);expect(JSON.stringify(saved)).not.toContain("private-token");
  const tested=await h.request("/api/desktop/mcp",{operation:"test",id:"first",expectedRevision:1,confirmed:true});
  expect(f.methods).toEqual(["initialize","notifications/initialized","tools/list"]);expect(f.headers[0]!.authorization).toBe("Bearer private-token");
  expect(JSON.stringify(tested)).not.toContain("DO_NOT_TRUST");
  await h.request("/api/desktop/mcp",{operation:"activate",id:"first",expectedRevision:1,catalogDigest:tested.connections[0].catalog.digest,tools:[{name:"observe",enabled:true,resources:[]}],confirmed:true});
  expect(f.methods).toHaveLength(3);
  await h.start();await eventually(async()=>(await h.state()).workItems[0]?.status==="waiting_approval");
  expect(f.methods).not.toContain("tools/call");
  const state=await h.state();
  await h.request("/api/scenarios/runs/run/work/work/operator-approval",{commandId:"approve",expectedRevision:state.revision,approvalId:state.workItems[0].pendingApproval.id,approved:true,reason:"Reviewed test invocation"});
  await eventually(async()=>(await h.state()).workItems[0]?.status==="completed");
  expect(f.methods.filter(m=>m==="tools/call")).toHaveLength(1);
  const usage=(await h.request("/api/desktop/mcp")).connections[0].inspection;
  expect(usage.runCount).toBe(1);expect(usage.runs).toEqual([{runId:"run",revision:1}]);
  expect(JSON.stringify(h.requests)).not.toContain("private-token");
  expect((await h.request("/api/foundation/extension-assembly")).unitCounts.mcp_tool_profile).toBe(1);
});
it("rejects stale review and keeps old Run pins while disabling cuts off all revisions",async()=>{
  const {h,f}=await setup();await enable(h);await h.start();
  await eventually(async()=>(await h.state()).workItems[0]?.status==="waiting_approval");
  await h.request("/api/desktop/mcp",{operation:"save",expectedRevision:1,connection:{...connection,name:"Edited"}});
  expect(h.sqlite.prepare("SELECT revision FROM desktop_mcp_runs WHERE run_id='run'").get()).toEqual({revision:1});
  await expect(h.request("/api/desktop/mcp",{operation:"activate",id:"first",expectedRevision:2,catalogDigest:"stale",tools:[{name:"observe",enabled:true,resources:[]}],confirmed:true})).rejects.toThrow();
  await h.request("/api/desktop/mcp",{operation:"disable",id:"first",expectedRevision:2});
  const state=await h.state();await h.request("/api/scenarios/runs/run/work/work/operator-approval",{commandId:"approve",expectedRevision:state.revision,approvalId:state.workItems[0].pendingApproval.id,approved:true,reason:"Already disabled"});
  await eventually(async()=>["completed","blocked","failed"].includes((await h.state()).workItems[0]?.status));expect(f.methods).not.toContain("tools/call");
});

it("discovers a new stdio program only through the sandbox and invokes it after approval",async()=>{
  const {h,node}=await setup(true);
  await h.request("/api/desktop/mcp",{operation:"save",expectedRevision:0,connection:{...connection,transport:"stdio",endpoint:"",executable:"/fixture/tool",workingDirectory:"/fixture",readPaths:["/fixture"],writePaths:[],arguments:[]}});
  expect(node.starts).toHaveLength(0);
  const tested=await h.request("/api/desktop/mcp",{operation:"test",id:"first",expectedRevision:1,confirmed:true});
  expect(tested.connections[0].catalog.tools[0].name).toBe("observe");expect(node.terminated()).toBe(1);
  await h.request("/api/desktop/mcp",{operation:"activate",id:"first",expectedRevision:1,catalogDigest:tested.connections[0].catalog.digest,tools:[{name:"observe",enabled:true,resources:[]}],confirmed:true});
  await h.start();await eventually(async()=>(await h.state()).workItems[0]?.status==="waiting_approval");
  const state=await h.state();await h.request("/api/scenarios/runs/run/work/work/operator-approval",{commandId:"approve",expectedRevision:state.revision,approvalId:state.workItems[0].pendingApproval.id,approved:true,reason:"Reviewed fixture"});
  await eventually(async()=>(await h.state()).workItems[0]?.status==="completed");expect(node.calls()).toBe(1);
  expect(node.starts.every(s=>s.permissions.network==="deny"&&s.permissions.process.access==="sandboxed")).toBe(true);
  expect(node.starts).toHaveLength(node.terminated());
});
