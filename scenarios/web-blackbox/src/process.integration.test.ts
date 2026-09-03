import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  authorizeScenarioResource,
  parseScenarioPackageDescriptor,
  parseScenarioScope,
  SCENARIO_PROCESS_HOST_CAPABILITIES,
} from "@traceforge/scenario-sdk";
import { ScenarioProcessRuntime, type ScenarioPackageCapabilityHandler, type ToolExecutionContext } from "@traceforge/worker-runtime";

const root=resolve("scenarios/web-blackbox");
const descriptor=parseScenarioPackageDescriptor(JSON.parse(readFileSync(resolve(root,"scenario.json"),"utf8")));
const context:ToolExecutionContext={workerId:"worker",caseId:"case",runId:"run",workId:"work",scopeRef:"scope",leaseId:"lease",
  leaseExpiresAt:"2099-01-01T00:00:00.000Z",idempotencyKey:"effect",
  effectivePermissions:{version:1,platform:process.platform==="win32"?"windows":process.platform==="darwin"?"darwin":"linux",
    filesystem:{read:[],write:[],deny:[]},network:"brokered",process:{access:"deny",interactive:false,background:false},secrets:"deny",sources:["test"]}};

interface SurfaceStorage {state:{revision:number;value:unknown}|null}
function runtime(calls:Array<{capability:string;action:string;input:unknown}>,storage:SurfaceStorage={state:null}){
  const handlers:ScenarioPackageCapabilityHandler[]=[{
    capability:SCENARIO_PROCESS_HOST_CAPABILITIES.authorization,actions:["require","authorize_resource"],async execute(input){
      const resource="resourceKind" in (input as object);calls.push({capability:SCENARIO_PROCESS_HOST_CAPABILITIES.authorization,action:resource?"authorize_resource":"require",input});
      if(resource)return {output:{id:"authorization",canonicalValue:(input as {value:string}).value},refs:["authorization:scope"]};
      return {output:{id:"authorization",scopePayload:{targets:["https://authorized.example/"]}},refs:["authorization:scope"]};
    },
  },{
    capability:SCENARIO_PROCESS_HOST_CAPABILITIES.execution,actions:["request_http","request_http_session"],async execute(input){calls.push({capability:SCENARIO_PROCESS_HOST_CAPABILITIES.execution,action:"request_http",input});
      const url=(input as {url:string}).url,body=url.endsWith("/next")?"Next":"<html><a href='/next'>Next</a><a href='https://outside.example/'>Outside</a></html>";
      return {output:{receipt:{id:`network-${calls.length}`},status:200,headers:[{name:"content-type",value:url.endsWith("/next")?"text/plain":"text/html"}],
        bodyBase64:Buffer.from(body).toString("base64"),responseBytes:Buffer.byteLength(body),bodyTruncated:false,replayed:false},refs:[`network-receipt:${calls.length}`]};},
  },{
    capability:SCENARIO_PROCESS_HOST_CAPABILITIES.artifacts,actions:["record","get","list"],async execute(input){calls.push({capability:SCENARIO_PROCESS_HOST_CAPABILITIES.artifacts,action:"record",input});
      return {output:{id:`artifact-${calls.length}`,contentRef:(input as {contentRef:string}).contentRef},refs:[(input as {contentRef:string}).contentRef]};},
  },{
    capability:SCENARIO_PROCESS_HOST_CAPABILITIES.evidence,actions:["record_node"],async execute(input){calls.push({capability:SCENARIO_PROCESS_HOST_CAPABILITIES.evidence,action:"record_node",input});
      return {output:{refs:[`evidence-${calls.length}`]},refs:[`evidence-${calls.length}`]};},
  },{
    capability:SCENARIO_PROCESS_HOST_CAPABILITIES.state,actions:["read","compare_and_set"],async execute(input){
      const operation=(input as {operation:string}).operation;calls.push({capability:SCENARIO_PROCESS_HOST_CAPABILITIES.state,action:operation,input});
      if(operation==="read")return {output:storage.state,refs:[]};const value=input as {expectedRevision:number;value:unknown};
      if(value.expectedRevision!==(storage.state?.revision??0))throw new Error("revision conflict");storage.state={revision:value.expectedRevision+1,value:value.value};return {output:storage.state,refs:[]};},
  },{
    capability:SCENARIO_PROCESS_HOST_CAPABILITIES.sessions,actions:["list_identities","open","list","close"],async execute(input){
      const operation=(input as {operation:string}).operation;calls.push({capability:SCENARIO_PROCESS_HOST_CAPABILITIES.sessions,action:operation,input});
      if(operation==="list_identities")return {output:[{id:"identity-1",caseId:"case",name:"Authorized user",kind:"user",version:1,status:"active"}],refs:[]};
      if(operation==="list")return {output:[],refs:[]};
      return {output:{id:"session-1",caseId:"case",runId:"run",scopeRef:"scope",identityId:"identity-1",identityVersion:1,status:operation==="close"?"closed":"active"},refs:["execution-session:session-1"]};
    },
  },{
    capability:SCENARIO_PROCESS_HOST_CAPABILITIES.traffic,actions:["list"],async execute(input){
      calls.push({capability:SCENARIO_PROCESS_HOST_CAPABILITIES.traffic,action:"list",input});return {output:[{id:"traffic-1",runId:"run",identityId:"identity-1",url:"https://authorized.example/",method:"GET",responseStatus:200}],refs:[]};
    },
  }];
  return new ScenarioProcessRuntime({manifest:descriptor.runtime!,launch:{executable:process.execPath,arguments:[resolve(root,"runtime/main.mjs")],workingDirectory:root,
    attestation:{sandboxed:false,backend:"test-only",network:"deny"}},capabilityHandlers:handlers,transport:{allowUnsandboxedDevelopment:true,requestTimeoutMs:3000}});
}

