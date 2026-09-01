import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { canonicalJson } from "@traceforge/orchestration-core";
import Fastify from "fastify";
import type Database from "better-sqlite3";
import { ToolProviderFairScheduler, type ToolExecutionContext } from "@traceforge/worker-runtime";
import { ManagedExecutionCapacity, registerManagedExecutionCapacityRoutes } from "./managed-execution-capacity.js";
import { SqliteProcessExecutionJournal } from "./execution-process-journal.js";
import { SignedToolRecoveryEvidenceVerifier } from "./tool-recovery-evidence.js";
import { SqliteScenarioAgentEventStream } from "./scenario-agent-event-stream.js";
import { AgentAuditProjection } from "./agent-audit-projection.js";
import { SqliteToolReceiptStore } from "./worker-execution-adapters.js";
import { at, authority, controls, database, evidence, initialize, signEvidence } from "./test-fixtures/execution-recovery.js";

const databases:Database.Database[]=[],roots:string[]=[];
afterEach(()=>{for(const db of databases.splice(0))if(db.open)db.close();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const identity={providerId:"neutral.provider",providerVersion:"v2",toolName:"observe",caseId:"case",runId:"run",workId:"work"};
const allow={async authorize(){return {decision:"allowed" as const,reason:"test-only cleanup grant"};}};
const deny={async authorize(){return {decision:"denied" as const,reason:"no grant"};}};
async function fixture(path?:string){
  const sqlite=database(path);databases.push(sqlite);const c=initialize(sqlite);
  await c.bindings.prepare({idempotencyKey:"call",invocationId:"first",tool:{name:"observe",source:"neutral",version:"1",contractFingerprint:"a".repeat(64)},
    inputFingerprint:"b".repeat(64),attribution:{caseId:"case",runId:"run",workId:"work"}});
  await c.bindings.beginExecution("call","lease","worker");
  const scheduler=new ToolProviderFairScheduler({global:1,maximumWaitMs:20});
  const capacity=new ManagedExecutionCapacity(sqlite,scheduler,c.bindings,()=>at);
  const lease=await scheduler.acquire(identity);
  const context={idempotencyKey:"call",caseId:"case",runId:"run",workId:"work",leaseId:"lease",workerId:"worker",scopeRef:"scope",leaseExpiresAt:"2099-01-01T00:00:00.000Z",effectivePermissions:{}} as ToolExecutionContext;
  capacity.reserve(identity,"neutral",context);
  const journal=new SqliteProcessExecutionJournal(sqlite);
  const processIdentity={idempotencyKey:"call",requestId:"request",caseId:"case",runId:"run",workId:"work",leaseId:"lease"};
  const launch={nodeId:"node",generationId:"generation",launchId:"a".repeat(64),requestId:"request",requestFingerprint:"b".repeat(64)};
  const trusted={...authority(),processAcceptance:{reference:"test-only acceptance",nodeIds:["node"]}};
  const verifier=new SignedToolRecoveryEvidenceVerifier(sqlite,()=>trusted,()=>at);
  const dispatch=()=>{capacity.beforeStart("call","request");journal.claim({schemaVersion:2,identity:processIdentity,launch,nodeId:"node",requestFingerprint:launch.requestFingerprint,status:"claimed",cleanup:"unverified",process:null,events:[],lostEvents:false,updatedAt:at});};
  const request=()=>{const payload=evidence(c);payload.process={identity:processIdentity,launch};payload.assertion.cleanup.status="terminal";
    return {commandId:"cleanup",actor:"operator",reason:"Confirm cleanup",idempotencyKey:"call",evidence:signEvidence(payload)};};
  return {...c,scheduler,capacity,lease,context,dispatch,request,verifier,trusted};
}

describe("External managed execution occupancy",()=>{
  it.each(["reserved","dispatched","settlement_uncommitted"])("restores the durable capacity boundary after SIGKILL at %s",async(phase)=>{
    const root=mkdtempSync(join(tmpdir(),"traceforge-capacity-crash-"));roots.push(root);const path=join(root,"state.db");
    await new Promise<void>((resolve,reject)=>{
      const child=spawn(process.execPath,["--import","tsx",fileURLToPath(new URL("../test-fixtures/execution-capacity-crash-host.mjs",import.meta.url)),path,phase],{stdio:["ignore","pipe","pipe"]});
      let ready=false,output="",errors="",failure:Error|undefined;
      const timer=setTimeout(()=>{failure=new Error("Capacity crash fixture timed out");child.kill("SIGKILL");},10000);
      child.stdout.on("data",chunk=>{output+=chunk.toString();if(output.includes("\n")){ready=true;child.kill("SIGKILL");}});
      child.stderr.on("data",chunk=>{errors=(errors+chunk.toString()).slice(-4096);});
      child.on("error",error=>{clearTimeout(timer);reject(error);});
      child.on("exit",(_code,signal)=>{clearTimeout(timer);if(failure)reject(failure);else if(!ready||signal!=="SIGKILL")reject(new Error(errors));else resolve();});
    });
    for(let restart=0;restart<2;restart++){
      const db=database(path);databases.push(db);const c=controls(db);c.bindings.recoverInterrupted();
      const capacity=new ManagedExecutionCapacity(db,new ToolProviderFairScheduler({global:1}),c.bindings,()=>at);
      expect(capacity.scheduler.snapshot()).toMatchObject({active:0,retained:phase==="reserved"?0:1});
      expect(capacity.inspect("call").state).toBe(phase==="reserved"?"released":"dispatched");
      expect(c.runtime.load("run")!.workItems).toHaveLength(1);db.close();
    }
  },15000);
  it("retains terminal observation and keeps unrelated execution waiting until authorized release",async()=>{
    const f=await fixture();f.dispatch();f.capacity.finish("call",true);f.lease.release();
    expect(f.capacity.inspect("call")).toMatchObject({state:"terminal_observed",externallyOccupied:true,localWaitActive:false});
    await expect(f.scheduler.acquire({...identity,runId:"other",workId:"other"})).rejects.toMatchObject({reason:"wait_timeout"});
    const result=await f.capacity.release(f.request(),allow,f.verifier);expect(result.outcome).toBe("released");
    expect(f.scheduler.snapshot()).toMatchObject({active:0,retained:0,occupied:0});
    expect((await f.capacity.release(f.request(),deny,f.verifier)).replayed).toBe(true);
    expect(f.bindings.execution("call")?.status).toBe("executing"); // cleanup release never fabricates an invocation result
    expect(f.runtime.load("run")!.workItems).toHaveLength(1);
  });
  it("releases a completed invocation only with cleanup proof covering its exact receipt",async()=>{
    const f=await fixture();f.dispatch();f.capacity.finish("call",true);f.lease.release();
    const result={status:"succeeded" as const,summary:"observed",raw:"",refs:[],retryable:false};
    await new SqliteToolReceiptStore(f.sqlite).put("call",result);await f.bindings.complete("call");
    expect((await f.capacity.release(f.request(),allow,f.verifier)).outcome).toBe("rejected");
    const payload=evidence(f);payload.process=f.request().evidence.process;payload.assertion.cleanup.status="terminal";
    payload.assertion.outcome="result_confirmed";payload.assertion.resultFingerprint=createHash("sha256").update(canonicalJson(result)).digest("hex");
    expect((await f.capacity.release({...f.request(),commandId:"completed-cleanup",evidence:signEvidence(payload)},allow,f.verifier)).outcome).toBe("released");
    expect(f.scheduler.snapshot().occupied).toBe(0);expect(f.bindings.execution("call")?.status).toBe("completed");
  });
  it.each([false,true])("rebuilds dispatched occupancy across disk reopen (terminal observed=%s)",async(terminal)=>{
    const root=mkdtempSync(join(tmpdir(),"traceforge-occupancy-"));roots.push(root);const path=join(root,"state.db"),f=await fixture(path);
    f.dispatch();f.capacity.finish("call",terminal);f.lease.release();f.sqlite.close();
    const db=database(path);databases.push(db);const c=controls(db);c.bindings.recoverInterrupted();
    const scheduler=new ToolProviderFairScheduler({global:1,maximumWaitMs:10});const capacity=new ManagedExecutionCapacity(db,scheduler,c.bindings,()=>at);
    expect(scheduler.snapshot()).toMatchObject({active:0,retained:1,occupied:1});
    await expect(scheduler.acquire({...identity,runId:"other"})).rejects.toMatchObject({reason:"wait_timeout"});
    expect(capacity.inspect("call").externallyOccupied).toBe(true);
  });
  it("releases only a provably undispatched local reservation",async()=>{
    const f=await fixture();f.capacity.finish("call",false);f.lease.release();
    expect(f.capacity.inspect("call")).toMatchObject({state:"released",proofRef:"host:not_dispatched"});
    const restored=new ManagedExecutionCapacity(f.sqlite,new ToolProviderFairScheduler(),f.bindings,()=>at);
    expect(restored.scheduler.snapshot().occupied).toBe(0);
  });
  it("recovers a persisted reservation interrupted before the dispatch barrier",async()=>{
    const root=mkdtempSync(join(tmpdir(),"traceforge-reserved-"));roots.push(root);const path=join(root,"state.db"),f=await fixture(path);
    // No finish callback: only the committed reservation survives this Host.
    f.sqlite.close();const db=database(path);databases.push(db);const c=controls(db);c.bindings.recoverInterrupted();
    const restored=new ManagedExecutionCapacity(db,new ToolProviderFairScheduler({global:1}),c.bindings,()=>at);
    expect(restored.inspect("call")).toMatchObject({state:"released",proofRef:"host:not_dispatched"});
    expect(restored.scheduler.snapshot().occupied).toBe(0);
    expect(c.bindings.execution("call")?.status).toBe("uncertain");
  });
  it.each([false,true])("adopts legacy completed invocations conservatively (ambiguous=%s)",async(ambiguous)=>{
    const db=database();databases.push(db);const c=initialize(db);
    await c.bindings.prepare({idempotencyKey:"legacy",invocationId:"first",tool:{name:"observe",source:"neutral",version:"1",contractFingerprint:"a".repeat(64)},inputFingerprint:"b".repeat(64),attribution:{caseId:"case",runId:"run",workId:"work"}});
    await c.bindings.beginExecution("legacy","lease","worker");
    db.exec("UPDATE tool_invocation_executions SET status='completed'");
    for(const version of ambiguous?["v1","v2"]:["v1"])db.prepare(`INSERT INTO tool_provider_manifests
      (provider_id,version,manifest_json,package_root,manifest_fingerprint,signer_id,signature_base64,state,state_reason,installed_at,updated_at)
      VALUES (?,?,?,'/test-only','fingerprint','signer','signature','disabled',NULL,?,?)`)
      .run("neutral.provider",version,JSON.stringify({source:"neutral",tools:[{name:"observe",version:"1"}]}),at,at);
    if(ambiguous){
      expect(()=>new ManagedExecutionCapacity(db,new ToolProviderFairScheduler(),c.bindings,()=>at)).toThrow("Ambiguous legacy");
      expect(db.prepare("SELECT count(*) AS n FROM managed_execution_occupancy").get()).toEqual({n:0});
    }else{
      const restored=new ManagedExecutionCapacity(db,new ToolProviderFairScheduler(),c.bindings,()=>at);
      expect(restored.inspect("legacy")).toMatchObject({state:"unknown",providerVersion:"v1",externallyOccupied:true});
      expect(restored.scheduler.snapshot().retained).toBe(1);
      expect(c.bindings.execution("legacy")?.status).toBe("completed");
    }
  });
  it("serializes concurrent identical cleanup commands into one release audit",async()=>{
    const f=await fixture();f.dispatch();f.capacity.finish("call",false);f.lease.release();
    const results=await Promise.all([f.capacity.release(f.request(),allow,f.verifier),f.capacity.release(f.request(),allow,f.verifier)]);
    expect(results.map(result=>result.replayed).sort()).toEqual([false,true]);
    expect(f.sqlite.prepare("SELECT count(*) AS n FROM managed_execution_cleanup_audits").get()).toEqual({n:1});
    expect(f.scheduler.snapshot().occupied).toBe(0);
  });
  it("fails before dispatch on storage refusal and retains occupancy when post-dispatch settlement fails",async()=>{
    const f=await fixture();f.sqlite.exec("CREATE TRIGGER refuse_dispatch BEFORE UPDATE ON managed_execution_occupancy WHEN NEW.state='dispatched' BEGIN SELECT RAISE(ABORT,'injected'); END");
    expect(()=>f.capacity.beforeStart("call","request")).toThrow("injected");
    expect(f.capacity.inspect("call").state).toBe("reserved");f.sqlite.exec("DROP TRIGGER refuse_dispatch");f.dispatch();
    f.sqlite.exec("CREATE TRIGGER refuse_settlement BEFORE UPDATE ON managed_execution_occupancy BEGIN SELECT RAISE(ABORT,'injected'); END");
    expect(()=>f.capacity.finish("call",false)).toThrow("injected");f.lease.release();
    expect(f.scheduler.snapshot()).toMatchObject({active:0,retained:1,occupied:1});
  });
  it.each(["denied","tampered","revoked","wrong-request","expired"])("does not release on %s cleanup evidence",async(mode)=>{
    const f=await fixture();f.dispatch();f.capacity.finish("call",false);f.lease.release();const request=f.request();
    if(mode==="tampered")request.evidence.assertion.cleanup.evidenceRef="tampered";
    if(mode==="revoked")Object.assign(f.trusted,{revoked:true});
    if(mode==="wrong-request"){request.evidence.process!.identity.requestId="other";const {signature,...payload}=request.evidence;request.evidence=signEvidence(payload);}
    if(mode==="expired"){request.evidence.assertion.expiresAt=at;const {signature,...payload}=request.evidence;request.evidence=signEvidence(payload);}
    expect((await f.capacity.release(request,mode==="denied"?deny:allow,f.verifier)).outcome).not.toBe("released");
    expect(f.scheduler.snapshot().retained).toBe(1);
    await expect(f.capacity.release({...request,reason:"different"},allow,f.verifier)).rejects.toThrow("conflict");
  });
  it("requires process provenance even for signed non-process no-effect evidence",async()=>{
    const f=await fixture();f.capacity.beforeStart("call","request");f.capacity.finish("call",false);f.lease.release();
    const request={...f.request(),evidence:signEvidence(evidence(f))};
    expect((await f.capacity.release(request,allow,f.verifier)).outcome).toBe("rejected");
    expect(f.scheduler.snapshot().retained).toBe(1);
  });
  it("consumes a committed reconciliation proof without repeating the invocation",async()=>{
    const f=await fixture();f.dispatch();f.capacity.finish("call",false);f.lease.release();await f.bindings.markUncertain("call","Host wait ended");
    const c=controls(f.sqlite,{authority:f.trusted});await c.reconciliation.reconcile({...f.request(),resolution:"confirmed_no_effect"});
    expect(f.capacity.reconcile()).toBe(1);expect(f.capacity.reconcile()).toBe(0);
    expect(f.scheduler.snapshot().occupied).toBe(0);expect(c.runtime.load("run")!.workItems).toHaveLength(1);
  });
  it("keeps release audit and occupancy atomic when commit fails",async()=>{
    const f=await fixture();f.dispatch();f.capacity.finish("call",true);f.lease.release();
    f.sqlite.exec("CREATE TRIGGER refuse_release BEFORE UPDATE ON managed_execution_occupancy WHEN NEW.state='released' BEGIN SELECT RAISE(ABORT,'injected'); END");
    await expect(f.capacity.release(f.request(),allow,f.verifier)).rejects.toThrow("injected");
    expect(f.sqlite.prepare("SELECT count(*) AS n FROM managed_execution_cleanup_audits").get()).toEqual({n:0});
    expect(f.scheduler.snapshot().retained).toBe(1);f.sqlite.exec("DROP TRIGGER refuse_release");
    expect((await f.capacity.release(f.request(),allow,f.verifier)).outcome).toBe("released");
    expect(()=>f.sqlite.exec("DELETE FROM managed_execution_occupancy")).toThrow("permanent");
    expect(()=>f.sqlite.exec("UPDATE managed_execution_cleanup_audits SET fingerprint='changed'")).toThrow("immutable");
  });
  it("exposes scoped read-only occupancy and audit facts while denying unconfigured release",async()=>{
    const f=await fixture();f.dispatch();f.capacity.finish("call",false);f.lease.release();const app=Fastify();
    registerManagedExecutionCapacityRoutes(app,f.capacity,deny,f.verifier);
    try{
      const stream=new SqliteScenarioAgentEventStream(f.sqlite),audit=new AgentAuditProjection(f.sqlite,stream);audit.reconcile();
      expect(audit.read("case","run","executionOccupancy","call").state.status).toBe("unknown");
      expect(()=>audit.read("other","run","executionOccupancy","call")).toThrow("another Case/Run");
      expect((await app.inject({method:"POST",url:"/api/security-tools/execution-cleanup",payload:f.request()})).statusCode).toBe(403);
      f.sqlite.pragma("query_only=ON");
      expect((await app.inject("/api/security-tools/execution-occupancy?idempotencyKey=call&caseId=case&runId=run")).json().externallyOccupied).toBe(true);
      expect((await app.inject("/api/security-tools/execution-occupancy?idempotencyKey=call&caseId=other&runId=run")).statusCode).toBe(409);
    }finally{await app.close();}
  });
});
