import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import type Database from "better-sqlite3";
import type { ExecutionNode } from "@traceforge/execution-node";
import { ScenarioPackageRegistry, type ScenarioToolHostContext } from "@traceforge/scenario-sdk";
import { ToolProviderFairScheduler, type ExecutionToolAdapter, type ExecutionToolDiscoverySource,
  type GovernedExecutionPort, type GovernedExecutionSourceRegistration, type ToolExecutionContext } from "@traceforge/worker-runtime";
import { GovernedExecutionSources } from "./governed-execution-sources.js";
import { ProcessExecutionCapacity } from "./process-execution-capacity.js";
import { ExecutionNodeProcessTool } from "./worker-execution-adapters.js";
import { registerSecurityAgentFoundation } from "./security-agent-foundation.js";
import { database, initialize, definition } from "./test-fixtures/execution-recovery.js";
import { fixtureMcpNode } from "./test-fixtures/mcp-node.js";
import { foundationHost, eventually } from "./test-fixtures/foundation-host.js";

const databases:Database.Database[]=[],roots:string[]=[];
afterEach(()=>{vi.useRealTimers();for(const db of databases.splice(0))if(db.open)db.close();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const context:ToolExecutionContext={caseId:"case",runId:"run",workId:"work",workerId:"worker",scopeRef:"scope",leaseId:"lease",
  leaseExpiresAt:"2099-01-01T00:00:00.000Z",idempotencyKey:"call",effectivePermissions:{version:1,platform:"linux",
    filesystem:{read:[],write:[],deny:[]},network:"deny",process:{access:"sandboxed",interactive:false,background:false},secrets:"deny",sources:["fixture"]}};
const input={executable:"/fixture/program",workingDirectory:"/fixture",timeoutMs:1000};
const success={status:"succeeded" as const,summary:"Observed",raw:"",refs:[],retryable:false};
const http={authorizationAction:"observe",url:"https://example.invalid/",method:"GET",headers:{},timeoutMs:1000,responseLimitBytes:1000};
function adapter(execute:ExecutionToolAdapter["execute"],overrides:Partial<ExecutionToolAdapter>={}):ExecutionToolAdapter {
  return {name:"observe",source:"neutral",version:"1",priority:1,description:"Neutral",inputSchema:{type:"object"},providedCapabilities:["observe"],
    dependencyCapabilities:[],permissionRequirements:{},risk:"read_only",timeoutMs:1000,execute,...overrides};
}
async function fixture(options:{limits?:object;hang?:boolean;path?:string;noNode?:boolean}={}) {
  const sqlite=database(options.path);databases.push(sqlite);
  const scheduler=new ToolProviderFairScheduler({global:4,perWork:4,maximumWaitMs:30,...options.limits});
  const capacity=new ProcessExecutionCapacity(sqlite,scheduler),c=initialize(sqlite);
  await c.bindings.prepare({idempotencyKey:"call",invocationId:"first",tool:{name:"observe",source:"neutral",version:"1",contractFingerprint:"a".repeat(64)},
    inputFingerprint:"b".repeat(64),attribution:{caseId:"case",runId:"run",workId:"work"}});
  await c.bindings.beginExecution("call","lease","worker");
  const f=fixtureMcpNode();
  const node={...f.node,async waitProcessEvents(...args:Parameters<ExecutionNode["waitProcessEvents"]>){
    if(!options.hang)await f.node.terminateProcess(args[0]);return f.node.waitProcessEvents(...args);
  }};
  const manager=new GovernedExecutionSources(options.noNode ? undefined : node,capacity);
  const register=(execute:(port:GovernedExecutionPort,input:unknown,context:ToolExecutionContext)=>Promise<typeof success>,
    options:Partial<GovernedExecutionSourceRegistration>={},toolOverrides:Partial<ExecutionToolAdapter>={})=>{
    let port!:GovernedExecutionPort;
    const registration:GovernedExecutionSourceRegistration={source:"neutral",version:"1",process:"governed",create(p){port=p;return {source:"neutral",
      async discover(){return [adapter((input,ctx)=>execute(p,input,ctx),toolOverrides)];}};},...options};
    const source=manager.register(registration);return {source,get port(){return port;},registration};
  };
  const invoke=async(source:ExecutionToolDiscoverySource,ctx=context)=>{const tools=await source.discover();return tools[0]!.execute({},ctx);};
  return {...f,sqlite,scheduler,capacity,c,node,manager,register,invoke};
}

describe("Governed custom execution sources",()=>{
  it("attributes a child process to the source and exact parent invocation",async()=>{
    const f=await fixture(),s=f.register(async p=>{await p.executeProcess(input);return success;});
    expect(await f.invoke(s.source)).toEqual(success);
    const row=f.capacity.list("case","run").items[0]!;
    expect(row).toMatchObject({state:"terminal_observed",identity:{source:"neutral",version:"1",operation:"observe",kind:"work",parentInvocationKey:"call"}});
    expect(f.starts[0]!.attribution.idempotencyKey).toMatch(/^source-process:/);
    expect(f.starts[0]!.permissions).toEqual(context.effectivePermissions);
    expect(f.scheduler.snapshot()).toMatchObject({active:0,retained:1});
    expect(f.c.bindings.execution("call")?.status).toBe("executing");
  });
  it("keeps separate child keys for multiple operations in one invocation",async()=>{
    const f=await fixture(),s=f.register(async p=>{await p.executeProcess(input);await p.executeProcess(input);return success;});
    await f.invoke(s.source);expect(new Set(f.starts.map(r=>r.attribution.idempotencyKey)).size).toBe(2);
    expect(f.capacity.list("case","run").items).toHaveLength(2);
  });
  it("does not reserve fake process occupancy for memory-only tools",async()=>{
    const f=await fixture({noNode:true}),s=f.register(async()=>success,{process:"denied"});
    await f.invoke(s.source);expect(f.scheduler.snapshot().occupied).toBe(0);
  });
  it("denies a false no-process declaration at the host port",async()=>{
    const f=await fixture(),s=f.register(async p=>{await p.executeProcess(input);return success;},{process:"denied"});
    await expect(f.invoke(s.source)).rejects.toThrow("process execution denied");expect(f.starts).toHaveLength(0);
  });
  it("rejects a declared process capability under a process-denied policy",async()=>{
    const f=await fixture(),s=f.register(async()=>success,{process:"denied"},{permissionRequirements:{process:"sandboxed"}});
    await expect(s.source.discover()).rejects.toThrow("capability conflicts");
  });
  it.each([undefined,"raw","",null])("rejects invalid process mode %s",async mode=>{
    const f=await fixture();expect(()=>f.register(async()=>success,{process:mode as any})).toThrow("policy required");
  });
  it("rejects governed registration without an execution node",async()=>{
    const f=await fixture({noNode:true});expect(()=>f.register(async()=>success)).toThrow("requires Execution Node");
  });
  it.each(["", " neutral", "x".repeat(257)])("rejects invalid source identity",async source=>{
    const f=await fixture();expect(()=>f.register(async()=>success,{source})).toThrow("identity");
  });
  it("rejects mismatched factory source",async()=>{
    const f=await fixture();expect(()=>f.register(async()=>success,{source:"other"})).toThrow("identity mismatch");
  });
  it.each([{source:"other"},{version:"2"}])("rejects mismatched discovered tool %j",async override=>{
    const f=await fixture(),s=f.register(async()=>success,{},override);await expect(s.source.discover()).rejects.toThrow("identity/version");
  });
  it("never exposes raw node methods and rejects port use outside an operation",async()=>{
    const f=await fixture(),s=f.register(async()=>success);
    expect(Object.keys(s.port).sort()).toEqual(["executeProcess","requestHttp"]);
    expect(Object.isFrozen(s.port)).toBe(true);
    await expect(s.port.executeProcess(input)).rejects.toThrow("active source operation");
  });
  it("rejects a port captured from a different source",async()=>{
    const f=await fixture(),first=f.register(async()=>success);
    const second=f.manager.register({source:"second",version:"1",process:"governed",create(){return {source:"second",async discover(){
      return [adapter(async()=>{await first.port.executeProcess(input);return success;},{source:"second"})];}};}});
    await expect(f.invoke(second)).rejects.toThrow("active source operation");expect(f.starts).toHaveLength(0);
  });
  it("does not let an adapter mutate its granted context",async()=>{
    const f=await fixture(),s=f.register(async(p,_input,ctx)=>{ctx.idempotencyKey="forged";ctx.workerId="other";ctx.effectivePermissions.network="brokered";
      await p.executeProcess(input);return success;});
    await f.invoke(s.source,structuredClone(context));expect(f.starts[0]!.attribution.workerId).toBe("worker");
    expect(f.starts[0]!.permissions.network).toBe("deny");
  });
  it.each(["workerId","leaseId","workId","caseId","idempotencyKey"] as const)("rejects stale/foreign Work %s",async key=>{
    const f=await fixture(),s=f.register(async p=>{await p.executeProcess(input);return success;});
    await expect(f.invoke(s.source,{...context,[key]:"other"})).rejects.toThrow("exact current Work");expect(f.starts).toHaveLength(0);
  });
  it("rechecks ownership after waiting for shared capacity",async()=>{
    const f=await fixture({limits:{global:1,maximumWaitMs:1000}}),held=await f.scheduler.acquire({providerId:"held",providerVersion:"1",toolName:"held",caseId:"case",runId:"run",workId:"work"});
    const s=f.register(async p=>{await p.executeProcess(input);return success;}),call=f.invoke(s.source);
    const rejected=expect(call).rejects.toThrow("exact current Work");
    await eventually(async()=>f.scheduler.snapshot().queued===1);f.c.block();held.release();await rejected;expect(f.starts).toHaveLength(0);
  });
  it("shares the builtin process ceiling",async()=>{
    const f=await fixture({limits:{global:1}}),s=f.register(async p=>{await p.executeProcess(input);return success;});
    await f.invoke(s.source);
    await expect(new ExecutionNodeProcessTool(f.node,f.capacity).execute(input,context)).rejects.toMatchObject({reason:"wait_timeout"});
    expect(f.starts).toHaveLength(1);
  });
  it("cancels queued operations without dispatch or retained occupancy",async()=>{
    const f=await fixture({limits:{global:1,maximumWaitMs:1000}}),held=await f.scheduler.acquire({providerId:"held",providerVersion:"1",toolName:"held",caseId:"case",runId:"run",workId:"work"});
    const abort=new AbortController(),s=f.register(async p=>{await p.executeProcess(input);return success;});
    const call=f.invoke(s.source,{...context,signal:abort.signal}),rejected=expect(call).rejects.toThrow("cancelled");
    await eventually(async()=>f.scheduler.snapshot().queued===1);abort.abort(new Error("cancelled"));await rejected;held.release();
    await eventually(async()=>f.scheduler.snapshot().occupied===0);expect(f.starts).toHaveLength(0);
  });
  it("cancels an active process when its source closes and retains unknown cleanup",async()=>{
    const f=await fixture({hang:true}),s=f.register(async p=>{await p.executeProcess(input);return success;});
    const call=f.invoke(s.source),rejected=expect(call).rejects.toThrow("source closed");
    await eventually(async()=>f.starts.length===1);await s.source.close!();await rejected;
    await eventually(async()=>f.terminated()===1 && f.scheduler.snapshot().retained===1);
    await expect(s.source.discover()).rejects.toThrow("closed");
  });
  it("cleans a start response that arrives after cancellation",async()=>{
    const f=await fixture({hang:true});let release!:()=>void,entered=false;const gate=new Promise<void>(r=>{release=r;});
    const manager=new GovernedExecutionSources({...f.node,async startProcess(request){entered=true;await gate;return f.node.startProcess(request);}},f.capacity);
    const source=manager.register({source:"neutral",version:"1",process:"governed",create:p=>({source:"neutral",async discover(){return [adapter(async()=>{await p.executeProcess(input);return success;})];}})});
    const abort=new AbortController(),call=f.invoke(source,{...context,signal:abort.signal}),rejected=expect(call).rejects.toThrow("cancelled");
    await eventually(async()=>entered);abort.abort(new Error("cancelled"));await rejected;release();
    await eventually(async()=>f.terminated()===1);expect(f.scheduler.snapshot().retained).toBe(1);
  });
  it("bounds tools which ignore cancellation with the source operation deadline",async()=>{
    const f=await fixture({hang:true}),s=f.register(async p=>{void p.executeProcess(input).catch(()=>{});return new Promise(()=>{});},{},{timeoutMs:30});
    await expect(f.invoke(s.source)).rejects.toThrow("deadline");await eventually(async()=>f.terminated()===1);
  });
  it("does not let a detached process outlive a successful tool result",async()=>{
    const f=await fixture({hang:true}),s=f.register(async p=>{void p.executeProcess(input).catch(()=>{});return success;},{},{timeoutMs:30});
    await expect(f.invoke(s.source)).rejects.toThrow("deadline");await eventually(async()=>f.terminated()===1);
  });
  it("rejects delayed callbacks after the operation returns",async()=>{
    const f=await fixture();let late!:Promise<unknown>;
    const s=f.register(async p=>{late=new Promise(resolve=>setTimeout(()=>{void p.executeProcess(input).then(resolve,resolve);},20));return success;});
    await f.invoke(s.source);expect(await late).toMatchObject({message:expect.stringContaining("active source operation")});expect(f.starts).toHaveLength(0);
  });
  it("denies discovery processes without explicit service ownership",async()=>{
    const f=await fixture(),s=f.register(async()=>success,{create:p=>({source:"neutral",async discover(){await p.executeProcess(input);return [];}})});
    await expect(s.source.discover()).rejects.toThrow("service execution scope");expect(f.starts).toHaveLength(0);
  });
  it("accounts discovery under a real host service rather than a fake Work",async()=>{
    const f=await fixture(),authorize=vi.fn(),s=f.register(async()=>success,{discoveryService:{
      attribution:{...context,caseId:"service-case",runId:"service-run",workId:"service-work",actionId:"discovery"},
      permissions:context.effectivePermissions,authorize},create:p=>({source:"neutral",async discover(){await p.executeProcess(input);return [];}})});
    await s.source.discover();expect(authorize).toHaveBeenCalled();
    expect(f.capacity.list("service-case","service-run").items[0]?.identity).toMatchObject({kind:"service",operation:"discover"});
    expect(f.sqlite.prepare("SELECT 1 FROM tool_invocation_bindings WHERE run_id='service-run'").get()).toBeUndefined();
  });
  it("checks service authorization again immediately before process dispatch",async()=>{
    const f=await fixture();let checks=0;const s=f.register(async()=>success,{discoveryService:{attribution:{...context,actionId:"discovery"},permissions:context.effectivePermissions,
      authorize(){if(++checks>=4)throw new Error("service revoked");}},create:p=>({source:"neutral",async discover(){await p.executeProcess(input);return [];}})});
    await expect(s.source.discover()).rejects.toThrow("service revoked");expect(f.starts).toHaveLength(0);expect(f.scheduler.snapshot().occupied).toBe(0);
  });
  it("retains durable process ownership across database reopen",async()=>{
    const root=mkdtempSync(join(tmpdir(),"traceforge-source-"));roots.push(root);const path=join(root,"state.db");
    const f=await fixture({path}),s=f.register(async p=>{await p.executeProcess(input);return success;});await f.invoke(s.source);f.sqlite.close();
    const sqlite=database(path);databases.push(sqlite);const scheduler=new ToolProviderFairScheduler({global:1});
    const capacity=new ProcessExecutionCapacity(sqlite,scheduler);
    expect(capacity.list("case","run").items[0]?.identity).toMatchObject({source:"neutral",parentInvocationKey:"call"});
    expect(scheduler.snapshot().retained).toBe(1);
  });
  it("snapshots the host registration policy",async()=>{
    const f=await fixture(),s=f.register(async p=>{await p.executeProcess(input);return success;},{process:"denied"});
    s.registration.process="governed";await expect(f.invoke(s.source)).rejects.toThrow("denied");
  });
  it.each([0,NaN,Infinity,-1])("rejects invalid tool deadline %s before publishing",async timeoutMs=>{
    const f=await fixture(),s=f.register(async()=>success,{},{timeoutMs});await expect(s.source.discover()).rejects.toThrow("deadline");
  });
  it("rejects accidentally asynchronous service authorization",async()=>{
    const f=await fixture(),s=f.register(async()=>success,{discoveryService:{attribution:{...context,actionId:"discovery"},permissions:context.effectivePermissions,
      async authorize(){throw new Error("revoked");}},create:p=>({source:"neutral",async discover(){await p.executeProcess(input);return [];}})});
    await expect(s.source.discover()).rejects.toThrow("synchronously");expect(f.starts).toHaveLength(0);
  });
  it.each(["source","version"])("binds custom provider factory %s to the signed installation",async key=>{
    const f=await fixture(),installation={manifest:{source:"neutral",version:"1"}} as any;
    await expect(f.manager.registerProvider(installation,async copy=>{
      (copy.manifest as any)[key]="other";
      return {source:"neutral",version:"1",process:"denied",[key]:"other",create:()=>({source:"neutral",async discover(){return [];}})};
    })).rejects.toThrow("installation identity mismatch");
    expect(installation.manifest).toEqual({source:"neutral",version:"1"});
  });
  it("wraps matching custom provider factories in the same host port",async()=>{
    const f=await fixture(),source=await f.manager.registerProvider({manifest:{source:"neutral",version:"1"}} as any,()=>({
      source:"neutral",version:"1",process:"governed",create:p=>({source:"neutral",async discover(){return [adapter(async()=>{await p.executeProcess(input);return success;})];}})}));
    await f.invoke(source);expect(f.scheduler.snapshot().retained).toBe(1);
  });
});

describe("Production custom-source assembly",()=>{
  it.each(["source","factory"])("rejects unmanaged %s by default before initialization",async kind=>{
    const sqlite=database();databases.push(sqlite);const app=Fastify();
    try{expect(()=>registerSecurityAgentFoundation(app,sqlite,{} as any,"/unused",()=>false,kind==="source"?
      {toolDiscoverySources:[{source:"legacy",async discover(){return [];}}]}:{toolProviderSourceFactory:()=>({source:"legacy",async discover(){return [];}})})).toThrow("Unmanaged custom sources are disabled");}
    finally{await app.close();}
  });
  it("runs a declared memory source through the real foundation without the development escape hatch",async()=>{
    let calls=0;
    const host=await foundationHost({foundation:{allowUnmanagedDevelopmentSources:false,toolDiscoverySources:[],governedToolSources:[{
      source:"fixture.host",version:"1",process:"denied",create:()=>({source:"fixture.host",async discover(){return [adapter(async()=>{calls++;return success;},
        {name:"fixture.read",source:"fixture.host",providedCapabilities:["fixture.read"]})];}})}]}});
    try{await host.start();await eventually(async()=>calls===1);
      const diagnostic=await host.request("/api/security-tools/process-capacity-policy");
      expect(diagnostic.coverage).toMatchObject({unmanagedDevelopmentSources:false,arbitraryJavaScriptIsolation:false,
        governedSources:[{source:"fixture.host",version:"1",process:"denied",origin:"custom"}]});
      expect((await host.request("/api/security-tools/process-occupancies?caseId=case&runId=run")).items).toHaveLength(0);
    }finally{await host.close();}
  });
  it("labels the old fixture escape hatch as unmanaged",async()=>{
    const host=await foundationHost({empty:true});try{
      expect((await host.request("/api/security-tools/process-capacity-policy")).coverage.unmanagedDevelopmentSources).toBe(true);
    }finally{await host.close();}
  });
});

describe("Scenario host port boundary",()=>{
  async function scenario(execute:(ctx:ScenarioToolHostContext)=>Promise<typeof success>){
    const f=await fixture();let ctx!:ScenarioToolHostContext;
    const registry=new ScenarioPackageRegistry([{id:"neutral",version:"1",schemaRevision:1,definition,
      outputSchemas:[{kind:"decision",version:1,validate(){}}],authorizationPolicy:{parseScope:payload=>({payload,allowedActions:[],deniedActions:[]})},
      createToolSources(value){ctx=value;return [{source:"neutral",async discover(){return [adapter(()=>execute(value))];}}];}}]);
    const sources=f.manager.scenarioSources(registry,{} as any);
    return {...f,source:sources[0]!,ctx,registry};
  }
  it("never exposes a raw Execution Node to a Scenario package",async()=>{
    const f=await scenario(async ctx=>{expect("executionNode" in ctx).toBe(false);return success;});
    await f.invoke(f.source);expect(f.starts).toHaveLength(0);
  });
  it("defaults legacy Scenario factories to process-denied without changing their implementation",async()=>{
    const f=await scenario(async ctx=>{await ctx.execution!.executeProcess(input);return success;});
    await expect(f.invoke(f.source)).rejects.toThrow("process execution denied");
    expect(f.manager.diagnostics()[0]?.origin).toBe("scenario_legacy_process_denied");
  });
  it("allows an explicitly declared Scenario through the same governed process path",async()=>{
    const f=await scenario(async ctx=>{await ctx.execution!.executeProcess(input);return success;});
    const source=f.manager.scenarioSources(f.registry,{} as any,{neutral:{version:"1",process:"governed"}})[0]!;
    await f.invoke(source);expect(f.scheduler.snapshot().retained).toBe(1);
  });
  it("rejects unused Scenario policies rather than silently weakening coverage",async()=>{
    const f=await scenario(async()=>success);
    expect(()=>f.manager.scenarioSources(f.registry,{} as any,{typo:{version:"1",process:"denied"}})).toThrow("Unknown Scenario");
  });
  it("keeps brokered HTTP scoped and supplies host-owned attribution",async()=>{
    let request:any;
    const f=await scenario(async ctx=>{await ctx.execution!.requestHttp(http);return success;});
    f.node.requestHttp=async r=>{request=r;return {} as any;};
    await f.invoke(f.source);expect(request.attribution.idempotencyKey).toMatch(/^source-http:/);
    expect(request.attribution.runId).toBe("run");expect(request.permissions).toEqual(context.effectivePermissions);
    expect(f.scheduler.snapshot().occupied).toBe(0);
  });
});
