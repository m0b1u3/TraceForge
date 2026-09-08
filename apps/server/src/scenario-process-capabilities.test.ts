import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { EvidenceGraphKernel, type KnowledgeNode } from "@traceforge/evidence-graph";
import { parseScenarioPackageDescriptor } from "@traceforge/scenario-sdk";
import { ScenarioProcessRuntime } from "@traceforge/worker-runtime";
import { SCENARIO_PROCESS_HOST_CAPABILITIES, type ScenarioToolHostContext } from "@traceforge/scenario-sdk";
import type { ToolExecutionContext } from "@traceforge/worker-runtime";
import type { ExecutionNode } from "@traceforge/execution-node";
import { createScenarioProcessCapabilityHandlers } from "./scenario-process-capabilities.js";
import { createDb, getSqliteClient } from "./db/client.js";
import { SqliteScenarioStateStore } from "./scenario-runtime-state.js";

const databases: Array<ReturnType<typeof getSqliteClient>> = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

const attribution: ToolExecutionContext = {
  workerId: "worker", caseId: "case", runId: "run", workId: "work", scopeRef: "scope", leaseId: "lease",
  leaseExpiresAt: "2100-01-01T00:00:00.000Z", idempotencyKey: "effect:one",
  effectivePermissions: { version: 1, platform: "linux", filesystem: { read: [], write: [], deny: [] }, network: "deny",
    process: { access: "deny", interactive: false, background: false }, secrets: "handles_only", sources: ["test"] },
};

function fixture(executionNode?:ExecutionNode) {
  const sqlite = getSqliteClient(createDb(":memory:")); databases.push(sqlite);
  const stateStore = new SqliteScenarioStateStore(sqlite);
  const calls: Array<{ port: string; input: unknown }> = [];
  const kernel = new EvidenceGraphKernel();
  let graph = kernel.execute(undefined, { type: "initialize_graph", caseId: "case", at: "2026-09-05T00:00:00.000Z" }).state;
  const context: Omit<ScenarioToolHostContext, "execution" | "capabilities"> = {
    authorization: {
      requireAction(scopeRef, caseId, action) { calls.push({ port: "authorization", input: { scopeRef, caseId, action } });
        return { id: "authorization", caseId, scenarioKind: "fixture", scopePayload: {}, expiresAt: attribution.leaseExpiresAt }; },
      authorizeResource(scopeRef, caseId, action, resourceKind, value) { calls.push({ port: "resource", input: { scopeRef, caseId, action, resourceKind, value } });
        return { id: "authorization", caseId, scenarioKind: "fixture", scopePayload: {}, expiresAt: attribution.leaseExpiresAt, canonicalValue: value }; },
    },
    evidence: { recordNode(input) {
      calls.push({ port: "evidence", input });
      graph = kernel.execute(graph, { type: "add_node", at: input.at,
        node: { ...input.node, caseId: input.caseId, runId: input.runId, source: null } as KnowledgeNode }).state;
      return [`knowledge-node:${input.node.id}`];
    } },
    artifacts: {
      record(input) { calls.push({ port: "artifact.record", input }); return { ...input, id: "artifact", createdAt: "2026-09-02T00:00:00.000Z" }; },
      get(input) { calls.push({ port: "artifact.get", input }); return undefined; },
      list(input) { calls.push({ port: "artifact.list", input }); return []; },
    },
    state: {
      read(input) { calls.push({ port: "state.read", input }); return stateStore.read(input); },
      compareAndSet(input) { calls.push({ port: "state.cas", input }); return stateStore.compareAndSet(input); },
    },
  };
  return { calls, handlers: createScenarioProcessCapabilityHandlers({ id: "fixture.package", version: "1.0.0" }, context,
    () => "2026-09-02T00:00:00.000Z",executionNode) };
}