describe("Web black-box Scenario Process",()=>{
  it("loads the package as a pure-data descriptor with local Skill and Knowledge",()=>{
    expect(descriptor).toMatchObject({id:"traceforge.web-blackbox",version:"0.3.0",
      runtime:{hostCapabilities:expect.arrayContaining([SCENARIO_PROCESS_HOST_CAPABILITIES.authorization,SCENARIO_PROCESS_HOST_CAPABILITIES.execution,
        SCENARIO_PROCESS_HOST_CAPABILITIES.artifacts,SCENARIO_PROCESS_HOST_CAPABILITIES.state,SCENARIO_PROCESS_HOST_CAPABILITIES.evidence,
        SCENARIO_PROCESS_HOST_CAPABILITIES.sessions,SCENARIO_PROCESS_HOST_CAPABILITIES.traffic])}});
    expect(Object.hasOwn(descriptor,"createToolSources")).toBe(false);
    expect(descriptor.resourceManifest?.resources.map(item=>item.context?.type)).toEqual(["skill","knowledge"]);
    const scope=parseScenarioScope(descriptor.authorizationPolicy,{targets:["https://exact.example/health"],urlPrefixes:["https://authorized.example/"]});
    expect(authorizeScenarioResource(descriptor.authorizationPolicy,scope.payload,"network.url","https://exact.example/health"))
      .toBe("https://exact.example/health");
    expect(authorizeScenarioResource(descriptor.authorizationPolicy,scope.payload,"network.url","https://authorized.example/next"))
      .toBe("https://authorized.example/next");
    expect(()=>authorizeScenarioResource(descriptor.authorizationPolicy,scope.payload,"network.url","https://authorized.example.evil/"))
      .toThrow(/does not authorize/);
  });
  it("runs scope and HTTP tools through reverse host capabilities",async()=>{
    const calls:Array<{capability:string;action:string;input:unknown}>=[],source=runtime(calls);
    try{const tools=await source.discover(),scope=tools.find(tool=>tool.name==="scope.authorization.snapshot")!,http=tools.find(tool=>tool.name==="web.http.request")!;
      await expect(scope.execute({},context)).resolves.toMatchObject({status:"succeeded",refs:expect.arrayContaining(["authorization:scope"])});
      await expect(http.execute({url:"https://authorized.example/"},context)).resolves.toMatchObject({status:"succeeded",summary:"HTTP GET completed with status 200",refs:expect.arrayContaining([expect.stringMatching(/^network-receipt:/)])});
      expect(calls).toEqual(expect.arrayContaining([
        expect.objectContaining({capability:SCENARIO_PROCESS_HOST_CAPABILITIES.authorization,input:{action:"web.request.replay",resourceKind:"network.url",value:"https://authorized.example/"}}),
        expect.objectContaining({capability:SCENARIO_PROCESS_HOST_CAPABILITIES.execution,input:expect.objectContaining({url:"https://authorized.example/",method:"GET",bodyBase64:""})}),
      ]));
    }finally{await source.close?.();}
  });
  it("discovers same-origin links, checkpoints evidence, and resumes in a new process",async()=>{
    const calls:Array<{capability:string;action:string;input:unknown}>=[],storage:SurfaceStorage={state:null};let source=runtime(calls,storage);
    try{let explore=(await source.discover()).find(tool=>tool.name==="web.surface.explore")!;
      const first=await explore.execute({seeds:["https://authorized.example/"],maxRequests:1},context),firstOutput=JSON.parse(first.raw);
      expect(first).toMatchObject({status:"succeeded",summary:"Explored 1 authorized URL(s); 1 remain queued"});
      expect(firstOutput).toMatchObject({coverage:{visitedCount:1,queuedCount:1,observationCount:1,budgetExhausted:true},resume:{revision:1}});
      expect(firstOutput.observations[0]).toMatchObject({url:"https://authorized.example/",status:200,
        discoveredUrls:["https://authorized.example/next"],externalOrigins:["https://outside.example"]});
      await source.close?.();source=runtime(calls,storage);explore=(await source.discover()).find(tool=>tool.name==="web.surface.explore")!;
      const resumed=await explore.execute({seeds:[],maxRequests:1},{...context,idempotencyKey:"effect-resumed"}),resumedOutput=JSON.parse(resumed.raw);
      expect(resumed).toMatchObject({status:"succeeded",summary:"Explored 1 authorized URL(s); 0 remain queued"});
      expect(resumedOutput).toMatchObject({coverage:{visitedCount:2,queuedCount:0,observationCount:2,budgetExhausted:false},resume:{revision:2}});
      expect(calls.filter(item=>item.capability===SCENARIO_PROCESS_HOST_CAPABILITIES.artifacts)).toHaveLength(2);
      expect(calls.filter(item=>item.capability===SCENARIO_PROCESS_HOST_CAPABILITIES.evidence)).toHaveLength(2);
      expect(calls.filter(item=>item.capability===SCENARIO_PROCESS_HOST_CAPABILITIES.state&&item.action==="compare_and_set")).toHaveLength(2);
    }finally{await source.close?.();}
  });
  it("uses identity handles for authenticated requests and reads only redacted Traffic descriptors",async()=>{
    const calls:Array<{capability:string;action:string;input:unknown}>=[],source=runtime(calls);
    try{const tools=await source.discover(),catalog=tools.find(tool=>tool.name==="web.session.catalog")!,open=tools.find(tool=>tool.name==="web.session.open")!,
      request=tools.find(tool=>tool.name==="web.session.request")!,traffic=tools.find(tool=>tool.name==="web.traffic.snapshot")!;
      const listed=JSON.parse((await catalog.execute({},context)).raw);expect(listed.identities[0]).toMatchObject({id:"identity-1",name:"Authorized user"});
      await expect(open.execute({identityId:"identity-1"},context)).resolves.toMatchObject({status:"succeeded",refs:["execution-session:session-1"]});
      await expect(request.execute({sessionId:"session-1",url:"https://authorized.example/"},context)).resolves.toMatchObject({status:"succeeded"});
      await expect(traffic.execute({limit:10},context)).resolves.toMatchObject({status:"succeeded"});
      expect(calls).toContainEqual(expect.objectContaining({capability:SCENARIO_PROCESS_HOST_CAPABILITIES.execution,
        input:expect.objectContaining({sessionId:"session-1",sessionAuthorizationAction:"web.session.use"})}));
      expect(JSON.stringify(calls.filter(item=>item.capability===SCENARIO_PROCESS_HOST_CAPABILITIES.sessions))).not.toContain("Bearer");
    }finally{await source.close?.();}
  });
});
