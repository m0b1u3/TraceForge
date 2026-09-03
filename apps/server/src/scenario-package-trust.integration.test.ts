import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { ScenarioPackageRegistry } from "@traceforge/scenario-sdk";
import { DurableScenarioRuntime, ScenarioDefinitionRegistry } from "@traceforge/orchestration-core";
import { database } from "./test-fixtures/execution-recovery.js";
import { migrationPackages, migrationFixture } from "./test-fixtures/run-migration.js";
import { reviewedMaterial } from "./test-fixtures/scenario-package-trust.js";
import { ScenarioPackageTrustControl, scenarioMaterialDigest, signScenarioPackageReview, type ScenarioPackageTrustOptions } from "./scenario-package-trust.js";
import { SqliteScenarioAuthorizationService } from "./scenario-authorization.js";
import { SqliteScenarioEventStore } from "./scenario-event-store.js";
import { GovernedExecutionSources } from "./governed-execution-sources.js";
import { foundationHost } from "./test-fixtures/foundation-host.js";
import { registerPhysicalStorageFunctions } from "./db/physical-storage.js";

const roots:string[]=[],dbs:Database.Database[]=[];
afterEach(()=>{for(const db of dbs.splice(0))if(db.open)db.close();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function root(){const path=mkdtempSync(join(tmpdir(),"traceforge-package-review-"));roots.push(path);return path;}
function fixture(configure?:(material:ReturnType<typeof reviewedMaterial>,pkg:ReturnType<typeof migrationPackages>["source"])=>void,options:ScenarioPackageTrustOptions={}){
  const sqlite=database();dbs.push(sqlite);const pkg=migrationPackages().source,path=root(),material=reviewedMaterial(join(path,"material"),pkg);
  configure?.(material,pkg);const source=new ScenarioPackageRegistry([pkg]),control=new ScenarioPackageTrustControl(sqlite,source,{...material.options,...options});
  return {sqlite,pkg,path,material,source,control};
}
function status(f:ReturnType<typeof fixture>){return f.control.snapshot().packages[0]!;}
function request(f:ReturnType<typeof fixture>){return {commandId:"revoke",package:f.source.bindingFor(f.pkg),actor:"operator",reason:"Withdraw reviewed material"};}

describe("Reviewed Scenario material and current host assembly",()=>{
  it("enrolls signed material without loading code and requires explicit host association",()=>{
    const f=fixture();expect(status(f).status).toBe("reviewed_available");expect(f.control.registry.requireForScenario("neutral")).toBe(f.pkg);
    expect(f.sqlite.prepare("SELECT count(*) n FROM scenario_package_materials").get()).toEqual({n:1});expect(f.control.snapshot().automaticCodeLoading).toBe(false);
  });
  it("does not let development mode silently bypass an invalid explicit review",()=>{
    const f=fixture(m=>{m.installation.review.signature="invalid";},{allowUnreviewedDevelopmentPackages:true});expect(status(f).status).toBe("recovery_required");
    expect(f.sqlite.prepare("SELECT count(*) n FROM scenario_package_materials").get()).toEqual({n:0});
  });
  it("keeps unreviewed packages unavailable by default and labels explicit development use",()=>{
    const f=fixture(),sqlite=database();dbs.push(sqlite);
    const missing=new ScenarioPackageTrustControl(sqlite,f.source),development=new ScenarioPackageTrustControl(sqlite,f.source,{allowUnreviewedDevelopmentPackages:true});
    expect(missing.snapshot().packages[0]!.status).toBe("recovery_required");expect(development.snapshot().packages[0]!.status).toBe("development_unreviewed");
  });
  it.each([undefined,async()=>{throw new Error("Async association");}])("refuses missing or asynchronous host assembly attestation",assertAssembly=>{
    expect(status(fixture(undefined,{assertAssembly})).status).toBe("recovery_required");
  });
  it.each(["signature","authority","expired","future","package","contract","manifest"])("rejects invalid %s review material",kind=>{
    const f=fixture(m=>{
      if(kind==="signature")m.installation.review.signature="a".repeat(88);
      if(kind==="authority")m.authority.revoked=true;
      if(kind==="expired")m.installation.review.expiresAt="2020-01-01T00:00:00.000Z";
      if(kind==="future")m.installation.review.issuedAt="2097-01-01T00:00:00.000Z";
      if(kind==="package")m.installation.review.package={...m.installation.review.package,version:"other"};
      if(kind==="contract")m.installation.review.contractDigest="sha256:"+"a".repeat(64);
      if(kind==="manifest")m.installation.manifest.files[0]!.digest="sha256:"+"b".repeat(64);
      if(kind!=="signature" && kind!=="authority"){const {signature:_,...payload}=m.installation.review;m.installation.review=signScenarioPackageReview(payload,m.privateKeyPem);}
    });expect(status(f).status).toBe("recovery_required");expect(f.sqlite.prepare("SELECT count(*) n FROM scenario_package_materials").get()).toEqual({n:0});
  });
  it.each(["entry","dependency","extra","symlink","parent","duplicate"])("refuses changed or unsafe %s file declarations",kind=>{
    const f=fixture(m=>{
      const dir=m.installation.root;
      if(kind==="entry")writeFileSync(join(dir,"entry.mjs"),"replaced entry");
      if(kind==="dependency")unlinkSync(join(dir,"dependency.mjs"));
      if(kind==="extra")writeFileSync(join(dir,"unexpected.mjs"),"extra");
      if(kind==="symlink"){unlinkSync(join(dir,"entry.mjs"));symlinkSync(join(dir,"dependency.mjs"),join(dir,"entry.mjs"));}
      if(kind==="parent")m.installation.manifest.entry="../escape.mjs";
      if(kind==="duplicate")m.installation.manifest.files.push({...m.installation.manifest.files[0]!});
      if(kind==="duplicate"){const {signature:_,...payload}=m.installation.review;m.installation.review=signScenarioPackageReview({...payload,materialDigest:scenarioMaterialDigest(m.installation.manifest)},m.privateKeyPem);}
    });expect(status(f).status).toBe("recovery_required");
  });
  it("rechecks bytes on use and restores only the original reviewed bytes",()=>{
    const f=fixture(),file=join(f.material.installation.root,"entry.mjs"),before=readFileSync(file);
    writeFileSync(file,Buffer.alloc(before.length,33));expect(()=>f.control.registry.requireForScenario("neutral")).toThrow("digest");
    writeFileSync(file,before);expect(status(f).status).toBe("reviewed_available");
  });
  it.each(["definition","policy","factory","schema"])("detects changed in-memory %s association",kind=>{
    const f=fixture();if(kind==="definition")f.pkg.definition.title="Changed";
    if(kind==="policy")f.pkg.authorizationPolicy={parseScope:payload=>({payload,allowedActions:[],deniedActions:[]})};
    if(kind==="factory")f.pkg.createToolSources=()=>[];
    if(kind==="schema")f.pkg.outputSchemas=[{kind:"decision",version:1,validate(){throw new Error("Changed");}}];
    expect(()=>f.control.registry.requireForScenario("neutral")).toThrow("changed");
  });
  it("rechecks current authority and host assembly association",()=>{
    let associated=true;const f=fixture(undefined,{assertAssembly(){if(!associated)throw new Error("Assembly withdrawn");}});
    f.material.authority.revoked=true;expect(status(f).status).toBe("recovery_required");f.material.authority.revoked=false;
    associated=false;expect(status(f).reason).toContain("Assembly withdrawn");
  });
  it("rejects re-signed replacement material for the same installed version",()=>{
    const f=fixture(),manifest=structuredClone(f.material.installation.manifest);manifest.files[0]!.role="data";manifest.files[1]!.role="entry";manifest.entry="dependency.mjs";
    const {signature:_,...payload}=f.material.installation.review;
    const review=signScenarioPackageReview({...payload,materialDigest:scenarioMaterialDigest(manifest)},f.material.privateKeyPem);
    const next=new ScenarioPackageTrustControl(f.sqlite,f.source,{...f.material.options,installations:[{...f.material.installation,manifest,review}]});
    expect(next.snapshot().packages[0]!.reason).toContain("cannot change");expect(f.sqlite.prepare("SELECT count(*) n FROM scenario_package_materials").get()).toEqual({n:1});
  });
  it("permits a fresh endorsement of unchanged material without rewriting the pinned version",()=>{
    const f=fixture(),{signature:_,...payload}=f.material.installation.review,review=signScenarioPackageReview({...payload,reviewRef:"renewed-review"},f.material.privateKeyPem);
    const next=new ScenarioPackageTrustControl(f.sqlite,f.source,{...f.material.options,installations:[{...f.material.installation,review}]});
    expect(next.snapshot().packages[0]!.status).toBe("reviewed_available");expect(f.sqlite.prepare("SELECT count(*) n FROM scenario_package_reviews").get()).toEqual({n:2});
  });
  it("does not downgrade a previously reviewed version to development use",()=>{
    const f=fixture(),next=new ScenarioPackageTrustControl(f.sqlite,f.source,{allowUnreviewedDevelopmentPackages:true});expect(next.snapshot().packages[0]!.status).toBe("recovery_required");
  });
  it("uses the current material gate for pinned scope and Run replay",async()=>{
    const sqlite=database();dbs.push(sqlite);const f=migrationFixture(sqlite),m=reviewedMaterial(join(root(),"material"),f.source);
    const trust=new ScenarioPackageTrustControl(sqlite,f.packages,{...m.options,allowUnreviewedDevelopmentPackages:true});
    const authorization=new SqliteScenarioAuthorizationService(sqlite,trust.registry),runtime=new DurableScenarioRuntime(new SqliteScenarioEventStore(sqlite),new ScenarioDefinitionRegistry(trust.registry.definitions()),trust.registry);
    expect(authorization.requireAction("scope","case","observe").id).toBe("scope");expect(runtime.load("run")!.status).toBe("paused");
    await trust.revoke({commandId:"withdraw",package:f.from,actor:"operator",reason:"Review withdrawn"});
    expect(()=>authorization.requireAction("scope","case","observe")).toThrow("revoked");expect(()=>runtime.load("run")).toThrow("revoked");
    expect(new SqliteScenarioEventStore(sqlite).load("run").revision).toBe(4);
  });
  it.each([undefined,{async authorize(){return {decision:"denied" as const};}}])("requires independent revocation authorization",async revokeAuthorizer=>{
    const f=fixture(undefined,{revokeAuthorizer});await expect(f.control.revoke(request(f))).rejects.toThrow("authorization");expect(status(f).status).toBe("reviewed_available");
  });
  it("reauthorizes concurrent duplicate revocations and retains immutable audit",async()=>{
    const f=fixture(),results=await Promise.all([f.control.revoke(request(f)),f.control.revoke(request(f))]);
    expect(results.filter(r=>!r.replayed)).toHaveLength(1);expect(status(f).reason).toContain("revoked");
    expect(f.control.inspect("revoke").reason).toBe("Withdraw reviewed material");expect(()=>f.sqlite.exec("DELETE FROM scenario_package_revocations")).toThrow("immutable");
    await expect(f.control.revoke({...request(f),reason:"Other"})).rejects.toThrow("conflicts");
  });
  it("rolls back revocation on persistence failure without losing the reviewed version",async()=>{
    const f=fixture();f.sqlite.exec("CREATE TEMP TRIGGER fail BEFORE INSERT ON scenario_package_revocations BEGIN SELECT RAISE(ABORT,'injected'); END");
    await expect(f.control.revoke(request(f))).rejects.toThrow("injected");expect(status(f).status).toBe("reviewed_available");
  });
  it("keeps material and endorsement enrollment atomic under audit failure",()=>{
    const f=fixture(),sqlite=database();dbs.push(sqlite);new ScenarioPackageTrustControl(sqlite,new ScenarioPackageRegistry());
    sqlite.exec("CREATE TEMP TRIGGER fail BEFORE INSERT ON scenario_package_reviews BEGIN SELECT RAISE(ABORT,'injected'); END");
    const control=new ScenarioPackageTrustControl(sqlite,f.source,f.material.options);expect(control.snapshot().packages[0]!.status).toBe("recovery_required");
    expect(sqlite.prepare("SELECT count(*) n FROM scenario_package_materials").get()).toEqual({n:0});
  });
  it("quarantines material enrollment under physical storage pressure",()=>{
    const f=fixture(),sqlite=database();dbs.push(sqlite);registerPhysicalStorageFunctions(sqlite,()=>({databaseBytes:0,walBytes:0,shmBytes:0,availableBytes:0}));
    const control=new ScenarioPackageTrustControl(sqlite,f.source,f.material.options);expect(control.snapshot().packages[0]!.status).toBe("recovery_required");
    expect(sqlite.prepare("SELECT count(*) n FROM scenario_package_materials").get()).toEqual({n:0});
  });
  it("guards factory assembly, discovery and previously discovered tool execution",async()=>{
    let factories=0,effects=0;const sqlite=database();dbs.push(sqlite);const f=migrationFixture(sqlite);
    f.source.createToolSources=()=>{factories++;return [{source:"fixture.reviewed",async discover(){return [{name:"observe",source:"fixture.reviewed",version:f.source.version,priority:1,description:"Observe",inputSchema:{},providedCapabilities:["observe"],dependencyCapabilities:[],permissionRequirements:{},risk:"read_only" as const,timeoutMs:1000,
      async execute(){effects++;return {status:"succeeded" as const,summary:"Observed",raw:"",refs:[],retryable:false};}}];}}];};
    const material=reviewedMaterial(join(root(),"material"),f.source),trust=new ScenarioPackageTrustControl(sqlite,new ScenarioPackageRegistry([f.source]),material.options),governed=new GovernedExecutionSources(undefined,f.capacity);
    const hostContext={artifacts:{} as any,state:{} as any,capabilities:{optional(){return undefined;},require(){return {};}} as any,
      authorization:{} as any,evidence:{} as any};
    const sources=governed.scenarioSources(trust.registry,hostContext,{}, {}, true),tools=await sources[0]!.discover();expect(factories).toBe(1);
    await trust.revoke({commandId:"withdraw",package:f.from,actor:"operator",reason:"Stop using material"});
    await expect(sources[0]!.discover()).rejects.toThrow("revoked");
    await expect(tools[0]!.execute({}, {caseId:"case",runId:"run",workId:"work",workerId:"worker",scopeRef:"scope",leaseId:"lease",leaseExpiresAt:"2099-01-01",idempotencyKey:"call",effectivePermissions:{} as any})).rejects.toThrow("revoked");
    expect(governed.scenarioSources(trust.registry,hostContext,{}, {}, true)).toEqual([]);expect(factories).toBe(1);expect(effects).toBe(0);
  });
  it("serves protected trust diagnostics and quarantines unreviewed production packages",async()=>{
    const p=migrationPackages();let factories=0;p.source.createToolSources=()=>{factories++;return [];};
    const host=await foundationHost({empty:true,ready:()=>false,foundation:{scenarioPackageRegistry:new ScenarioPackageRegistry([p.source]),scenarioPackageTrust:{}}});
    try{expect(factories).toBe(0);expect((await host.request("/api/scenarios/package-trust")).packages[0].status).toBe("recovery_required");
      expect((await host.app.inject({url:"/api/scenarios/package-trust"})).statusCode).toBe(401);
      await expect(host.request("/api/scenarios/authorizations",{id:"scope",caseId:"case",scenarioKind:"neutral",scope:{},approvedBy:"operator",expiresAt:"2099-01-01T00:00:00.000Z"})).rejects.toThrow();
    }finally{await host.close();}
  });
  it("uses signed material through production routes and preserves old facts after revocation",async()=>{
    const p=migrationPackages(),m=reviewedMaterial(join(root(),"material"),p.source);
    const host=await foundationHost({empty:true,ready:()=>false,foundation:{scenarioPackageRegistry:new ScenarioPackageRegistry([p.source]),scenarioPackageTrust:m.options}});
    try{
      expect((await host.request("/api/scenarios/package-trust")).packages[0].status).toBe("reviewed_available");
      await host.request("/api/scenarios/authorizations",{id:"scope",caseId:"case",scenarioKind:"neutral",scope:{},approvedBy:"operator",expiresAt:"2099-01-01T00:00:00.000Z"});
      await host.request("/api/scenarios/runs",{commandId:"start",runId:"run",caseId:"case",scenarioKind:"neutral",definitionVersion:1,goal:"Observe",scopeRef:"scope"});
      const body={commandId:"withdraw",package:p.from,actor:"operator",reason:"Withdraw"};
      expect((await host.app.inject({method:"POST",url:"/api/scenarios/package-trust/revoke",payload:body})).statusCode).toBe(401);
      await host.request("/api/scenarios/package-trust/revoke",body);await expect(host.state()).rejects.toThrow("409");
      expect((await host.request("/api/scenarios/package-trust/revocations?commandId=withdraw")).materialDigest).toBe(m.installation.review.materialDigest);
      expect(new SqliteScenarioEventStore(host.sqlite).load("run").revision).toBe(1);expect(host.requests).toHaveLength(0);
    }finally{await host.close();}
  });
  it.each(["enrollment","revocation","committed"])("recovers two hosts after SIGKILL at %s",async phase=>{
    const path=root(),materialRoot=join(path,"material"),pkg=migrationPackages().source,m=reviewedMaterial(materialRoot,pkg),dbPath=join(path,"state.db");
    writeFileSync(join(path,"fixture.json"),JSON.stringify({installation:m.installation,authority:m.authority}));
    await new Promise<void>((resolve,reject)=>{
      const child=spawn(process.execPath,["--import","tsx",fileURLToPath(new URL("../test-fixtures/scenario-package-trust-crash-host.mjs",import.meta.url)),path,phase],{stdio:["ignore","ignore","pipe"]});let errors="";
      child.stderr.on("data",chunk=>{errors+=chunk.toString();});const timer=setTimeout(()=>{child.kill("SIGKILL");reject(new Error("Crash fixture deadline"));},15000);
      child.on("error",reject);child.on("exit",(_code,signal)=>{clearTimeout(timer);if(signal==="SIGKILL")resolve();else reject(new Error(errors));});
    });
    for(let pass=0;pass<2;pass++){
      const sqlite=database(dbPath);dbs.push(sqlite);
      if(phase==="enrollment" && pass===0)expect(sqlite.prepare("SELECT count(*) n FROM scenario_package_materials").get()).toEqual({n:0});
      const control=new ScenarioPackageTrustControl(sqlite,new ScenarioPackageRegistry([pkg]),m.options);
      expect(control.snapshot().packages[0]!.status).toBe(phase==="committed"?"recovery_required":"reviewed_available");
      expect(sqlite.prepare("SELECT count(*) n FROM scenario_package_revocations").get()).toEqual({n:phase==="committed"?1:0});sqlite.close();
    }
  });
});