describe("Scenario process host capabilities", () => {
  it("accepts Web comparison and surface observations through the real Host and graph contracts", async()=>{
    const node={async requestHttp(){return {receipt:{id:"request-receipt"},status:200,headers:[],bodyBase64:"",responseBytes:0,bodyTruncated:false,replayed:false};}} as unknown as ExecutionNode;
    const {handlers,calls}=fixture(node),root=resolve("scenarios/web-blackbox");
    for(const capability of [SCENARIO_PROCESS_HOST_CAPABILITIES.sessions,SCENARIO_PROCESS_HOST_CAPABILITIES.traffic]) {
      handlers.push({capability,actions:["list"],async execute(){throw new Error("Not exercised by anonymous observation contract test");}});
    }
    const descriptor=parseScenarioPackageDescriptor(JSON.parse(readFileSync(resolve(root,"scenario.json"),"utf8")));
    const source=new ScenarioProcessRuntime({manifest:descriptor.runtime!,launch:{executable:process.execPath,arguments:[resolve(root,"runtime/main.mjs")],workingDirectory:root,
      attestation:{sandboxed:false,backend:"test-only",network:"deny"}},capabilityHandlers:handlers,transport:{allowUnsandboxedDevelopment:true}});
    try{
      const tools=await source.discover();
      const comparison=await tools.find(tool=>tool.name==="web.validation.compare")!.execute({experimentId:"one",hypothesisId:"candidate-one",
        baseline:{url:"https://authorized.example/"},candidate:{url:"https://authorized.example/next"}},attribution);
      expect(JSON.parse(comparison.raw)).toMatchObject({status:"complete",findingVerified:false});
      const surface=JSON.parse((await tools.find(tool=>tool.name==="web.surface.explore")!.execute({seeds:["https://authorized.example/"],maxRequests:1},{...attribution,idempotencyKey:"surface"})).raw);
      const observations=calls.filter(call=>call.port==="evidence");
      expect(observations).toHaveLength(5);
      for(const observation of observations)expect(observation.input).toMatchObject({node:{kind:"fact",status:"active"}});
      const call=async(name:string,input:unknown,id:string)=>JSON.parse((await tools.find(tool=>tool.name===name)!.execute(input,{...attribution,idempotencyKey:id})).raw);
      await call("web.hypothesis.register",{candidateId:"first",statement:"first candidate",basisRefs:[surface.observations[0].networkReceipt]},"register");
      const plan={prepare:[{request:{url:"https://authorized.example/setup",method:"POST",purpose:"Explicit test setup"},expectedStatuses:[200]}],
        baseline:{url:"https://authorized.example/"},candidate:{url:"https://authorized.example/next"},changedCondition:"One resource change"};
      await call("web.validation.execute",{candidateId:"first",plan,maxRequests:1},"prepare");
      const observed=await call("web.validation.execute",{candidateId:"first",plan},"continue");
      expect(observed).toMatchObject({status:"observed",assessment:"no_observed_difference"});
      await call("web.validation.review",{candidateId:"first",outcome:"inconclusive",causalMechanism:"No effect established",expectedBoundary:"Rule not established",
        securityImpact:"No impact established",alternatives:"Equal responses do not establish safety",refs:observed.observations[0].refs},"review");
      const report=await call("web.report.build",{},"report");
      expect(report).toMatchObject({verifiedFindings:[],unresolved:[expect.objectContaining({id:"first",reviewRecorded:true})]});
      expect(calls.filter(call=>call.port==="evidence").map(call=>(call.input as any).node.kind)).toEqual([
        "fact","fact","fact","fact","fact","hypothesis","fact","fact","fact","fact","fact","limitation",
      ]);
    }finally{await source.close();}
  });
  it("injects authorization ownership from the active parent invocation", async () => {
    const { calls, handlers } = fixture(); const handler = handlers.find((item) => item.capability === SCENARIO_PROCESS_HOST_CAPABILITIES.authorization)!;
    await handler.execute({ action: "fixture.read" }, attribution, AbortSignal.timeout(100));
    expect(calls).toEqual([{ port: "authorization", input: { scopeRef: "scope", caseId: "case", action: "fixture.read" } }]);
  });

  it("injects Package, Case and Run ownership into Artifact and State writes", async () => {
    const { calls, handlers } = fixture();
    await handlers.find((item) => item.capability === SCENARIO_PROCESS_HOST_CAPABILITIES.artifacts)!.execute({
      operation: "record", commandId: "first", kind: "fixture.data", summary: "First", contentRef: "content:first",
      digest: `sha256:${"1".repeat(64)}`, byteSize: 1, metadata: {},
    }, attribution, AbortSignal.timeout(100));
    await handlers.find((item) => item.capability === SCENARIO_PROCESS_HOST_CAPABILITIES.state)!.execute({
      operation: "compare_and_set", commandId: "second", key: "cursor", expectedRevision: 0, value: { offset: 1 },
    }, attribution, AbortSignal.timeout(100));
    expect(calls[0]).toMatchObject({ port: "artifact.record", input: { packageId: "fixture.package", packageVersion: "1.0.0",
      caseId: "case", runId: "run", commandId: "scenario-process:effect:one:first" } });
    expect(calls[1]).toMatchObject({ port: "state.cas", input: { packageId: "fixture.package", packageVersion: "1.0.0",
      caseId: "case", runId: "run", commandId: "scenario-process:effect:one:second" } });
  });

  it("rejects child-supplied ownership and unknown input fields", async () => {
    const { handlers } = fixture(); const state = handlers.find((item) => item.capability === SCENARIO_PROCESS_HOST_CAPABILITIES.state)!;
    await expect(state.execute({ operation: "read", key: "cursor", runId: "forged" }, attribution, AbortSignal.timeout(100)))
      .rejects.toThrow(/fields are invalid/);
  });

  it("exposes only bounded HTTP through the generic Execution Node capability",async()=>{
    let request:unknown;
    const node={async requestHttp(input:unknown){request=input;return {receipt:{id:"receipt"},status:200,headers:[],bodyBase64:"",
      responseBytes:0,bodyTruncated:false,replayed:false};}} as unknown as ExecutionNode;
    const {handlers}=fixture(node),handler=handlers.find(item=>item.capability===SCENARIO_PROCESS_HOST_CAPABILITIES.execution)!;
    const result=await handler.execute({authorizationAction:"fixture.request",url:"https://authorized.example/",method:"GET",headers:{},
      bodyBase64:"",timeoutMs:1000,responseLimitBytes:1024},attribution,AbortSignal.timeout(100));
    expect(request).toMatchObject({authorizationAction:"fixture.request",url:"https://authorized.example/",method:"GET",
      attribution:{caseId:"case",runId:"run",workId:"work",workerId:"worker",scopeRef:"scope",leaseId:"lease"},permissions:attribution.effectivePermissions});
    expect(result.refs).toEqual(["network-receipt:receipt"]);
  });

  it("injects Session secrets inside the Host, captures cookies, and persists only redacted Traffic",async()=>{
    let request:any,updated:any,updatedValues:any,recorded:any;const session={id:"session",caseId:"case",runId:"run",scopeRef:"scope",identityId:"identity",identityVersion:2,
      status:"active" as const,lastWorkerId:null,lastWorkId:null,lastLeaseId:null,lastLeaseExpiresAt:null,expiresAt:"2100-01-01T00:00:00.000Z",
      createdAt:"2026-09-03T00:00:00.000Z",updatedAt:"2026-09-03T00:00:00.000Z"};
    const sessions={listIdentities:()=>[],openSession:()=>session,use:()=>({session,headers:{Authorization:"Bearer hidden-token"},urlPrefixes:["https://authorized.example/"],
      cookies:[{name:"sid",value:"hidden-cookie",domain:"authorized.example",path:"/private",secure:true}],values:{username:"alice",password:"very-secret-password"}}),
      updateCookies:(id:string,cookies:unknown)=>{updated={id,cookies};},listSessions:()=>[session],close:()=>({...session,status:"closed" as const})};
    Object.assign(sessions,{updateValues:(id:string,values:unknown)=>{updatedValues={id,values};}});
    const traffic={recordHttpExchange:(input:unknown)=>{recorded=input;},listRun:()=>[]};
    const node={async requestHttp(input:any){request=input;return {receipt:{id:"receipt",nodeId:"node",requestId:input.requestId,attribution:input.attribution,
      authorizationRef:"scope",authorizationAction:input.authorizationAction,url:input.url,method:input.method,status:200,requestBytes:0,responseBytes:42,
      responseBodyTruncated:false,permissionProfileFingerprint:"fingerprint",redirectFollowed:false,startedAt:"now",completedAt:"now"},status:200,
      headers:[{name:"content-type",value:"text/plain"},{name:"set-cookie",value:"rotated=new-cookie; Path=/private; Secure; HttpOnly"}],
      bodyBase64:Buffer.from("token=hidden-token cookie=hidden-cookie csrf=[csrf-secret]").toString("base64"),responseBytes:62,bodyTruncated:false,replayed:false};}} as unknown as ExecutionNode;
    const handler=createScenarioProcessCapabilityHandlers({id:"fixture.package",version:"1.0.0"},
      ({authorization:{requireAction(){return {id:"scope"};},authorizeResource(){throw new Error("unused");}},evidence:{} as any,artifacts:{} as any,state:{} as any}) as any,
      ()=>"2026-09-03T00:00:00.000Z",node,sessions as any,traffic as any).find(item=>item.capability===SCENARIO_PROCESS_HOST_CAPABILITIES.execution)!;
    const result=await handler.execute({authorizationAction:"fixture.request",sessionAuthorizationAction:"fixture.session",sessionId:"session",
      url:"https://authorized.example/private/page",method:"POST",headers:{Accept:"text/plain"},
      secretBody:{format:"form",fields:{username:{secret:"username"},password:{secret:"password"},mode:{literal:"login"}}},
      captures:[{name:"csrf",start:"csrf=[",end:"]",maximumBytes:128}],timeoutMs:1000,responseLimitBytes:1024},
      attribution,AbortSignal.timeout(100));
    expect(request.headers).toMatchObject({Authorization:"Bearer hidden-token",Cookie:"sid=hidden-cookie",Accept:"text/plain"});
    expect(Buffer.from(request.bodyBase64,"base64").toString("utf8")).toContain("password=very-secret-password");
    expect(updated).toMatchObject({id:"session",cookies:[expect.objectContaining({name:"rotated",value:"new-cookie",domain:"authorized.example",path:"/private"})]});
    expect(updatedValues).toEqual({id:"session",values:{csrf:"csrf-secret"}});
    expect(JSON.stringify(result.output)).not.toContain("hidden-token");expect(JSON.stringify(result.output)).not.toContain("hidden-cookie");
    expect(JSON.stringify(result.output)).not.toContain("new-cookie");expect((result.output as any).headers).toEqual([{name:"content-type",value:"text/plain"}]);
    expect(JSON.stringify(result.output)).not.toContain("csrf-secret");expect((result.output as any).capturedSecretNames).toEqual(["csrf"]);
    expect(recorded).toMatchObject({identityId:"identity",identityVersion:2,attributionSource:"scenario_session",
      requestHeaders:{Accept:"[present]",Authorization:"[redacted]",Cookie:"[redacted]","Content-Type":"[present]"}});
    expect(recorded.requestBody).toContain("[secret:password]");expect(JSON.stringify(recorded)).not.toContain("very-secret-password");
    expect(JSON.stringify(recorded)).not.toContain("hidden-token");expect(JSON.stringify(recorded)).not.toContain("hidden-cookie");
    await expect(handler.execute({authorizationAction:"fixture.request",sessionAuthorizationAction:"fixture.session",sessionId:"session",
      url:"https://authorized.example/private/page",method:"GET",headers:{Authorization:"forged"},bodyBase64:"",timeoutMs:1000,responseLimitBytes:1024},
      attribution,AbortSignal.timeout(100))).rejects.toThrow(/Host Session/);
    await expect(handler.execute({authorizationAction:"fixture.request",sessionAuthorizationAction:"fixture.session",sessionId:"session",
      url:"https://outside.example/",method:"GET",headers:{},bodyBase64:"",timeoutMs:1000,responseLimitBytes:1024},
      attribution,AbortSignal.timeout(100))).rejects.toThrow(/not authorized for this URL/);
  });

  it("lists only identity handles explicitly present in the active Scope",async()=>{
    const session={id:"session",caseId:"case",runId:"run",scopeRef:"scope",identityId:"identity:allowed",identityVersion:1,
      status:"active" as const,lastWorkerId:null,lastWorkId:null,lastLeaseId:null,lastLeaseExpiresAt:null,expiresAt:"2100-01-01T00:00:00.000Z",
      createdAt:"2026-09-03T00:00:00.000Z",updatedAt:"2026-09-03T00:00:00.000Z"};
    const identities=["identity:allowed","identity:hidden"].map((id,index)=>({id,caseId:"case",label:`Identity ${index+1}`,version:1,status:"active" as const,
      expiresAt:null,urlPrefixes:["https://authorized.example/"],headerNames:["Authorization"],cookieNames:[],secretNames:[],
      createdAt:"2026-09-03T00:00:00.000Z",updatedAt:"2026-09-03T00:00:00.000Z"}));
    const sessions={listIdentities:()=>identities,openSession:()=>session,use:()=>{throw new Error("unused");},updateCookies:()=>{},updateValues:()=>{},
      listSessions:()=>[session],close:()=>({...session,status:"closed" as const})};
    const handler=createScenarioProcessCapabilityHandlers({id:"fixture.package",version:"1.0.0"},{authorization:{
      requireAction(){return {id:"scope"};},authorizeResource(_scopeRef:string,_caseId:string,_action:string,_kind:string,value:string){
        if(value!=="identity:allowed")throw new Error("outside Scope");return {id:"scope",canonicalValue:value};}},
      evidence:{} as any,artifacts:{} as any,state:{} as any} as any,()=>"2026-09-03T00:00:00.000Z",undefined,sessions as any)
      .find(item=>item.capability===SCENARIO_PROCESS_HOST_CAPABILITIES.sessions)!;
    const result=await handler.execute({operation:"list_identities",authorizationAction:"fixture.session",resourceKind:"identity.handle"},
      attribution,AbortSignal.timeout(100));
    expect((result.output as Array<{id:string}>).map(item=>item.id)).toEqual(["identity:allowed"]);
  });
});
