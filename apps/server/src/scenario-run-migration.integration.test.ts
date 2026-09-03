import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { ScenarioPackageRegistry } from "@traceforge/scenario-sdk";
import { canonicalJson, DurableScenarioRuntime, ScenarioDefinitionRegistry, evolve } from "@traceforge/orchestration-core";
import { SqliteScenarioEventStore } from "./scenario-event-store.js";
import { database, at } from "./test-fixtures/execution-recovery.js";
import { migrationFixture, migrationPackages } from "./test-fixtures/run-migration.js";
import { foundationHost } from "./test-fixtures/foundation-host.js";
import { AgentAuditProjection } from "./agent-audit-projection.js";
import { SqliteScenarioAgentEventStream } from "./scenario-agent-event-stream.js";
import { contextContentDigest } from "./package-context-resources.js";

const dbs:Database.Database[]=[],roots:string[]=[];
afterEach(()=>{for(const db of dbs.splice(0))if(db.open)db.close();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(options:Parameters<typeof migrationFixture>[1]={},configure?:Parameters<typeof migrationFixture>[2]){
  const sqlite=database();dbs.push(sqlite);return migrationFixture(sqlite,options,configure);
}
async function blocked(f:ReturnType<typeof fixture>,pattern:RegExp){const result=await f.control.preview(f.input);expect(result.eligible).toBe(false);expect(result.blockers.join(" ")).toMatch(pattern);}

describe("Preserved-state Run Package migration",()=>{
  it("previews without writes and atomically preserves all investigation state",async()=>{
    const f=fixture(),before=f.runtime.load("run")!,revision=f.sqlite.prepare("SELECT revision FROM scenario_event_streams").get();
    const request=await f.request();expect(f.sqlite.prepare("SELECT revision FROM scenario_event_streams").get()).toEqual(revision);
    const result=await f.control.migrate(request),after=f.runtime.load("run")!;
    expect(after).toEqual({...before,scenarioPackage:f.to,definitionVersion:2,revision:5,updatedAt:result.audit.at});
    expect(result.audit.automaticResume).toBe(false);
    expect(f.sqlite.prepare("SELECT scenario_package_version,definition_version,status FROM scenario_event_streams").get()).toEqual({scenario_package_version:"2.0.0",definition_version:2,status:"paused"});
    expect(f.sqlite.prepare("SELECT count(*) n FROM tool_invocation_bindings").get()).toEqual({n:0});
  });
  it("reauthorizes identical requests without appending another event",async()=>{
    let calls=0;const f=fixture({authorizer:{async authorize(){calls++;return {decision:"allowed",authorizationRef:"checked",expiresAt:"2099-01-01T00:00:00.000Z"};}}});
    const request=await f.request(),first=await f.control.migrate(request),second=await f.control.migrate(request);
    expect(second).toEqual({...first,replayed:true});expect(calls).toBe(2);expect(f.runtime.load("run")!.revision).toBe(5);
    await expect(f.control.migrate({...request,reason:"different"})).rejects.toThrow("conflicts");
  });
  it("serializes concurrent identical submissions into one migration",async()=>{
    const f=fixture(),request=await f.request(),results=await Promise.all([f.control.migrate(request),f.control.migrate(request)]);
    expect(results.filter(r=>!r.replayed)).toHaveLength(1);expect(f.runtime.load("run")!.revision).toBe(5);
  });
  it.each([undefined,{async authorize(){return {decision:"denied" as const};}},{async authorize(){return {decision:"allowed" as const,authorizationRef:"expired",expiresAt:"2000-01-01T00:00:00.000Z"};}}])("requires current independent migration authorization",async authorizer=>{
    const f=fixture({authorizer}),request=await f.request();await expect(f.control.migrate(request)).rejects.toThrow("authorization");expect(f.runtime.load("run")!.scenarioPackage).toEqual(f.from);
  });
  it("requires an explicit current Package trust verifier",async()=>{await blocked(fixture({assertTrusted:undefined}),/trust verifier/);});
  it("rejects accidentally asynchronous trust verification",async()=>{await blocked(fixture({async assertTrusted(){throw new Error("revoked");}}),/synchronous/);});
  it("does not turn installing the new Package into a Run upgrade",async()=>{
    const f=fixture();expect(f.packages.requireForScenario("neutral").version).toBe("2.0.0");expect(f.runtime.load("run")!.scenarioPackage).toEqual(f.from);
  });
  it("refuses a running Run",async()=>{const f=fixture();f.command({type:"resume_run",reason:"Run",requestedBy:"operator",at});f.input.expectedRevision=5;await blocked(f,/paused/);});
  it("refuses active leases and does not release them",async()=>{
    const f=fixture();f.sqlite.prepare("INSERT INTO scenario_work_leases VALUES ('run','work','worker','lease','2099-01-01T00:00:00.000Z',?)").run(at);
    await blocked(f,/Active lease/);expect(f.sqlite.prepare("SELECT lease_id FROM scenario_work_leases").get()).toEqual({lease_id:"lease"});
  });
  it("does not settle a pending approval to permit migration",async()=>{
    const f=fixture();f.sqlite.prepare("INSERT INTO scenario_work_approvals VALUES ('pending','run','case','work','action','observe','read_only','Review','input','pending','worker',NULL,?,NULL)").run(at);
    await blocked(f,/Pending approval/);expect(f.sqlite.prepare("SELECT status FROM scenario_work_approvals").get()).toEqual({status:"pending"});
  });
  it.each(["lease","scope","revision"])("rechecks %s changes while authorization is pending",async kind=>{
    const f=fixture({authorizer:{async authorize(){
      if(kind==="lease")f.sqlite.prepare("INSERT INTO scenario_work_leases VALUES ('run','work','worker','late','2099-01-01T00:00:00.000Z',?)").run(at);
      if(kind==="scope")f.sqlite.exec("UPDATE scenario_authorizations SET status='revoked'");
      if(kind==="revision")f.command({type:"resume_run",reason:"Changed",requestedBy:"operator",at});
      return {decision:"allowed",authorizationRef:"checked",expiresAt:"2099-01-01T00:00:00.000Z"};
    }}});await expect(f.control.migrate(await f.request())).rejects.toThrow(/lease|scope|revision/);expect(f.runtime.load("run")!.scenarioPackage).toEqual(f.from);
  });
  it("restores with only the target installed and requires explicit resume before old Work can be claimed",async()=>{
    const f=fixture();await f.control.migrate(await f.request());
    const packages=new ScenarioPackageRegistry([f.target]),runtime=new DurableScenarioRuntime(new SqliteScenarioEventStore(f.sqlite),new ScenarioDefinitionRegistry(packages.definitions()),packages);
    expect(runtime.load("run")!.status).toBe("paused");
    const claim={type:"claim_work" as const,workId:"work",workerId:"worker",workerRoles:["observer"],workerCapabilities:["observe"],workerCurrentWork:0,workerMaxConcurrentWork:1,leaseId:"new-version",leaseExpiresAt:"2099-01-01T00:00:00.000Z",at};
    expect(()=>runtime.execute({runId:"run",commandId:"claim-new",expectedRevision:5,command:claim})).toThrow();
    runtime.execute({runId:"run",commandId:"resume-new",expectedRevision:5,command:{type:"resume_run",requestedBy:"operator",reason:"Continue",at}});
    const claimed=runtime.execute({runId:"run",commandId:"claim-new",expectedRevision:6,command:claim}).state;
    expect(claimed.scenarioPackage).toEqual(f.to);expect(claimed.workItems[0]!.idempotencyKey).toBe("effect");expect(claimed.workItems[0]!.leaseId).toBe("new-version");
  });
  it("preserves historical outputs, evidence references, resolved approvals and source events",async()=>{
    const f=fixture();f.command({type:"resume_run",reason:"Prepare history",requestedBy:"operator",at});
    f.command({type:"claim_work",workId:"work",workerId:"worker",workerRoles:["observer"],workerCapabilities:["observe"],workerCurrentWork:0,workerMaxConcurrentWork:1,leaseId:"history",leaseExpiresAt:"2099-01-01T00:00:00.000Z",at});
    const checkpoint={version:2 as const,caseId:"case",runId:"run",workId:"work",workKey:"effect",workerId:"worker",leaseId:"history",savedAt:at,
      turn:1,consecutiveFailures:0,pendingInvocation:null,completedInvocationIds:[],steering:[],transcript:[]};
    const ref=await f.checkpoints.save(checkpoint);f.command({type:"checkpoint_work",workId:"work",leaseId:"history",checkpointId:"history",progressSummary:"Saved",payloadRef:ref,at});
    f.command({type:"request_work_approval",workId:"work",leaseId:"history",approvalId:"approval",actionKey:"observe",toolName:"observe",risk:"read_only",rationale:"Review",inputRef:ref,at});
    f.command({type:"resolve_work_approval",workId:"work",approvalId:"approval",approved:true,reason:"Reviewed",at});
    f.command({type:"claim_work",workId:"work",workerId:"worker",workerRoles:["observer"],workerCapabilities:["observe"],workerCurrentWork:0,workerMaxConcurrentWork:1,leaseId:"after-approval",leaseExpiresAt:"2099-01-01T00:00:00.000Z",at});
    f.command({type:"complete_work",workId:"work",leaseId:"after-approval",summary:"Saved",outputs:[{id:"output",kind:"decision",schemaVersion:1,summary:"Observed",refs:["evidence:first"],createdAt:at}],at});
    f.command({type:"pause_run",reason:"Upgrade",requestedBy:"operator",at});f.input.expectedRevision=f.runtime.load("run")!.revision;
    const before=f.runtime.load("run")!,events=f.sqlite.prepare("SELECT * FROM scenario_events ORDER BY sequence").all(),approvals=f.sqlite.prepare("SELECT * FROM scenario_work_approvals").all();
    await f.control.migrate(await f.request());const after=f.runtime.load("run")!;
    expect(after.outputs).toEqual(before.outputs);expect(after.workItems).toEqual(before.workItems);
    expect(after.outputs[0]!.refs).toEqual(["evidence:first"]);expect(after.workItems[0]!.approvalHistory[0]!.status).toBe("approved");
    expect(f.sqlite.prepare("SELECT * FROM scenario_work_approvals").all()).toEqual(approvals);
    expect(f.sqlite.prepare("SELECT * FROM scenario_events ORDER BY sequence").all().slice(0,-1)).toEqual(events);
  });
  it("rejects malformed migration event replay",async()=>{
    const f=fixture(),before=f.runtime.load("run")!;await f.control.migrate(await f.request());
    const event=new SqliteScenarioEventStore(f.sqlite).load("run").events.at(-1)!;
    if(event.type!=="run_package_migrated")throw new Error("Expected migration");
    expect(()=>evolve(before,{...event,to:{...event.to,schemaRevision:1}})).toThrow("Invalid");
    expect(()=>evolve(before,{...event,authorizationRef:""})).toThrow("Invalid");
    expect(()=>evolve(before,{...event,from:{...event.from,version:"wrong"}})).toThrow("previous");
  });
  it.each(["prepared","executing","uncertain"] as const)("rejects an open %s Invocation",async status=>{
    const f=fixture();await f.bindings.prepare({idempotencyKey:"effect:first",invocationId:"first",tool:{name:"observe",source:"neutral",version:"1",contractFingerprint:"a".repeat(64)},inputFingerprint:"b".repeat(64),attribution:{caseId:"case",runId:"run",workId:"work"}});
    if(status!=="prepared")f.sqlite.prepare("UPDATE tool_invocation_executions SET status=? WHERE idempotency_key='effect:first'").run(status);
    await blocked(f,/Open invocation/);
  });
  it.each(["process","managed"])("does not forget unknown %s occupancy",async kind=>{
    const f=fixture();
    if(kind==="process"){
      const lease=await f.capacity.acquire({source:"fixture",version:"1",operation:"observe",kind:"service",attribution:{caseId:"case",runId:"run",workId:"work",workerId:"service",scopeRef:"scope",leaseId:"service",leaseExpiresAt:"2099-01-01T00:00:00.000Z",actionId:"observe",idempotencyKey:"process"}});
      lease.beforeStart("request");lease.finish(false);
    }else f.sqlite.prepare("INSERT INTO managed_execution_occupancy VALUES ('legacy',?,'host','unknown','request',NULL,?,?)").run(canonicalJson({scheduling:{runId:"run"}}),at,at);
    await blocked(f,/Unconfirmed execution occupancy/);
  });
  it.each(["revoked","expired"])("rejects %s scope authorization",async kind=>{
    const f=fixture();f.sqlite.exec(kind==="revoked"?"UPDATE scenario_authorizations SET status='revoked'":"UPDATE scenario_authorizations SET expires_at='2000-01-01T00:00:00.000Z'");await blocked(f,/scope/);
  });
  it.each(["definition","output","policy","factory"])("rejects incompatible %s changes",async kind=>{
    const f=fixture({},p=>{
      if(kind==="definition")p.target.definition.title="Changed contract";
      if(kind==="output")p.target.outputSchemas=[{kind:"decision",version:2,validate(){}}];
      if(kind==="policy")p.target.authorizationPolicy={parseScope:payload=>({payload,allowedActions:["observe"],deniedActions:[]})};
      if(kind==="factory")p.target.createToolSources=()=>[];
    });await blocked(f,/structural|output schemas|policy|tool factory/);
  });
  it("compares complete declarative contracts rather than only their identity",async()=>{
    const f=fixture({},p=>{
      const policy={format:"traceforge.scenario-scope-policy.v1" as const,allowedActions:["observe"],deniedActions:[],
        payload:{maximumBytes:1024,maximumDepth:4},resources:[]};
      p.source.authorizationPolicy=policy;p.target.authorizationPolicy=structuredClone(policy);
      p.source.outputSchemas=[{kind:"decision",version:1,format:"traceforge.scenario-output-contract.v1",maximumSummaryBytes:1024,maximumRefs:4}];
      p.target.outputSchemas=[{kind:"decision",version:1,format:"traceforge.scenario-output-contract.v1",maximumSummaryBytes:1024,maximumRefs:5}];
    });
    await blocked(f,/output schemas/);
  });
  it("rejects a missing migration declaration body",async()=>{await blocked(fixture({resources:[]}),/missing or corrupt/);});
  it("rejects a revoked migration resource",async()=>{const f=fixture();f.contexts.revoke(f.target.resourceManifest!.resources[0]!.digest,"Revoked");await blocked(f,/revoked/);});
  it("rejects an absent direct manifest step",async()=>{const f=fixture({},p=>{p.target.migrationManifest={revision:1,steps:[]};});await blocked(f,/direct manifest step/);});
  it("rejects a declaration for another exact source version",async()=>{
    const f=fixture({},p=>{p.content=canonicalJson({format:"traceforge.run-migration.v1",mode:"preserve_state",from:{...p.from,version:"other"},to:p.to});
      p.target.resourceManifest!.resources[0]!.digest=contextContentDigest(p.content);p.resources[0]!.content=p.content;});await blocked(f,/exact version pair/);
  });
  it("rejects package substitution in the target binding",async()=>{const f=fixture();f.input.target={...f.to,id:"other"};await blocked(f,/not installed/);});
  it("keeps a denied stale preview from changing state",async()=>{
    const f=fixture(),request=await f.request();await expect(f.control.migrate({...request,planFingerprint:"a".repeat(64)})).rejects.toThrow("stale");expect(f.runtime.load("run")!.revision).toBe(4);
  });
  it("rechecks revocation during asynchronous authorization",async()=>{
    const f=fixture({authorizer:{async authorize(){f.contexts.revoke(f.target.resourceManifest!.resources[0]!.digest,"Revoked while waiting");return {decision:"allowed",authorizationRef:"checked",expiresAt:"2099-01-01T00:00:00.000Z"};}}});
    await expect(f.control.migrate(await f.request())).rejects.toThrow("revoked");expect(f.runtime.load("run")!.revision).toBe(4);
  });
  it("fixes the caller request before waiting for authorization",async()=>{
    let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});
    const f=fixture({authorizer:{async authorize(){entered();await gate;return {decision:"allowed",authorizationRef:"checked",expiresAt:"2099-01-01T00:00:00.000Z"};}}});
    const request=await f.request(),pending=f.control.migrate(request);await started;request.target.version="forged";request.reason="forged";release();
    expect((await pending).audit.plan.to.version).toBe("2.0.0");expect(f.runtime.load("run")!.scenarioPackage!.version).toBe("2.0.0");
  });
  it.each(["event","projection","audit"])("rolls back all migration facts on %s failure",async phase=>{
    const f=fixture(),request=await f.request();
    f.sqlite.exec(phase==="event"?"CREATE TEMP TRIGGER fail_migration BEFORE INSERT ON scenario_events BEGIN SELECT RAISE(ABORT,'injected'); END":
      phase==="projection"?"CREATE TEMP TRIGGER fail_migration BEFORE UPDATE OF scenario_package_version ON scenario_event_streams BEGIN SELECT RAISE(ABORT,'injected'); END":
      "CREATE TEMP TRIGGER fail_migration BEFORE INSERT ON scenario_run_migrations BEGIN SELECT RAISE(ABORT,'injected'); END");
    await expect(f.control.migrate(request)).rejects.toThrow("injected");expect(f.runtime.load("run")!.scenarioPackage).toEqual(f.from);
    expect(f.sqlite.prepare("SELECT count(*) n FROM scenario_run_migrations").get()).toEqual({n:0});
    f.sqlite.exec("DROP TRIGGER fail_migration");expect((await f.control.migrate(request)).replayed).toBe(false);
  });
  it("preserves v2 checkpoint content, budgets and pending-free history",async()=>{
    const f=fixture();f.command({type:"resume_run",reason:"prepare",requestedBy:"operator",at});
    f.command({type:"claim_work",workId:"work",workerId:"worker",workerRoles:["observer"],workerCapabilities:["observe"],workerCurrentWork:0,workerMaxConcurrentWork:1,leaseId:"second",leaseExpiresAt:"2099-01-01T00:00:00.000Z",at});
    const checkpoint={version:2 as const,caseId:"case",runId:"run",workId:"work",workKey:"effect",workerId:"worker",leaseId:"second",savedAt:at,
      turn:7,consecutiveFailures:2,pendingInvocation:null,completedInvocationIds:[],steering:[],transcript:[]};
    const ref=await f.checkpoints.save(checkpoint);f.command({type:"checkpoint_work",workId:"work",leaseId:"second",checkpointId:"checkpoint",progressSummary:"Saved",payloadRef:ref,at});
    f.command({type:"pause_run",reason:"Migrate",requestedBy:"operator",at});f.input.expectedRevision=f.runtime.load("run")!.revision;
    await f.control.migrate(await f.request());expect(await f.checkpoints.load(ref)).toEqual(checkpoint);
    expect(f.runtime.load("run")!.workItems[0]!.latestCheckpoint!.payloadRef).toBe(ref);
  });
  it("rejects a missing checkpoint instead of discarding it",async()=>{
    const f=fixture();f.sqlite.prepare("UPDATE scenario_events SET payload_json=json_set(payload_json,'$.work.latestCheckpoint',json(?)) WHERE event_type='work_proposed'")
      .run(JSON.stringify({id:"missing",workId:"work",leaseId:"lease",progressSummary:"Missing",payloadRef:"checkpoint://missing.json",createdAt:at}));
    await blocked(f,/checkpoint reference/);
  });
  it("projects migration events into the common audit stream",async()=>{
    const f=fixture(),result=await f.control.migrate(await f.request()),stream=new SqliteScenarioAgentEventStream(f.sqlite);
    new AgentAuditProjection(f.sqlite,stream).controls();
    const rows=f.sqlite.prepare("SELECT event_json FROM scenario_agent_protocol_events WHERE event_json LIKE '%run_package_migrated%'").all();
    expect(JSON.stringify(rows)).toContain(result.audit.migrationRef);
  });
  it("rejects cross-Run audit queries and replay after trust revocation",async()=>{
    let trusted=true;const f=fixture({assertTrusted(){if(!trusted)throw new Error("Trust revoked");}}),request=await f.request();await f.control.migrate(request);
    expect(()=>f.control.inspect({caseId:"other",runId:"run",commandId:"upgrade"})).toThrow("not found");trusted=false;
    await expect(f.control.migrate(request)).rejects.toThrow("Trust revoked");expect(f.runtime.load("run")!.revision).toBe(5);
  });
  it.each(["projection","audit","committed"])("recovers two fresh hosts after SIGKILL at %s",async phase=>{
    const root=mkdtempSync(join(tmpdir(),"traceforge-migration-"));roots.push(root);const path=join(root,"state.db");
    await new Promise<void>((resolve,reject)=>{
      const child=spawn(process.execPath,["--import","tsx",fileURLToPath(new URL("../test-fixtures/run-migration-crash-host.mjs",import.meta.url)),path,phase],{stdio:["ignore","ignore","pipe"]});
      let errors="";child.stderr.on("data",chunk=>{errors+=chunk.toString();});const timer=setTimeout(()=>{child.kill("SIGKILL");reject(new Error("Crash fixture deadline"));},15000);
      child.on("error",reject);child.on("exit",(_code,signal)=>{clearTimeout(timer);if(signal==="SIGKILL")resolve();else reject(new Error(errors));});
    });
    for(let pass=0;pass<2;pass++){
      const sqlite=database(path);dbs.push(sqlite);const f=migrationFixture(sqlite);
      expect(f.runtime.load("run")!.scenarioPackage).toEqual(phase==="committed"?f.to:f.from);
      expect((sqlite.prepare("SELECT count(*) n FROM scenario_run_migrations").get() as {n:number}).n).toBe(phase==="committed"?1:0);
      sqlite.close();
    }
  });
  it("uses protected production routes while staying paused and issuing no model calls",async()=>{
    const p=migrationPackages(),host=await foundationHost({empty:true,ready:()=>false,foundation:{scenarioPackageRegistry:new ScenarioPackageRegistry([p.source,p.target]),
      scenarioRunMigration:{resources:p.resources,assertTrusted(){},authorizer:{async authorize(){return {decision:"allowed",authorizationRef:"fixture",expiresAt:"2099-01-01T00:00:00.000Z"};}}}}});
    try{
      await host.request("/api/scenarios/authorizations",{id:"scope",caseId:"case",scenarioKind:"neutral",scope:{},approvedBy:"fixture",expiresAt:"2099-01-01T00:00:00.000Z"});
      await host.request("/api/scenarios/runs",{commandId:"start",runId:"run",caseId:"case",goal:"Observe",scopeRef:"scope",scenarioKind:"neutral",definitionVersion:1});
      await host.request("/api/scenarios/runs/run/pause",{commandId:"pause",expectedRevision:1,reason:"Upgrade"});
      const preview=await host.request("/api/scenarios/runs/run/package-migration/preview",{caseId:"case",expectedRevision:2,target:p.to});expect(preview.eligible).toBe(true);
      const request={caseId:"case",expectedRevision:2,target:p.to,commandId:"upgrade",actor:"operator",reason:"Upgrade",planFingerprint:preview.planFingerprint};
      expect((await host.app.inject({method:"POST",url:"/api/scenarios/runs/run/package-migration",payload:request})).statusCode).toBe(401);
      await host.request("/api/scenarios/runs/run/package-migration",request);expect((await host.state()).scenarioPackage).toEqual(p.to);
      expect((await host.state()).status).toBe("paused");expect(host.requests).toHaveLength(0);
    }finally{await host.close();}
  });
});
