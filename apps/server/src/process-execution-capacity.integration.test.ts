import { afterEach, describe, expect, it } from "vitest";
import { sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import Fastify from "fastify";
import { ToolProviderFairScheduler, type ToolExecutionContext } from "@traceforge/worker-runtime";
import { ProcessExecutionCapacity, processCleanupSigningPayload, registerProcessCapacityRoutes, type ProcessCapacityInput, type SignedProcessCleanup } from "./process-execution-capacity.js";
import { ManagedExecutionCapacity } from "./managed-execution-capacity.js";
import { ExecutionNodeProcessTool } from "./worker-execution-adapters.js";
import { SqliteProcessExecutionJournal } from "./execution-process-journal.js";
import { AgentAuditProjection } from "./agent-audit-projection.js";
import { SqliteScenarioAgentEventStream } from "./scenario-agent-event-stream.js";
import { fixtureMcpNode } from "./test-fixtures/mcp-node.js";
import { at, authority, database, initialize, keys } from "./test-fixtures/execution-recovery.js";

const databases:Database.Database[]=[],roots:string[]=[];
afterEach(()=>{for(const db of databases.splice(0))if(db.open)db.close();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const input:ProcessCapacityInput={source:"neutral",version:"1",operation:"observe",kind:"service",attribution:{caseId:"case",runId:"run",workId:"work",
  workerId:"worker",leaseId:"lease",leaseExpiresAt:"2099-01-01T00:00:00.000Z",scopeRef:"scope",actionId:"observe",idempotencyKey:"process"}};
const allow={async authorize(){return {decision:"allowed" as const,authorizationRef:"test-only grant",expiresAt:"2099-01-01T00:00:00.000Z"};}};
const permissions:ToolExecutionContext["effectivePermissions"]={version:1,platform:"linux",filesystem:{read:[],write:[],deny:[]},network:"deny",
  process:{access:"sandboxed",interactive:false,background:false},secrets:"deny",sources:["test-only"]};
function signed(payload:Omit<SignedProcessCleanup,"signature">):SignedProcessCleanup {
  return {...payload,signature:sign(null,Buffer.from(processCleanupSigningPayload(payload)),keys.privateKey).toString("base64")};
}
function setup(limits={},path?:string){
  const sqlite=database(path);databases.push(sqlite);
  const scheduler=new ToolProviderFairScheduler({global:1,maximumWaitMs:15,...limits});
  const capacity=new ProcessExecutionCapacity(sqlite,scheduler,()=>at);
  return {sqlite,scheduler,capacity};
}
async function work(f:ReturnType<typeof setup>){
  const c=initialize(f.sqlite);
  await c.bindings.prepare({idempotencyKey:"call",invocationId:"first",tool:{name:"observe",source:"neutral",version:"1",contractFingerprint:"a".repeat(64)},
    inputFingerprint:"b".repeat(64),attribution:{caseId:"case",runId:"run",workId:"work"}});
  await c.bindings.beginExecution("call","lease","worker");return c;
}
async function retained(kind:"service"|"work"="service"){
  const f=setup();const c=kind==="work"?await work(f):undefined;
  const lease=await f.capacity.acquire({...input,kind,...(c?{parentInvocationKey:"call"}:{})});
  lease.beforeStart("request");
  const journal=new SqliteProcessExecutionJournal(f.sqlite);
  const identity={idempotencyKey:"process",requestId:"request",caseId:"case",runId:"run",workId:"work",leaseId:"lease"};
  const launch={nodeId:"node",generationId:"generation",launchId:"a".repeat(64),requestId:"request",requestFingerprint:"b".repeat(64)};
  journal.claim({schemaVersion:2,identity,launch,nodeId:"node",requestFingerprint:launch.requestFingerprint,status:"claimed",cleanup:"unverified",process:null,events:[],lostEvents:false,updatedAt:at});
  const id=f.capacity.list("case","run").items[0]!.id;
  const payload:Omit<SignedProcessCleanup,"signature">={format:"traceforge.process-cleanup.v1",keyId:"test-key",occupancyId:id,identity:f.capacity.inspect(id).identity,
    process:{identity,launch},cleanup:"terminal",evidenceRef:"test-only independent cleanup",issuedAt:at,expiresAt:"2026-08-30T00:05:00.000Z"};
  const trusted={...authority(),processAcceptance:{reference:"test-only node acceptance",nodeIds:["node"]}};
  const request=()=>({commandId:"cleanup",occupancyId:id,actor:"operator",reason:"Verify cleanup",evidence:signed(payload)});
  return {...f,c,lease,journal,id,payload,trusted,request};
}

describe("Shared builtin/MCP process occupancy",()=>{
  it.each([false,true])("retains observed or unknown termination without inventing service invocations (%s)",async terminal=>{
    const f=await retained();f.lease.finish(terminal);f.lease.finish(terminal);
    expect(f.scheduler.snapshot()).toMatchObject({active:0,retained:1,occupied:1});
    expect(f.capacity.inspect(f.id).state).toBe(terminal?"terminal_observed":"unknown");
    expect(f.sqlite.prepare("SELECT count(*) AS n FROM tool_invocation_bindings").get()).toEqual({n:0});
    await expect(f.capacity.acquire({...input,source:"second",attribution:{...input.attribution,runId:"other",idempotencyKey:"other"}})).rejects.toMatchObject({reason:"wait_timeout"});
  });
  it("releases a never-dispatched reservation and rejects subsequent dispatch",async()=>{
    const f=setup(),lease=await f.capacity.acquire(input);lease.finish(false);
    expect(f.scheduler.snapshot().occupied).toBe(0);expect(()=>lease.beforeStart("late")).toThrow("settled");
    expect(f.capacity.list("case","run").items[0]).toMatchObject({state:"released",proofRef:"host:not_dispatched"});
  });
  it.each(["workerId","leaseId","caseId","runId","workId"] as const)("rejects mismatched current Work %s before storing admission",async field=>{
    const f=setup();await work(f);
    await expect(f.capacity.acquire({...input,kind:"work",parentInvocationKey:"call",attribution:{...input.attribution,[field]:"other"}})).rejects.toThrow("exact current");
    expect(f.scheduler.snapshot().occupied).toBe(0);expect(f.capacity.list("case","run").items).toHaveLength(0);
  });
  it("rechecks current execution ownership at the dispatch barrier",async()=>{
    const f=setup(),c=await work(f),lease=await f.capacity.acquire({...input,kind:"work",parentInvocationKey:"call"});
    await c.bindings.markUncertain("call","ownership ended");
    expect(()=>lease.beforeStart("request")).toThrow("exact current");lease.finish(false);expect(f.scheduler.snapshot().occupied).toBe(0);
  });
  it("rechecks host authorization after queueing and immediately before start",async()=>{
    const f=setup();let allowed=true;
    const lease=await f.capacity.acquire(input,undefined,()=>{if(!allowed)throw new Error("revoked");});allowed=false;
    expect(()=>lease.beforeStart("request")).toThrow("revoked");lease.finish(false);
  });
  it("cancels queued admission without a durable process or a scheduler leak",async()=>{
    const f=setup();const first=await f.capacity.acquire(input),abort=new AbortController();
    const pending=f.capacity.acquire({...input,attribution:{...input.attribution,idempotencyKey:"second"}},abort.signal);
    abort.abort();await expect(pending).rejects.toMatchObject({reason:"cancelled"});first.finish(false);
    expect(f.capacity.list("case","run").items).toHaveLength(1);expect(f.scheduler.snapshot()).toMatchObject({occupied:0,queued:0});
  });
  it("counts multiple processes for one parent invocation independently",async()=>{
    const f=setup({global:2,perWork:2});await work(f);
    for(const key of ["one","two"]){const lease=await f.capacity.acquire({...input,kind:"work",parentInvocationKey:"call",attribution:{...input.attribution,idempotencyKey:key}});lease.beforeStart(key);lease.finish(true);}
    expect(f.scheduler.snapshot().retained).toBe(2);expect(f.capacity.list("case","run").items).toHaveLength(2);
  });
  it.each(["managed-first","process-first"])("shares a real scheduler with Managed Providers (%s)",async order=>{
    const f=setup(),c=await work(f),managed=new ManagedExecutionCapacity(f.sqlite,f.scheduler,c.bindings,()=>at);
    const identity={providerId:"provider",providerVersion:"1",toolName:"observe",caseId:"case",runId:"run",workId:"work"};
    if(order==="managed-first"){
      const permit=await f.scheduler.acquire(identity);managed.reserve(identity,"neutral",{...input.attribution,idempotencyKey:"call",effectivePermissions:permissions});
      managed.beforeStart("call","managed-request");managed.finish("call",true);permit.release();
      await expect(f.capacity.acquire(input)).rejects.toMatchObject({reason:"wait_timeout"});
    }else{
      const permit=await f.capacity.acquire(input);permit.beforeStart("request");permit.finish(true);
      await expect(f.scheduler.acquire(identity)).rejects.toMatchObject({reason:"wait_timeout"});
    }
    expect(f.scheduler.snapshot()).toMatchObject({active:0,retained:1});
  });
  it.each(["dispatch","settlement"])("preserves the dispatch boundary on %s storage failure",async phase=>{
    const f=setup(),lease=await f.capacity.acquire(input);
    if(phase==="settlement")lease.beforeStart("request");
    f.sqlite.exec("CREATE TRIGGER injected BEFORE UPDATE ON process_execution_occupancy BEGIN SELECT RAISE(ABORT,'injected'); END");
    if(phase==="dispatch"){
      expect(()=>lease.beforeStart("request")).toThrow("injected");f.sqlite.exec("DROP TRIGGER injected");lease.finish(false);
      expect(f.scheduler.snapshot().occupied).toBe(0);
    }else{expect(()=>lease.finish(true)).toThrow("injected");expect(f.scheduler.snapshot()).toMatchObject({active:0,retained:1});}
  });
  it("adopts legacy provenance without inventing a source or counting the same journal twice",async()=>{
    const f=await retained();f.lease.finish(false);
    const old=f.journal.get("process")!;
    f.journal.claim({...old,identity:{...old.identity,idempotencyKey:"legacy",requestId:"legacy-request"},launch:{...old.launch!,requestId:"legacy-request"}});
    f.capacity.restoreLegacy();f.capacity.restoreLegacy();
    expect(f.scheduler.snapshot().retained).toBe(2);
    expect(f.capacity.list("case","run").items.find(row=>row.identity.kind==="legacy")?.identity.source).toBe("legacy.unattributed");
  });
  it("holds a late builtin start after cancellation and sends cleanup when its descriptor arrives",async()=>{
    const f=setup();await work(f);const node=fixtureMcpNode(),abort=new AbortController();
    let resolve!:()=>void,started=false;const delayed=new Promise<void>(r=>{resolve=r;});
    const tool=new ExecutionNodeProcessTool({...node.node,startProcess:async request=>{started=true;await delayed;return node.node.startProcess(request);}},f.capacity);
    const result=tool.execute({executable:"fixture-only",workingDirectory:"/fixture",resources:{cpuTimeMs:1000,memoryBytes:134217728,maximumProcesses:1,writeBytes:1}},
      {...input.attribution,idempotencyKey:"call",effectivePermissions:permissions,signal:abort.signal});
    await new Promise(r=>setTimeout(r,0));expect(started).toBe(true);abort.abort(new Error("cancelled"));
    await expect(result).rejects.toThrow("cancelled");expect(f.scheduler.snapshot().retained).toBe(1);
    resolve();await new Promise(r=>setTimeout(r,0));expect(node.terminated()).toBe(1);expect(f.scheduler.snapshot().retained).toBe(1);
  });
  it("counts successful builtin process execution without treating exit as trusted cleanup",async()=>{
    const f=setup();await work(f);const node=fixtureMcpNode();
    let started!:Awaited<ReturnType<typeof node.node.startProcess>>;
    const tool=new ExecutionNodeProcessTool({...node.node,startProcess:async request=>{started=await node.node.startProcess(request);return started;},waitProcessEvents:async()=>({
      process:{...started.process,state:"exited",exitCode:0,lastEventSequence:0},events:[],nextSequence:0,lostEvents:false})},f.capacity);
    const result=await tool.execute({executable:"fixture-only",workingDirectory:"/fixture",resources:{cpuTimeMs:1000,memoryBytes:134217728,maximumProcesses:1,writeBytes:1}},
      {...input.attribution,idempotencyKey:"call",effectivePermissions:permissions});
    expect(result.status).toBe("succeeded");expect(f.scheduler.snapshot().retained).toBe(1);
    expect(f.capacity.list("case","run").items[0]).toMatchObject({state:"terminal_observed",identity:{source:"traceforge.builtin",kind:"work",parentInvocationKey:"call"}});
  });
});

describe("Independent process cleanup authorization",()=>{
  it.each(["service","work"] as const)("releases %s quota without changing task outcome or allowing retry",async kind=>{
    const f=await retained(kind);f.lease.finish(true);
    const results=await Promise.all([f.capacity.release(f.request(),allow,()=>f.trusted),f.capacity.release(f.request(),allow,()=>f.trusted)]);
    expect(results.map(r=>r.replayed).sort()).toEqual([false,true]);expect(f.scheduler.snapshot().occupied).toBe(0);
    expect(f.capacity.inspect(f.id)).toMatchObject({state:"released",automaticRetryAllowed:false});
    if(f.c)expect(f.c.bindings.execution("call")?.status).toBe("executing");
    expect(f.sqlite.prepare("SELECT count(*) AS n FROM process_cleanup_commands").get()).toEqual({n:1});
  });
  it.each(["missing-authorizer","denied","expired-grant","revoked","wrong-source","wrong-node","wrong-request","wrong-launch","wrong-identity","expired","tampered","missing-journal"])("keeps occupancy for %s",async mode=>{
    const f=await retained();f.lease.finish(false);let authorizer:typeof allow|undefined=allow;
    if(mode==="missing-authorizer")authorizer=undefined;
    if(mode==="denied")authorizer={async authorize(){return {decision:"denied"} as never;}};
    if(mode==="expired-grant")authorizer={async authorize(){return {decision:"allowed",authorizationRef:"grant",expiresAt:at};}};
    if(mode==="revoked")Object.assign(f.trusted,{revoked:true});
    if(mode==="wrong-source")f.trusted.sources=["other"];
    if(mode==="wrong-node")f.trusted.processAcceptance.nodeIds=["other"];
    if(mode==="wrong-request")(f.payload.process.identity as {requestId:string}).requestId="other";
    if(mode==="wrong-launch")(f.payload.process.launch as {generationId:string}).generationId="other";
    if(mode==="wrong-identity")f.payload.identity={};
    if(mode==="expired")f.payload.expiresAt=at;
    // A fresh dispatch without any independently attributable journal cannot be released.
    if(mode==="missing-journal"){
      const other=setup();const lease=await other.capacity.acquire(input);lease.beforeStart("request");lease.finish(false);
      await expect(other.capacity.release(f.request(),allow,()=>f.trusted)).rejects.toThrow();expect(other.scheduler.snapshot().retained).toBe(1);return;
    }
    const request=f.request();if(mode==="tampered")request.evidence.evidenceRef="changed after signing";
    await expect(f.capacity.release(request,authorizer,()=>f.trusted)).rejects.toThrow();expect(f.scheduler.snapshot().retained).toBe(1);
    expect(f.sqlite.prepare("SELECT count(*) AS n FROM process_cleanup_commands").get()).toEqual({n:0});
  });
  it("rejects cleanup while local waiting is active",async()=>{
    const f=await retained();await expect(f.capacity.release(f.request(),allow,()=>f.trusted)).rejects.toThrow("retained occupancy");f.lease.finish(false);
  });
  it("accepts an independently signed never-started claim but rejects a contradictory started journal",async()=>{
    const first=await retained();first.lease.finish(false);first.payload.cleanup="not_started";
    await first.capacity.release(first.request(),allow,()=>first.trusted);expect(first.scheduler.snapshot().occupied).toBe(0);
    const second=await retained(),node=fixtureMcpNode();
    const started=await node.node.startProcess({requestId:"request",attribution:input.attribution,executable:"fixture-only",workingDirectory:"/fixture",
      arguments:[],environment:{},stdin:"closed",timeoutMs:1000,outputLimitBytes:1024,permissions,
      resources:{cpuTimeMs:1000,memoryBytes:134217728,maximumProcesses:1,writeBytes:1}});
    second.journal.settle({...second.journal.get("process")!,status:"exit_observed",process:{...started.process,nodeId:"node",state:"exited",exitCode:0}});second.lease.finish(false);second.payload.cleanup="not_started";
    await expect(second.capacity.release(second.request(),allow,()=>second.trusted)).rejects.toThrow("does not cover");
    expect(second.scheduler.snapshot().retained).toBe(1);
  });
  it("does not project service occupancy onto a coincidentally named Run",async()=>{
    const f=await retained();initialize(f.sqlite);f.lease.finish(true);
    new AgentAuditProjection(f.sqlite,new SqliteScenarioAgentEventStream(f.sqlite)).reconcile();
    expect(f.sqlite.prepare("SELECT count(*) AS n FROM scenario_agent_fact_projections WHERE source_key LIKE 'processOccupancy:%'").get()).toEqual({n:0});
  });
  it("snapshots requests before awaiting authorization and rejects conflicting command replays",async()=>{
    const f=await retained();f.lease.finish(false);const request=f.request();
    const authorizer={async authorize(){request.reason="mutated";request.evidence.identity={};return allow.authorize();}};
    expect((await f.capacity.release(request,authorizer,()=>f.trusted)).reason).toBe("Verify cleanup");
    await expect(f.capacity.release(request,allow,()=>f.trusted)).rejects.toThrow("conflict");
    await expect(f.capacity.release(f.request(),undefined,()=>f.trusted)).rejects.toThrow("denied");
  });
  it("rolls back proof and audit together on release failure",async()=>{
    const f=await retained();f.lease.finish(true);
    f.sqlite.exec("CREATE TRIGGER injected BEFORE UPDATE ON process_execution_occupancy WHEN NEW.state='released' BEGIN SELECT RAISE(ABORT,'injected'); END");
    await expect(f.capacity.release(f.request(),allow,()=>f.trusted)).rejects.toThrow("injected");
    expect(f.sqlite.prepare("SELECT count(*) AS n FROM process_cleanup_commands").get()).toEqual({n:0});expect(f.scheduler.snapshot().retained).toBe(1);
    f.sqlite.exec("DROP TRIGGER injected");await f.capacity.release(f.request(),allow,()=>f.trusted);
    expect(()=>f.sqlite.exec("DELETE FROM process_execution_occupancy")).toThrow("permanent");
    expect(()=>f.sqlite.exec("UPDATE process_cleanup_commands SET fingerprint='changed'")).toThrow("immutable");
  });
  it("exposes bounded scoped reads and Work audit references without synthesizing service events",async()=>{
    const f=await retained("work");f.lease.finish(false);
    const audit=new AgentAuditProjection(f.sqlite,new SqliteScenarioAgentEventStream(f.sqlite));audit.reconcile();
    expect(audit.read("case","run","processOccupancy",f.id).state.status).toBe("unknown");
    expect(()=>audit.read("other","run","processOccupancy",f.id)).toThrow();
    const app=Fastify();registerProcessCapacityRoutes(app,f.capacity,undefined,()=>undefined);
    try{
      expect((await app.inject({method:"POST",url:"/api/security-tools/process-cleanup",payload:f.request()})).statusCode).toBe(409);
      f.sqlite.pragma("query_only=ON");
      expect((await app.inject("/api/security-tools/process-occupancies?caseId=case&runId=run&limit=1")).json()).toMatchObject({items:[{id:f.id}],nextCursor:null});
      expect((await app.inject("/api/security-tools/process-occupancies?caseId=other&runId=run")).json().items).toEqual([]);
      expect((await app.inject("/api/security-tools/process-occupancies?caseId=case&runId=run&limit=101")).statusCode).toBe(409);
      expect((await app.inject(`/api/security-tools/process-occupancy?id=${f.id}&caseId=other&runId=run`)).statusCode).toBe(409);
    }finally{await app.close();}
  });
  it.each(["reserved","dispatched","settlement_uncommitted"])("restores quota after SIGKILL at %s",async phase=>{
    const root=mkdtempSync(join(tmpdir(),"traceforge-process-capacity-"));roots.push(root);const path=join(root,"state.db");
    await new Promise<void>((resolve,reject)=>{
      const child=spawn(process.execPath,["--import","tsx",fileURLToPath(new URL("../test-fixtures/process-capacity-crash-host.mjs",import.meta.url)),path,phase],{stdio:["ignore","pipe","pipe"]});
      let ready=false,output="",errors="";const timer=setTimeout(()=>child.kill("SIGKILL"),10000);
      child.stdout.on("data",chunk=>{output+=chunk.toString();if(output.includes("\n")){ready=true;child.kill("SIGKILL");}});
      child.stderr.on("data",chunk=>{errors=(errors+chunk.toString()).slice(-4096);});
      child.on("error",error=>{clearTimeout(timer);reject(error);});
      child.on("exit",(_code,signal)=>{clearTimeout(timer);if(ready&&signal==="SIGKILL")resolve();else reject(new Error(errors||"Crash fixture deadline"));});
    });
    for(let restart=0;restart<2;restart++){
      const f=setup({},path);expect(f.scheduler.snapshot()).toMatchObject({active:0,retained:phase==="reserved"?0:1});
      expect(f.capacity.list("case","run").items[0]!.state).toBe(phase==="reserved"?"released":"dispatched");f.sqlite.close();
    }
  },15000);
});
