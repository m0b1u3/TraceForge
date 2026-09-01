import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { ToolProviderFairScheduler } from "@traceforge/worker-runtime";
import { GovernanceHistoryControl } from "./governance-history-control.js";
import { readGovernanceHistory, type GovernanceHistoryKind } from "./db/governance-history.js";
import { archiveStores, readExecutionRow } from "./db/execution-archive.js";
import { ProcessExecutionCapacity } from "./process-execution-capacity.js";
import { ManagedExecutionCapacity } from "./managed-execution-capacity.js";
import { SqliteToolInvocationBindingStore } from "./worker-execution-adapters.js";
import { registerPhysicalStorageFunctions } from "./db/physical-storage.js";
import { database, at } from "./test-fixtures/execution-recovery.js";
import { seedGovernanceHistory, archiveAllow, archiveAt, archiveRequest } from "./test-fixtures/governance-history.js";
import { foundationHost } from "./test-fixtures/foundation-host.js";

const dbs:Database.Database[]=[],roots:string[]=[];
afterEach(()=>{vi.useRealTimers();for(const db of dbs.splice(0))if(db.open)db.close();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function db(path?:string){const value=database(path);dbs.push(value);return value;}
function restore(sqlite:Database.Database,kind:GovernanceHistoryKind){
  const scheduler=new ToolProviderFairScheduler({global:1});
  if(kind==="managedCleanup")new ManagedExecutionCapacity(sqlite,scheduler,new SqliteToolInvocationBindingStore(sqlite),()=>at);
  else new ProcessExecutionCapacity(sqlite,scheduler,()=>at);
  return scheduler;
}
async function fixture(kind:GovernanceHistoryKind,path?:string){
  const sqlite=db(path),seed=await seedGovernanceHistory(sqlite,kind),input=archiveRequest(kind);
  const control=new GovernanceHistoryControl(sqlite,archiveAllow,()=>archiveAt);
  const query={caseId:input.caseId,runId:input.runId,kind,key:"cleanup"};return {sqlite,seed,input,control,query};
}

describe.each(["managedCleanup","processCleanup"] as GovernanceHistoryKind[])("Governance archive %s",kind=>{
  it("archives proof and audit while preserving thin identity, quota and cleanup replay",async()=>{
    const f=await fixture(kind),before=f.seed.inspect(),hot=f.control.inspect(f.query);
    const result=await f.control.archive(f.input);
    expect(result.audit.outcome).toBe("archived");expect(result.audit.results).toHaveLength(kind==="managedCleanup"?2:1);
    const cold=f.control.inspect(f.query);expect(cold.storage).toBe("cold");expect(cold.hotBodyBytes).toBeLessThan(hot.hotBodyBytes);
    expect(readGovernanceHistory(f.sqlite,kind,"cleanup").index.occupancy_key).toBe(f.seed.occupancyKey);
    expect(f.seed.inspect()).toEqual(before);expect(f.seed.scheduler.snapshot().occupied).toBe(0);
    expect((await f.seed.replay()).replayed).toBe(true);expect((await f.control.archive(f.input)).replayed).toBe(true);
    expect(f.sqlite.prepare("SELECT count(*) AS n FROM execution_archive_commands").get()).toEqual({n:1});
    if(kind==="managedCleanup")expect(f.sqlite.prepare("SELECT status FROM tool_invocation_executions").get()).toEqual({status:"executing"});
    else expect(f.sqlite.prepare("SELECT count(*) AS n FROM scenario_event_streams").get()).toEqual({n:0});
  });
  it("reopens disk twice without resurrecting released occupancy or losing history",async()=>{
    const root=mkdtempSync(join(tmpdir(),"traceforge-governance-"));roots.push(root);const path=join(root,"state.db"),f=await fixture(kind,path);
    await f.control.archive(f.input);f.sqlite.close();
    for(let n=0;n<2;n++){
      const sqlite=db(path);expect(restore(sqlite,kind).snapshot().occupied).toBe(0);
      const c=new GovernanceHistoryControl(sqlite,archiveAllow,()=>archiveAt);expect(c.inspect(f.query).storage).toBe("cold");
      expect((await c.archive(f.input)).replayed).toBe(true);sqlite.close();
    }
  });
  it.each(["cold-write","hot-replace","command-commit"])("rolls back both tiers when %s fails",async phase=>{
    const f=await fixture(kind),table=archiveStores[kind].table;
    const target=phase==="cold-write"?"INSERT ON execution_archives":phase==="hot-replace"?`UPDATE ON ${table}`:"INSERT ON execution_archive_commands";
    f.sqlite.exec(`CREATE TEMP TRIGGER injected BEFORE ${target} BEGIN SELECT RAISE(ABORT,'injected'); END`);
    await expect(f.control.archive(f.input)).rejects.toThrow("injected");
    expect(f.control.inspect(f.query).storage).toBe("hot");expect(f.sqlite.prepare("SELECT records FROM execution_archive_usage").get()).toEqual({records:0});
    expect((await f.seed.replay()).replayed).toBe(true);f.sqlite.exec("DROP TRIGGER injected");
    expect((await f.control.archive(f.input)).audit.outcome).toBe("archived");
  });
  it.each(["missing","corrupt","projection"])("fails read, cleanup replay and restart closed for %s cold data",async failure=>{
    const f=await fixture(kind);await f.control.archive(f.input);
    if(failure==="projection"){
      f.sqlite.function("execution_archive_writing",(_kind,_key)=>1);
      f.sqlite.prepare(`UPDATE ${archiveStores[kind].table} SET audit_json='execution-archive:wrong' WHERE command_id='cleanup'`).run();
    }else{
      f.sqlite.exec(`DROP TRIGGER execution_archives_immutable_${failure==="missing"?"delete":"update"}`);
      if(failure==="missing")f.sqlite.prepare("DELETE FROM execution_archives WHERE kind=?").run(kind);
      else f.sqlite.prepare("UPDATE execution_archives SET payload=x'00' WHERE kind=?").run(kind);
    }
    expect(()=>f.control.inspect(f.query)).toThrow();await expect(f.seed.replay()).rejects.toThrow();
    expect(()=>restore(f.sqlite,kind)).toThrow();
    expect(f.seed.inspect().state).toBe("released"); // corruption never creates a replacement execution
  });
  it.each(["denied","expired","missing"])("requires %s archive authorization without writing",async mode=>{
    const f=await fixture(kind);
    const authorizer=mode==="missing"?undefined:{async authorize(){return mode==="denied"?{decision:"denied" as const}:{decision:"allowed" as const,authorizationRef:"test",expiresAt:at};}};
    await expect(new GovernanceHistoryControl(f.sqlite,authorizer,()=>archiveAt).archive(f.input)).rejects.toThrow("denied");
    expect(f.control.inspect(f.query).storage).toBe("hot");expect(f.sqlite.prepare("SELECT count(*) AS n FROM execution_archive_commands").get()).toEqual({n:0});
  });
  it("reauthorizes replay, rejects command conflicts and snapshots before waiting",async()=>{
    const f=await fixture(kind),request=structuredClone(f.input);
    const authorizer={async authorize(){request.entries[0]!.key="changed";request.reason="mutated";return archiveAllow.authorize();}};
    const result=await new GovernanceHistoryControl(f.sqlite,authorizer,()=>archiveAt).archive(request);
    expect(result.audit.reason).toBe(f.input.reason);
    await expect(new GovernanceHistoryControl(f.sqlite,undefined,()=>archiveAt).archive(f.input)).rejects.toThrow("denied");
    await expect(f.control.archive({...f.input,reason:"different"})).rejects.toThrow("conflict");
  });
  it("does not archive before retention or across another scope",async()=>{
    const f=await fixture(kind);
    await expect(new GovernanceHistoryControl(f.sqlite,archiveAllow,()=>at).archive(f.input)).rejects.toThrow("retention");
    await expect(f.control.archive({...f.input,caseId:"other"})).rejects.toThrow("scope");
    expect(()=>f.control.inspect({...f.query,runId:"other"})).toThrow("scope");
    expect(()=>f.control.candidates({caseId:f.input.caseId,runId:f.input.runId,kind,limit:101})).toThrow();
  });
  it("keeps permanent identities immutable and meters cold capacity",async()=>{
    const f=await fixture(kind);
    f.sqlite.exec("UPDATE execution_archive_policy SET maximum_records=1");
    await expect(f.control.archive(f.input)).rejects.toThrow("capacity");
    expect(f.sqlite.prepare("SELECT records FROM execution_archive_usage").get()).toEqual({records:0});
    expect(()=>f.sqlite.exec("DELETE FROM execution_governance_history")).toThrow("permanent");
    expect(()=>f.sqlite.exec("UPDATE execution_governance_history SET fingerprint='changed'")).toThrow("immutable");
    f.sqlite.exec("UPDATE execution_archive_policy SET maximum_records=200000");await f.control.archive(f.input);
    expect(()=>f.sqlite.exec(`UPDATE ${archiveStores[kind].table} SET audit_json='{}'`)).toThrow("immutable");
    expect(()=>f.sqlite.exec(`DELETE FROM ${archiveStores[kind].table}`)).toThrow();
  });
  it("migrates existing hot cleanup history before enabling archival",async()=>{
    const f=await fixture(kind);f.sqlite.exec("DROP TABLE execution_governance_history");restore(f.sqlite,kind);
    expect(f.control.inspect(f.query).storage).toBe("hot");expect((await f.control.archive(f.input)).audit.outcome).toBe("archived");
  });
  it("serializes concurrent archive commands without duplicate cold copies",async()=>{
    const f=await fixture(kind);
    const results=await Promise.all([f.control.archive(f.input),f.control.archive(f.input)]);
    expect(results.map(r=>r.replayed).sort()).toEqual([false,true]);
    expect(f.sqlite.prepare("SELECT count(*) AS n FROM execution_archives").get()).toEqual({n:kind==="managedCleanup"?2:1});
  });
  it("rolls back a completed tier move when its grant expires before commit",async()=>{
    const f=await fixture(kind);let clock=archiveAt;
    f.sqlite.function("expire_grant",()=>{clock="2099-01-01T00:00:00.000Z";return 0;});
    f.sqlite.exec(`CREATE TEMP TRIGGER expire_archive AFTER UPDATE ON ${archiveStores[kind].table} BEGIN SELECT expire_grant(); END`);
    await expect(new GovernanceHistoryControl(f.sqlite,archiveAllow,()=>clock).archive(f.input)).rejects.toThrow("expired before commit");
    expect(f.control.inspect(f.query).storage).toBe("hot");expect(f.sqlite.prepare("SELECT records FROM execution_archive_usage").get()).toEqual({records:0});
  });
  it("keeps candidates paginated and visible after their bodies move",async()=>{
    const f=await fixture(kind),query={caseId:f.input.caseId,runId:f.input.runId,kind,limit:1};
    expect(f.control.candidates(query).entries[0]).toMatchObject({key:"cleanup",storage:"hot",eligible:true});
    await f.control.archive(f.input);
    expect(f.control.candidates(query)).toMatchObject({entries:[{key:"cleanup",storage:"cold"}],nextCursor:null});
    expect(f.control.candidates({...query,after:"cleanup"}).entries).toEqual([]);
    expect(f.control.candidates({...query,caseId:"other"}).entries).toEqual([]);
  });
});

describe("Governance archive composed recovery",()=>{
  it("verifies linked Managed proof corruption even when its cleanup audit is intact",async()=>{
    const f=await fixture("managedCleanup");await f.control.archive(f.input);
    f.sqlite.exec("DROP TRIGGER execution_archives_immutable_update; UPDATE execution_archives SET payload=x'00' WHERE kind='evidence'");
    await expect(f.seed.replay()).rejects.toThrow();expect(()=>restore(f.sqlite,"managedCleanup")).toThrow();
  });
  it("keeps another unresolved process counted when archiving completed service history",async()=>{
    const f=await fixture("processCleanup"),capacity=new ProcessExecutionCapacity(f.sqlite,new ToolProviderFairScheduler({global:1,maximumWaitMs:10}),()=>at);
    const attribution={caseId:"case",runId:"other",workId:"work",leaseId:"lease",workerId:"worker",scopeRef:"scope",actionId:"observe",idempotencyKey:"other",leaseExpiresAt:"2099-01-01T00:00:00.000Z"};
    const lease=await capacity.acquire({source:"second",version:"1",operation:"observe",kind:"service",attribution});lease.beforeStart("other-request");lease.finish(false);
    await f.control.archive(f.input);expect(capacity.scheduler.snapshot().occupied).toBe(1);
    expect(restore(f.sqlite,"processCleanup").snapshot().occupied).toBe(1);
    await expect(capacity.acquire({source:"third",version:"1",operation:"observe",kind:"service",attribution:{...attribution,idempotencyKey:"third"}})).rejects.toMatchObject({reason:"wait_timeout"});
  });
  it("enforces the authorization deadline and ignores late grants",async()=>{
    const f=await fixture("processCleanup");vi.useFakeTimers();let grant!: (value:Awaited<ReturnType<typeof archiveAllow.authorize>>)=>void;
    const control=new GovernanceHistoryControl(f.sqlite,{authorize:()=>new Promise(resolve=>{grant=resolve;})},()=>archiveAt);
    const waiting=expect(control.archive(f.input)).rejects.toThrow("deadline");await vi.advanceTimersByTimeAsync(10001);await waiting;
    grant(await archiveAllow.authorize());await Promise.resolve();expect(f.control.inspect(f.query).storage).toBe("hot");
  });
  it("rejects physical pressure without losing cleanup history",async()=>{
    const root=mkdtempSync(join(tmpdir(),"traceforge-governance-pressure-"));roots.push(root);const f=await fixture("processCleanup",join(root,"state.db"));
    registerPhysicalStorageFunctions(f.sqlite,()=>({availableBytes:1,databaseBytes:1024,walBytes:0,shmBytes:0}));
    await expect(f.control.archive(f.input)).rejects.toThrow("physical");expect(f.control.inspect(f.query).storage).toBe("hot");
  });
  it("exposes production HTTP authorization and metadata-only cold history without running a model",async()=>{
    const h=await foundationHost({empty:true,foundation:{governanceHistoryAuthorizer:archiveAllow}});
    try{
      await seedGovernanceHistory(h.sqlite,"processCleanup");
      const result=await h.request("/api/security-tools/storage/governance-archive",archiveRequest("processCleanup"));expect(result.audit.outcome).toBe("archived");
      const record=await h.request("/api/security-tools/storage/governance-history?caseId=case&runId=service&kind=processCleanup&key=cleanup");
      expect(record.storage).toBe("cold");expect(JSON.stringify(record)).not.toContain("signature");
      const candidates=await h.request("/api/security-tools/storage/governance-candidates?caseId=case&runId=service&kind=processCleanup&limit=1");
      expect(candidates.entries).toHaveLength(1);expect(h.requests).toHaveLength(0);
      h.sqlite.pragma("query_only=ON");expect(await h.request("/api/security-tools/storage/governance-history?caseId=case&runId=service&kind=processCleanup&key=cleanup")).toEqual(record);
      h.sqlite.pragma("query_only=OFF");
    }finally{await h.close();}
  });
  it.each((["managedCleanup","processCleanup"] as GovernanceHistoryKind[]).flatMap(kind=>["cold-written","hot-replaced","committed"].map(phase=>({kind,phase}))))("recovers $kind history tiers after SIGKILL at $phase",async({kind,phase})=>{
    const root=mkdtempSync(join(tmpdir(),"traceforge-governance-crash-"));roots.push(root);const path=join(root,"state.db");
    await new Promise<void>((resolve,reject)=>{
      const child=spawn(process.execPath,["--import","tsx",fileURLToPath(new URL("../test-fixtures/governance-archive-crash-host.mjs",import.meta.url)),path,phase,kind],{stdio:["ignore","pipe","pipe"]});
      let ready=false,output="",errors="";const timer=setTimeout(()=>child.kill("SIGKILL"),15000);
      child.stdout.on("data",chunk=>{output+=String(chunk);if(output.includes("\n")){ready=true;child.kill("SIGKILL");}});
      child.stderr.on("data",chunk=>{errors=(errors+String(chunk)).slice(-4096);});
      child.on("error",error=>{clearTimeout(timer);reject(error);});
      child.on("exit",(_code,signal)=>{clearTimeout(timer);if(ready&&signal==="SIGKILL")resolve();else reject(new Error(errors||"Crash fixture timeout"));});
    });
    for(let n=0;n<2;n++){
      const sqlite=db(path);for(const sourceKind of ["managedCleanup","processCleanup"] as GovernanceHistoryKind[])expect(restore(sqlite,sourceKind).snapshot().occupied).toBe(0);
      expect(sqlite.prepare("SELECT count(*) AS n FROM execution_archive_commands").get()).toEqual({n:phase==="committed"||n>0?1:0});
      const control=new GovernanceHistoryControl(sqlite,archiveAllow,()=>archiveAt);
      await control.archive(archiveRequest(kind));
      expect(readExecutionRow(sqlite,kind,"cleanup")).toBeDefined();expect(sqlite.pragma("integrity_check",{simple:true})).toBe("ok");sqlite.close();
    }
  },20000);
});
