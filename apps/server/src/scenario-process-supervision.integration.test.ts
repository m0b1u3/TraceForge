import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { SCENARIO_PROCESS_PROTOCOL, ScenarioPackageCapabilityBroker, type ProviderCapabilityReceipt, type ScenarioProcessManifest } from "@traceforge/worker-runtime";
import { database } from "./test-fixtures/execution-recovery.js";
import { SqliteScenarioProcessSupervisionStore } from "./scenario-process-supervision.js";

const databases:Database.Database[]=[],roots:string[]=[];
afterEach(()=>{for(const sqlite of databases.splice(0))if(sqlite.open)sqlite.close();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const manifest:ScenarioProcessManifest={protocol:SCENARIO_PROCESS_PROTOCOL,protocolVersion:1,id:"fixture.package",version:"1.0.0",
  source:"scenario:fixture.package",entrypoint:"package://runtime/main.mjs",providedCapabilities:["fixture.observe"],hostCapabilities:["fixture.lookup"]};
const launchFingerprint="a".repeat(64),proof={nodeId:"node",processId:"process",pid:42,sandboxBackend:"sandbox",
  permissionProfileFingerprint:"b".repeat(64),resourceLimitsFingerprint:"c".repeat(64),network:"deny" as const};

function setup(){const sqlite=database();databases.push(sqlite);return {sqlite,store:new SqliteScenarioProcessSupervisionStore(sqlite,()=>"2026-09-02T00:00:00.000Z")};}
function claimFor(receipt:ProviderCapabilityReceipt){return {schemaVersion:1 as const,package:{id:manifest.id,version:manifest.version},generation:receipt.provider.generation,
  parentRequestId:receipt.parentRequestId,capability:receipt.capability,action:receipt.action,idempotencyKey:receipt.idempotencyKey,inputFingerprint:receipt.inputFingerprint,
  attribution:{caseId:receipt.attribution.caseId,runId:receipt.attribution.runId,workId:receipt.attribution.workId,workerId:receipt.attribution.workerId,
    scopeRef:receipt.attribution.scopeRef,leaseId:receipt.attribution.leaseId},startedAt:receipt.startedAt};}

describe("Scenario Process durable supervision",()=>{
  it("recovers an unfinished generation conservatively and preserves the restart budget across a new Host",()=>{
    const first=setup();first.store.reserveGeneration(manifest,1,2,launchFingerprint);
    first.store.recordLifecycle(manifest,1,"started",{proof});first.store.recordLifecycle(manifest,1,"ready",{proof});
    expect(first.store.snapshot(manifest)).toMatchObject({lastGeneration:1,state:"ready",maximumStarts:2});
    const restarted=new SqliteScenarioProcessSupervisionStore(first.sqlite,()=>"2026-09-02T00:01:00.000Z");
    expect(restarted.recoverInterrupted()).toBe(1);
    expect(restarted.snapshot(manifest)).toMatchObject({lastGeneration:1,state:"interrupted"});
    restarted.reserveGeneration(manifest,2,2,launchFingerprint);
    expect(()=>restarted.reserveGeneration(manifest,3,2,launchFingerprint)).toThrow(/restart budget exhausted/);
  });

  it("persists an exact capability receipt and rejects conflicting replay after restart",()=>{
    const {sqlite,store}=setup();
    const receipt:ProviderCapabilityReceipt={id:"receipt",provider:{id:manifest.id,version:manifest.version,generation:1},parentRequestId:"parent",
      capability:"fixture.lookup",action:"fixture.inspect",idempotencyKey:"stable",inputFingerprint:"d".repeat(64),
      attribution:{caseId:"case",runId:"run",workId:"work",workerId:"worker",scopeRef:"scope",leaseId:"lease",
        leaseExpiresAt:"2100-01-01T00:00:00.000Z",idempotencyKey:"effect"},status:"succeeded",authorizationRef:"authorization",
      output:{available:true},refs:["evidence:first"],requestBytes:1,responseBytes:1,retryable:false,
      startedAt:"2026-09-02T00:00:00.000Z",completedAt:"2026-09-02T00:00:01.000Z"};
    expect(store.claimCapabilityReceipt(manifest,claimFor(receipt))).toBe(true);
    store.settleCapabilityReceipt(manifest,receipt.inputFingerprint,receipt);
    const restarted=new SqliteScenarioProcessSupervisionStore(sqlite);
    expect(restarted.getCapabilityReceipt(manifest,"stable")).toEqual({fingerprint:receipt.inputFingerprint,status:"succeeded",receipt});
    expect(restarted.countCapabilityReceipts(manifest)).toBe(1);
    expect(restarted.claimCapabilityReceipt(manifest,{...claimFor(receipt),inputFingerprint:"e".repeat(64)})).toBe(false);
    expect(()=>restarted.settleCapabilityReceipt(manifest,"e".repeat(64),{...receipt,inputFingerprint:"e".repeat(64)})).toThrow(/matching claim/);
  });

  it("fences an unfinished capability after Host restart instead of redispatching it",async()=>{
    const {sqlite,store}=setup();let executions=0;
    const call=(broker:ScenarioPackageCapabilityBroker,generation:number)=>broker.invoke({provider:{id:manifest.id,version:manifest.version,generation},parentRequestId:"parent",capability:"fixture.lookup",
      action:"fixture.inspect",idempotencyKey:"uncertain",input:{},depth:1,attribution:{caseId:"case",runId:"run",workId:"work",workerId:"worker",
        scopeRef:"scope",leaseId:"lease",leaseExpiresAt:"2100-01-01T00:00:00.000Z",idempotencyKey:"effect",effectivePermissions:{version:1,platform:"linux",
          filesystem:{read:[],write:[],deny:[]},network:"deny",process:{access:"deny",interactive:false,background:false},secrets:"deny",sources:["fixture"]}}});
    const first=new ScenarioPackageCapabilityBroker(manifest,["fixture.lookup"],[{capability:"fixture.lookup",actions:["fixture.inspect"],
      async execute(){executions++;throw new Error("Host interrupted");}}],{},undefined,undefined,store);first.activate(1);
    await expect(call(first,1)).rejects.toThrow(/interrupted/);
    const restarted=new SqliteScenarioProcessSupervisionStore(sqlite);
    const broker=new ScenarioPackageCapabilityBroker(manifest,["fixture.lookup"],[{capability:"fixture.lookup",actions:["fixture.inspect"],
      async execute(){executions++;return {output:{},refs:[]};}}],{},undefined,undefined,restarted);broker.activate(2);
    await expect(call(broker,2)).rejects.toThrow(/unresolved/);expect(executions).toBe(1);
  });

  it("replays a completed Host capability through a newly constructed broker without redispatch",async()=>{
    const {store}=setup();let executions=0;
    const make=()=>new ScenarioPackageCapabilityBroker(manifest,["fixture.lookup"],[{capability:"fixture.lookup",actions:["fixture.inspect"],
      async execute(){executions++;return {output:{available:true},refs:["evidence:first"]};}}],{},undefined,undefined,store);
    const invoke=(broker:ScenarioPackageCapabilityBroker,generation:number)=>broker.invoke({provider:{id:manifest.id,version:manifest.version,generation},
      parentRequestId:`parent:${generation}`,capability:"fixture.lookup",action:"fixture.inspect",idempotencyKey:"durable",input:{candidate:"first"},depth:1,
      attribution:{caseId:"case",runId:"run",workId:"work",workerId:"worker",scopeRef:"scope",leaseId:"lease",
        leaseExpiresAt:"2100-01-01T00:00:00.000Z",idempotencyKey:"effect",effectivePermissions:{version:1,platform:"linux",filesystem:{read:[],write:[],deny:[]},
          network:"deny",process:{access:"deny",interactive:false,background:false},secrets:"deny",sources:["fixture"]}}});
    const first=make();first.activate(1);expect((await invoke(first,1)).replayed).toBeUndefined();
    const restarted=make();restarted.activate(2);expect((await invoke(restarted,2)).replayed).toBe(true);expect(executions).toBe(1);
  });

  it("persists revocation and refuses every later generation",()=>{
    const {store}=setup();store.reserveGeneration(manifest,1,2,launchFingerprint);store.revoke(manifest,"review withdrawn");
    expect(store.snapshot(manifest)).toMatchObject({state:"revoked",revokedReason:"review withdrawn"});
    expect(()=>store.reserveGeneration(manifest,2,2,launchFingerprint)).toThrow(/revoked/);
  });

  it.skipIf(process.platform==="win32")("recovers generation, budget and process occupancy in a new Host after real SIGKILL",async()=>{
    const root=mkdtempSync(join(tmpdir(),"traceforge-scenario-process-crash-"));roots.push(root);const path=join(root,"state.db");
    const fixture=fileURLToPath(new URL("../test-fixtures/scenario-process-crash-host.mjs",import.meta.url));
    await new Promise<void>((resolve,reject)=>{
      const child=spawn(process.execPath,["--import","tsx",fixture,path,"crash"],{cwd:process.cwd(),stdio:["ignore","pipe","pipe"]});
      let output="",errors="",ready=false;const timer=setTimeout(()=>child.kill("SIGKILL"),15000);
      child.stdout.on("data",chunk=>{output+=chunk.toString();if(output.includes("\n")&&!ready){ready=true;child.kill("SIGKILL");}});
      child.stderr.on("data",chunk=>{errors=(errors+chunk.toString()).slice(-4096);});
      child.on("error",error=>{clearTimeout(timer);reject(error);});
      child.on("exit",(_code,signal)=>{clearTimeout(timer);if(ready&&signal==="SIGKILL")resolve();else reject(new Error(errors||"Scenario Process crash fixture deadline"));});
    });
    const recovered=await new Promise<any>((resolve,reject)=>{
      const child=spawn(process.execPath,["--import","tsx",fixture,path,"recover"],{cwd:process.cwd(),stdio:["ignore","pipe","pipe"]});
      let output="",errors="";const timer=setTimeout(()=>child.kill("SIGKILL"),15000);
      child.stdout.on("data",chunk=>{output+=chunk.toString();});child.stderr.on("data",chunk=>{errors=(errors+chunk.toString()).slice(-4096);});
      child.on("error",error=>{clearTimeout(timer);reject(error);});child.on("exit",code=>{clearTimeout(timer);
        if(code===0){try{resolve(JSON.parse(output.trim().split("\n").at(-1)!));}catch(error){reject(error);}}else reject(new Error(errors||output));});
    });
    expect(recovered).toMatchObject({interrupted:1,generation:2,snapshot:{lastGeneration:2,state:"exited"},integrity:"ok"});
    expect(recovered.occupancies).toEqual(expect.arrayContaining(["dispatched","terminal_observed"]));
  },30000);
});
