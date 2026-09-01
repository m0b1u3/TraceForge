import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { ScenarioPackageRegistry } from "@traceforge/scenario-sdk";
import { database, at } from "./test-fixtures/execution-recovery.js";
import { migrationFixture, migrationPackages } from "./test-fixtures/run-migration.js";
import { foundationHost, eventually } from "./test-fixtures/foundation-host.js";
import { registerPhysicalStorageFunctions } from "./db/physical-storage.js";
import { SqliteScenarioAuthorizationService } from "./scenario-authorization.js";
import { ScenarioAuthorizationUpgradeControl, type AuthorizationUpgradeOptions } from "./scenario-authorization-upgrade.js";

const dbs:Database.Database[]=[],roots:string[]=[];
afterEach(()=>{for(const db of dbs.splice(0))if(db.open)db.close();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const allow:AuthorizationUpgradeOptions={assertTrusted(){},authorizer:{async authorize(){return {decision:"allowed",authorizationRef:"reviewed",expiresAt:"2099-01-01T00:00:00.000Z"};}}};
function fixture(options:AuthorizationUpgradeOptions={}){
  const sqlite=database();dbs.push(sqlite);const f=migrationFixture(sqlite),authorization=new SqliteScenarioAuthorizationService(sqlite,f.packages);
  const upgrades=new ScenarioAuthorizationUpgradeControl(sqlite,f.packages,{...allow,...options});
  const input={caseId:"case",scopeRef:"scope",expectedRevision:1,target:f.to};
  const request=()=>{const preview=upgrades.preview(input);if(!preview.eligible)throw new Error(preview.blockers.join(","));return {...input,commandId:"upgrade-policy",actor:"operator",reason:"Reviewed compatible policy",planFingerprint:preview.planFingerprint!};};
  return {...f,authorization,upgrades,upgradeInput:input,upgradeRequest:request};
}

describe("Pinned scope policies and authorized upgrades",()=>{
  it("does not apply a newer permissive policy to an existing authorization",()=>{
    const f=fixture(),newest={...f.target,version:"3.0.0",schemaRevision:3,definition:{...f.target.definition,version:3,authorizationActions:["observe","extra"]},authorizationPolicy:{parseScope:(payload:unknown)=>({payload,allowedActions:["observe","extra"],deniedActions:[]}),authorizeResource:()=>"outside"}};
    const service=new SqliteScenarioAuthorizationService(f.sqlite,new ScenarioPackageRegistry([f.source,f.target,newest]));
    expect(service.requireAction("scope","case","observe").id).toBe("scope");
    expect(()=>service.requireAction("scope","case","extra")).toThrow("not authorized");
    expect(()=>service.authorizeResource("scope","case","observe","subject","outside")).toThrow("does not authorize");
    expect(service.diagnostic("scope","case").package).toEqual(f.from);
  });
  it("does not reinterpret old scope with a newer restrictive policy",()=>{
    const f=fixture(),target={...f.target,authorizationPolicy:{parseScope:(payload:unknown)=>({payload,allowedActions:[],deniedActions:["observe"]})}};
    const service=new SqliteScenarioAuthorizationService(f.sqlite,new ScenarioPackageRegistry([f.source,target]));
    expect(service.requireAction("scope","case","observe").id).toBe("scope");
    expect(()=>service.requireScope("scope","case",target)).toThrow("incompatible");
  });
  it("fails closed when the pinned Package disappears",()=>{
    const f=fixture(),service=new SqliteScenarioAuthorizationService(f.sqlite,new ScenarioPackageRegistry([f.target]));
    expect(()=>service.requireAction("scope","case","observe")).toThrow("not installed");
    expect(service.diagnostic("scope","case").status).toBe("recovery_required");
  });
  it("does not infer the version of a legacy unbound authorization even with one installed package",async()=>{
    const f=fixture();f.sqlite.prepare("INSERT INTO scenario_authorizations SELECT 'legacy',case_id,scenario_kind,scope_json,approved_by,status,expires_at,created_at,updated_at FROM scenario_authorizations WHERE id='scope'").run();
    const service=new SqliteScenarioAuthorizationService(f.sqlite,new ScenarioPackageRegistry([f.source]));
    expect(()=>service.requireAction("legacy","case","observe")).toThrow("unbound");
    expect(service.binding("legacy")).toBeUndefined();
    const input={...f.upgradeInput,scopeRef:"legacy",expectedRevision:0,target:f.from},preview=f.upgrades.preview(input);
    expect(preview.plan!.mode).toBe("explicit_legacy_binding");expect(service.binding("legacy")).toBeUndefined();
    const result=await f.upgrades.upgrade({...input,commandId:"legacy-adoption",actor:"operator",reason:"Review original scope",planFingerprint:preview.planFingerprint});
    expect(result.audit.result.revision).toBe(1);expect(service.requireAction("legacy","case","observe").id).toBe("legacy");
  });
  it("previews without writes and preserves scope payload, expiry and all Run facts",async()=>{
    const f=fixture(),before=f.runtime.load("run"),scope=f.sqlite.prepare("SELECT * FROM scenario_authorizations").get(),request=f.upgradeRequest();
    expect(f.authorization.binding("scope")!.revision).toBe(1);
    const result=await f.upgrades.upgrade(request);
    expect(result.audit.automaticResume).toBe(false);expect(f.runtime.load("run")).toEqual(before);
    expect(f.sqlite.prepare("SELECT * FROM scenario_authorizations").get()).toEqual(scope);
    expect(f.authorization.diagnostic("scope","case").package).toEqual(f.to);
  });
  it("composes Run and policy upgrades, then authorizes after removing the old Package",async()=>{
    const f=fixture();await f.control.migrate(await f.request());await f.upgrades.upgrade(f.upgradeRequest());
    const service=new SqliteScenarioAuthorizationService(f.sqlite,new ScenarioPackageRegistry([f.target]));
    expect(service.requireRun(f.runtime.load("run")!).binding.revision).toBe(2);
    expect(f.runtime.load("run")!.status).toBe("paused");expect(f.runtime.load("run")!.workItems[0]!.idempotencyKey).toBe("effect");
  });
  it("reauthorizes a duplicate without duplicating binding revisions or history",async()=>{
    let calls=0;const f=fixture({authorizer:{async authorize(input){calls++;return allow.authorizer!.authorize(input);}}}),request=f.upgradeRequest();
    const results=await Promise.all([f.upgrades.upgrade(request),f.upgrades.upgrade(request)]);
    expect(results.filter(r=>!r.replayed)).toHaveLength(1);expect(calls).toBe(2);
    expect(f.authorization.binding("scope")!.revision).toBe(2);expect(f.sqlite.prepare("SELECT count(*) n FROM scenario_authorization_upgrades").get()).toEqual({n:1});
    await expect(f.upgrades.upgrade({...request,reason:"Different"})).rejects.toThrow("conflicts");
  });
  it.each([undefined,{async authorize(){return {decision:"denied" as const};}},{async authorize(){return {decision:"allowed" as const,authorizationRef:"expired",expiresAt:at};}}])("requires independent current authorization",async authorizer=>{
    const f=fixture({authorizer});await expect(f.upgrades.upgrade(f.upgradeRequest())).rejects.toThrow("denied or expired");expect(f.authorization.binding("scope")!.revision).toBe(1);
  });
  it.each([undefined,async()=>{throw new Error("Async trust");}])("requires explicit synchronous trust",assertTrusted=>{
    const f=fixture({assertTrusted});expect(f.upgrades.preview(f.upgradeInput).eligible).toBe(false);
  });
  it.each(["revoked","expired","changed-body"])("refuses a %s scope",kind=>{
    const f=fixture();f.sqlite.exec("UPDATE scenario_authorizations SET "+(kind==="revoked"?"status='revoked'":kind==="expired"?"expires_at='2000-01-01'":"scope_json='{\"changed\":true}'"));
    expect(f.upgrades.preview(f.upgradeInput).eligible).toBe(false);
    expect(()=>f.authorization.requireAction("scope","case","observe")).toThrow();
  });
  it("rejects a stale preview",async()=>{const f=fixture();await expect(f.upgrades.upgrade({...f.upgradeRequest(),planFingerprint:"a".repeat(64)})).rejects.toThrow("stale");});
  it("requires all affected Runs to be paused",()=>{const f=fixture();f.command({type:"resume_run",reason:"Work",requestedBy:"operator",at});expect(f.upgrades.preview(f.upgradeInput).blockers.join()).toMatch(/paused/);});
  it.each(["lease","invocation","approval"])("does not erase an open %s",async kind=>{
    const f=fixture();
    if(kind==="lease")f.sqlite.prepare("INSERT INTO scenario_work_leases VALUES ('run','work','worker','late','2099-01-01',?)").run(at);
    if(kind==="approval")f.sqlite.prepare("INSERT INTO scenario_work_approvals VALUES ('pending','run','case','work','observe','observe','read_only','Review','ref','pending','worker',NULL,?,NULL)").run(at);
    if(kind==="invocation")await f.bindings.prepare({idempotencyKey:"effect:first",invocationId:"first",tool:{name:"observe",source:"fixture",version:"1",contractFingerprint:"a".repeat(64)},inputFingerprint:"b".repeat(64),attribution:{caseId:"case",runId:"run",workId:"work"}});
    expect(f.upgrades.preview(f.upgradeInput).eligible).toBe(false);expect(f.authorization.binding("scope")!.revision).toBe(1);
  });
  it("refuses incompatible policy replacement even with approval configured",()=>{
    const f=fixture(),target={...f.target,authorizationPolicy:{parseScope:(payload:unknown)=>({payload,allowedActions:["observe"],deniedActions:[]})}};
    const control=new ScenarioAuthorizationUpgradeControl(f.sqlite,new ScenarioPackageRegistry([f.source,target]),allow);
    expect(control.preview(f.upgradeInput).blockers.join()).toMatch(/compatible/);
  });
  it.each(["scope","run","trust"])("rechecks %s during asynchronous approval",async kind=>{
    let trusted=true;const f=fixture({assertTrusted(){if(!trusted)throw new Error("Trust revoked");},authorizer:{async authorize(input){
      if(kind==="scope")f.sqlite.exec("UPDATE scenario_authorizations SET status='revoked'");
      if(kind==="run")f.command({type:"resume_run",reason:"Changed",requestedBy:"operator",at});if(kind==="trust")trusted=false;
      return allow.authorizer!.authorize(input);
    }}});await expect(f.upgrades.upgrade(f.upgradeRequest())).rejects.toThrow();expect(f.authorization.binding("scope")!.revision).toBe(1);
  });
  it("fixes the request before waiting on external authorization",async()=>{
    let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>{release=r;}),started=new Promise<void>(r=>{entered=r;});
    const f=fixture({authorizer:{async authorize(input){entered();await gate;return allow.authorizer!.authorize(input);}}}),request=f.upgradeRequest(),pending=f.upgrades.upgrade(request);
    await started;request.target={...request.target,version:"forged"};request.reason="forged";release();
    expect((await pending).audit.reason).toBe("Reviewed compatible policy");expect(f.authorization.diagnostic("scope","case").package).toEqual(f.to);
  });
  it.each(["binding","audit"])("rolls back both facts after %s failure",async phase=>{
    const f=fixture(),request=f.upgradeRequest();f.sqlite.exec(phase==="binding"?"CREATE TEMP TRIGGER fail BEFORE UPDATE ON scenario_authorization_bindings BEGIN SELECT RAISE(ABORT,'injected'); END":"CREATE TEMP TRIGGER fail BEFORE INSERT ON scenario_authorization_upgrades BEGIN SELECT RAISE(ABORT,'injected'); END");
    await expect(f.upgrades.upgrade(request)).rejects.toThrow("injected");expect(f.authorization.binding("scope")!.revision).toBe(1);expect(f.sqlite.prepare("SELECT count(*) n FROM scenario_authorization_upgrades").get()).toEqual({n:0});
    f.sqlite.exec("DROP TRIGGER fail");expect((await f.upgrades.upgrade(request)).replayed).toBe(false);
  });
  it("retains immutable audit and scopes audit reads to Case and authorization",async()=>{
    const f=fixture();await f.upgrades.upgrade(f.upgradeRequest());
    expect(()=>f.sqlite.exec("DELETE FROM scenario_authorization_upgrades")).toThrow("immutable");
    expect(()=>f.sqlite.exec("DELETE FROM scenario_authorization_bindings")).toThrow("cannot be deleted");
    expect(()=>f.upgrades.inspect("scope","other","upgrade-policy")).toThrow("not found");
    expect(f.upgrades.inspect("scope","case","upgrade-policy").plan.from!.revision).toBe(1);
  });
  it.each(["binding","audit","committed"])("recovers two fresh hosts after SIGKILL at %s",async phase=>{
    const root=mkdtempSync(join(tmpdir(),"traceforge-policy-upgrade-"));roots.push(root);const path=join(root,"state.db");
    await new Promise<void>((resolve,reject)=>{
      const child=spawn(process.execPath,["--import","tsx",fileURLToPath(new URL("../test-fixtures/authorization-upgrade-crash-host.mjs",import.meta.url)),path,phase],{stdio:["ignore","ignore","pipe"]});let errors="";
      child.stderr.on("data",chunk=>{errors+=chunk.toString();});const timer=setTimeout(()=>{child.kill("SIGKILL");reject(new Error("Crash fixture deadline"));},15000);
      child.on("error",reject);child.on("exit",(_code,signal)=>{clearTimeout(timer);if(signal==="SIGKILL")resolve();else reject(new Error(errors));});
    });
    for(let pass=0;pass<2;pass++){
      const sqlite=database(path);dbs.push(sqlite);const f=migrationFixture(sqlite),service=new SqliteScenarioAuthorizationService(sqlite,f.packages);
      expect(service.binding("scope")!.revision).toBe(phase==="committed"?2:1);expect(service.requireAction("scope","case","observe").id).toBe("scope");
      expect(sqlite.prepare("SELECT count(*) n FROM scenario_authorization_upgrades").get()).toEqual({n:phase==="committed"?1:0});sqlite.close();
    }
  });
  it("uses protected production routes and keeps Run restoration explicit",async()=>{
    const p=migrationPackages(),host=await foundationHost({empty:true,ready:()=>false,foundation:{scenarioPackageRegistry:new ScenarioPackageRegistry([p.source,p.target]),authorizationUpgrade:allow}});
    try{
      const created=await host.request("/api/scenarios/authorizations",{id:"scope",caseId:"case",scenarioKind:"neutral",definitionVersion:1,scope:{},approvedBy:"operator",expiresAt:"2099-01-01T00:00:00.000Z"});expect(created.policyBinding.package).toEqual(p.from);
      await host.request("/api/scenarios/runs",{commandId:"start",runId:"run",caseId:"case",goal:"Observe",scopeRef:"scope",scenarioKind:"neutral",definitionVersion:1});
      const input={caseId:"case",expectedRevision:1,target:p.to};
      expect((await host.request("/api/scenarios/authorizations/scope/policy-upgrade/preview",input)).eligible).toBe(false);
      await host.request("/api/scenarios/runs/run/pause",{commandId:"pause",expectedRevision:1,reason:"Upgrade"});
      const preview=await host.request("/api/scenarios/authorizations/scope/policy-upgrade/preview",input),request={...input,commandId:"upgrade",actor:"operator",reason:"Upgrade",planFingerprint:preview.planFingerprint};
      expect((await host.app.inject({method:"POST",url:"/api/scenarios/authorizations/scope/policy-upgrade",payload:request})).statusCode).toBe(401);
      await host.request("/api/scenarios/authorizations/scope/policy-upgrade",request);expect((await host.state()).status).toBe("paused");expect(host.requests).toHaveLength(0);
    }finally{await host.close();}
  });
  it("rolls back new scope creation when its policy binding cannot be durably admitted",async()=>{
    const host=await foundationHost({empty:true,ready:()=>false});
    try{
      registerPhysicalStorageFunctions(host.sqlite,()=>({databaseBytes:0,walBytes:0,shmBytes:0,availableBytes:0}));
      await expect(host.request("/api/scenarios/authorizations",{id:"scope",caseId:"case",scenarioKind:"neutral",scope:{},approvedBy:"operator",expiresAt:"2099-01-01T00:00:00.000Z"})).rejects.toThrow();
      expect(host.sqlite.prepare("SELECT count(*) n FROM scenario_authorizations").get()).toEqual({n:0});
      expect(host.sqlite.prepare("SELECT count(*) n FROM scenario_authorization_bindings").get()).toEqual({n:0});
    }finally{await host.close();}
  });
  it("returns recovery diagnostics for legacy scope and refuses Run creation without guessing",async()=>{
    const host=await foundationHost({ready:()=>false});
    try{
      host.sqlite.prepare("INSERT INTO scenario_authorizations VALUES ('legacy','case','neutral','{}','operator','active','2099-01-01',?,?)").run(at,at);
      const scopes=await host.request("/api/scenarios/authorizations?caseId=case");expect(scopes[0].policyBinding.status).toBe("recovery_required");
      await expect(host.request("/api/scenarios/runs",{commandId:"start",runId:"run",caseId:"case",scopeRef:"legacy",scenarioKind:"neutral",definitionVersion:1,goal:"Observe"})).rejects.toThrow("409");
      expect(host.sqlite.prepare("SELECT count(*) n FROM scenario_event_streams").get()).toEqual({n:0});
    }finally{await host.close();}
  });
  it("keeps policy recovery from silently cancelling a running Run or granting a new lease",async()=>{
    const host=await foundationHost({ready:()=>false});
    try{
      await host.start();host.sqlite.exec("UPDATE scenario_authorization_bindings SET contract_hash='corrupt'");
      await expect(host.request("/api/scenarios/runs/run/tick",{})).rejects.toThrow("409");
      expect((await host.state()).status).toBe("running");expect(host.sqlite.prepare("SELECT count(*) n FROM scenario_work_leases").get()).toEqual({n:0});
    }finally{await host.close();}
  });
  it("rechecks fixed scope after the model response before dispatching any custom tool",async()=>{
    const host=await foundationHost({model:async()=>{
      host.sqlite.exec("UPDATE scenario_authorization_bindings SET contract_hash='changed-during-model'");
      return {type:"invoke_tool",invocation:{id:"first",tool:"fixture.read",input:{},rationale:"Observe"}};
    }});
    try{await host.start();await eventually(async()=>["failed","blocked"].includes((await host.state()).workItems[0]?.status));expect(host.calls()).toBe(0);}
    finally{await host.close();}
  });
});
