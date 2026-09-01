import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import Fastify from "fastify";
import { createDb, getSqliteClient } from "./db/client.js";
import { FoundationBackupControl } from "./foundation-backup.js";
import { FoundationRecoveryReadinessControl, recoveryDependencySchema } from "./foundation-recovery-readiness.js";
import { FoundationRecoveryActivationControl, resolveFoundationActiveDatabase, type FoundationRecoveryActivationOptions } from "./foundation-recovery-activation.js";
import { readFoundationRestoreFence } from "./db/foundation-restore-fence.js";
import { migrationFixture } from "./test-fixtures/run-migration.js";
import { registerSecurityAgentFoundation } from "./security-agent-foundation.js";
import { foundationHostControl } from "./foundation-host-control.js";
import { buildServer } from "./main.js";

const roots:string[]=[],dbs:Database.Database[]=[],apps:ReturnType<typeof Fastify>[]=[];
const allow={async authorize(){return{decision:"allowed" as const,authorizationRef:"independent-recovery-review",expiresAt:"2099-01-01T00:00:00.000Z"};}};
const sha=(value:unknown)=>createHash("sha256").update(typeof value==="string"?value:JSON.stringify(value)).digest("hex");
afterEach(async()=>{vi.restoreAllMocks();for(const app of apps.splice(0))await app.close();for(const db of dbs.splice(0))if(db.open)db.close();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});

async function fixture(running=true,asset=false){const root=mkdtempSync("/private/tmp/traceforge-recovery-activation-");roots.push(root);
  const source=getSqliteClient(createDb(join(root,"source.sqlite")));dbs.push(source);const run=migrationFixture(source);if(running)run.command({type:"resume_run",reason:"Continue neutral investigation",requestedBy:"operator",at:"2026-09-01T00:00:00.000Z"});
  const attachment=join(root,"attachment");if(asset)writeFileSync(attachment,"reviewed recovery attachment");
  const backupOptions={backupRoot:join(root,"backups"),restoreRoot:join(root,"restores"),authorizer:allow,minimumFreeBytes:1,
    assets:asset?[{id:"resource",path:attachment,sha256:createHash("sha256").update(readFileSync(attachment)).digest("hex")}]:undefined};
  const backups=new FoundationBackupControl(source,backupOptions),saved=await backups.execute({commandId:"backup",operation:"backup",actor:"operator",reason:"Recovery activation test"});
  await backups.execute({commandId:"restore",operation:"restore",backupId:"backup",manifestDigest:saved.manifestDigest,actor:"operator",reason:"Isolated evidence restore"});
  const restoredPath=join(backupOptions.restoreRoot,"restore","database.sqlite"),restored=getSqliteClient(createDb(restoredPath));dbs.push(restored);const fence=readFoundationRestoreFence(restored)!;
  const audit=new Database(join(root,"recovery-control.sqlite"));dbs.push(audit);const fingerprints=new Map(recoveryDependencySchema.options.map(item=>[item,sha(item)]));
  const readiness=new FoundationRecoveryReadinessControl(restored,fence,{auditDb:audit,authorizer:allow,currentFingerprint:item=>fingerprints.get(item),verifier:{async verify({dependency}){return{
    decision:"satisfied" as const,evidenceRef:`review:${dependency}`,materialFingerprint:fingerprints.get(dependency)!,expiresAt:"2099-01-01T00:00:00.000Z"};}}});
  for(const item of recoveryDependencySchema.options)await readiness.execute({commandId:`attest_${item}`,dependency:item,operation:"attest",expectedRevision:0,actor:"operator",reason:"Current host dependency review"});
  const options:FoundationRecoveryActivationOptions={auditDb:audit,candidateRoot:join(root,"candidates"),controlRoot:join(root,"activation"),authorizer:allow,
    currentFingerprint:item=>fingerprints.get(item),assembler:{async assemble(input){return{decision:"assembled",assemblyRef:`assembly:${input.dependency}`,materialFingerprint:input.materialFingerprint};}},maximumBytes:64*1024*1024};
  const control=new FoundationRecoveryActivationControl(options,restored,fence,readiness),readinessDigest=readiness.inspect().readinessDigest!;
  const prepare=async(candidateId="candidate1",commandId=`prepare_${candidateId}`)=>control.execute({operation:"prepare",commandId,candidateId,expectedReadinessDigest:readinessDigest,actor:"operator",reason:"Build a separate working candidate"});
  return{root,source,run,backups,saved,backupOptions,restoredPath,restored,fence,audit,fingerprints,readiness,options,control,readinessDigest,prepare};}
function switchRequest(control:FoundationRecoveryActivationControl,operation:"activate"|"rollback",candidateId:string,expectedRevision:number,expectedGeneration:number,commandId:string){
  const preview=control.preview({operation,candidateId,expectedRevision,expectedGeneration});return{operation,commandId,candidateId,expectedRevision,expectedGeneration,
    planFingerprint:preview.planFingerprint,actor:"operator",reason:operation==="activate"?"Select reviewed candidate":"Return to previous reviewed candidate"};}
async function crash(root:string,phase:string,request:unknown){writeFileSync(join(root,"crash-request.json"),JSON.stringify(request));const child=spawn(process.execPath,["--import","tsx",
    fileURLToPath(new URL("../test-fixtures/foundation-recovery-activation-crash-host.mjs",import.meta.url)),root,phase],{stdio:["ignore","pipe","pipe"]}),errors:string[]=[];
  child.stderr.on("data",chunk=>errors.push(String(chunk)));await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{child.kill("SIGKILL");reject(new Error("Recovery activation crash fixture deadline exceeded"));},15000);
    child.on("error",error=>{clearTimeout(timer);reject(error);});child.on("exit",(code,signal)=>{clearTimeout(timer);signal==="SIGKILL"?resolve():reject(new Error(`Unexpected recovery activation crash exit ${code}: ${errors.join("")}`));});});}

describe("Recovery candidate assembly and explicit host switching",()=>{
  it("creates a separate candidate, preserves the forensic source and appends a real pause event",async()=>{const f=await fixture(true,true),before=readFileSync(f.restoredPath);await f.prepare();
    const root=join(f.options.candidateRoot,"candidate1"),path=join(root,"database.sqlite");expect(readdirSync(root)).toEqual(expect.arrayContaining(["CANDIDATE_ONLY","READY","candidate.json","database.sqlite","asset-resource"]));
    expect(()=>createDb(path)).toThrow("active host pointer");const raw=new Database(path,{readonly:true});dbs.push(raw);expect(readFoundationRestoreFence(raw)).toBeUndefined();
    expect(raw.prepare("SELECT status,revision FROM scenario_event_streams WHERE run_id='run'").get()).toMatchObject({status:"paused",revision:6});
    expect(JSON.parse((raw.prepare("SELECT body FROM foundation_recovery_provenance WHERE id=1").get() as {body:string}).body)).toMatchObject({candidateId:"candidate1",automaticResume:false});
    expect(readFileSync(f.restoredPath)).toEqual(before);expect(readFoundationRestoreFence(f.restored)?.mode).toBe("inspection_only");});

  it("requires all current assemblies and rejects changed material before publication or switching",async()=>{const f=await fixture();const blocked=new FoundationRecoveryActivationControl({...f.options,
      assembler:{async assemble(input){return input.dependency==="model_configuration"?{decision:"blocked",reason:"Model credentials unavailable"}:{decision:"assembled",assemblyRef:"ok",materialFingerprint:input.materialFingerprint};}}},f.restored,f.fence,f.readiness);
    await expect(blocked.execute({operation:"prepare",commandId:"blocked",candidateId:"blocked",expectedReadinessDigest:f.readinessDigest,actor:"operator",reason:"Blocked assembly"})).rejects.toThrow("Model credentials unavailable");
    expect(existsSync(join(f.options.candidateRoot,"blocked","READY"))).toBe(false);await f.prepare();f.fingerprints.set("vault_key","f".repeat(64));
    expect(()=>f.control.preview({operation:"activate",candidateId:"candidate1",expectedRevision:2,expectedGeneration:0})).toThrow("stale");
    expect(()=>resolveFoundationActiveDatabase(f.restoredPath,f.options)).not.toThrow();});

  it("pins readiness identity, defaults to deny, re-authorizes replay and rejects command conflicts",async()=>{const f=await fixture();const denied=new FoundationRecoveryActivationControl({...f.options,authorizer:undefined},f.restored,f.fence,f.readiness);
    await expect(denied.execute({operation:"prepare",commandId:"denied",candidateId:"denied",expectedReadinessDigest:f.readinessDigest,actor:"operator",reason:"Denied"})).rejects.toThrow("authorization");
    await expect(f.control.execute({operation:"prepare",commandId:"wrong",candidateId:"wrong",expectedReadinessDigest:"a".repeat(64),actor:"operator",reason:"Wrong pin"})).rejects.toThrow("readiness");
    await f.prepare();expect((await f.prepare()).replayed).toBe(true);await expect(f.control.execute({operation:"prepare",commandId:"prepare_candidate1",candidateId:"other",expectedReadinessDigest:f.readinessDigest,actor:"operator",reason:"Conflict"})).rejects.toThrow("conflict");});

  it("atomically selects a candidate and allows boot only through the matching active pointer",async()=>{const f=await fixture();await f.prepare();const request=switchRequest(f.control,"activate","candidate1",2,0,"activate1"),activated=await f.control.execute(request);
    expect(activated.audit).toMatchObject({status:"completed",restartRequired:true,automaticResume:false});const selected=resolveFoundationActiveDatabase(f.restoredPath,f.options);expect(selected).toMatchObject({candidate:{candidateId:"candidate1",generation:1}});
    const active=getSqliteClient(createDb(selected.path,{activeCandidate:selected.candidate}));dbs.push(active);expect(active.readonly).toBe(false);expect(readFoundationRestoreFence(active)).toBeUndefined();
    expect(active.prepare("SELECT status FROM scenario_event_streams WHERE run_id='run'").get()).toEqual({status:"paused"});expect(()=>active.exec("DELETE FROM foundation_recovery_provenance")).toThrow("immutable");
    expect((await f.control.execute(request)).replayed).toBe(true);});

  it("boots the selected candidate through the production main path without resuming its recovered Run",async()=>{const f=await fixture();await f.prepare();await f.control.execute(switchRequest(f.control,"activate","candidate1",2,0,"activate1"));
    const app=await buildServer(f.restoredPath,join(f.root,"missing-mcp.json"),join(f.root,"missing-model.json"),f.root,undefined,{recoveryActivation:f.options});apps.push(app);
    expect((await app.inject({url:"/api/health"})).json()).toMatchObject({status:"ok",llmConfigured:false});const management=foundationHostControl(app).management().headers();
    expect((await app.inject({url:"/api/foundation/recovery/activation",headers:management})).json()).toMatchObject({active:{candidateId:"candidate1",generation:1},automaticResume:false});
    const selected=resolveFoundationActiveDatabase(f.restoredPath,f.options),active=new Database(selected.path,{readonly:true});dbs.push(active);
    expect(active.prepare("SELECT status FROM scenario_event_streams WHERE run_id='run'").get()).toEqual({status:"paused"});});

  it("rejects changed previews, unexpected candidate files and forged active pointers",async()=>{const f=await fixture();await f.prepare();const request=switchRequest(f.control,"activate","candidate1",2,0,"activate1");
    await expect(f.control.execute({...request,planFingerprint:"a".repeat(64)})).rejects.toThrow("plan changed");writeFileSync(join(f.options.candidateRoot,"candidate1","unexpected"),"x");
    expect(()=>f.control.preview({operation:"activate",candidateId:"candidate1",expectedRevision:2,expectedGeneration:0})).toThrow("Unexpected");rmSync(join(f.options.candidateRoot,"candidate1","unexpected"));
    await f.control.execute(request);writeFileSync(join(f.options.controlRoot,"ACTIVE.json"),JSON.stringify({format:1,candidateId:"other",provenanceDigest:"a".repeat(64),generation:2,previousCandidateId:null,switchedAt:"2026-09-01T00:00:00.000Z"}));
    expect(()=>resolveFoundationActiveDatabase(f.restoredPath,f.options)).toThrow();});

  it("activates a second candidate and rolls back only to the immediately previous candidate",async()=>{const f=await fixture();await f.prepare("candidate1");await f.control.execute(switchRequest(f.control,"activate","candidate1",2,0,"activate1"));
    await f.prepare("candidate2");await f.control.execute(switchRequest(f.control,"activate","candidate2",2,1,"activate2"));expect(f.control.inspect().active).toMatchObject({candidateId:"candidate2",previousCandidateId:"candidate1",generation:2});
    expect(()=>f.control.preview({operation:"rollback",candidateId:"candidate2",expectedRevision:4,expectedGeneration:2})).toThrow("immediately previous");
    await f.control.execute(switchRequest(f.control,"rollback","candidate1",4,2,"rollback1"));expect(f.control.inspect().active).toMatchObject({candidateId:"candidate1",previousCandidateId:"candidate2",generation:3});});

  it("keeps activation operations immutable and atomically rejects a failed switch audit",async()=>{const f=await fixture();await f.prepare();const request=switchRequest(f.control,"activate","candidate1",2,0,"activate1");
    f.audit.exec("CREATE TEMP TRIGGER fail_switch BEFORE INSERT ON foundation_recovery_activation_events WHEN NEW.event_type='switch_prepared' BEGIN SELECT RAISE(ABORT,'injected switch audit failure');END");
    await expect(f.control.execute(request)).rejects.toThrow("injected");expect(f.control.inspect().active).toBeNull();expect((f.audit.prepare("SELECT count(*) count FROM foundation_recovery_activation_operations WHERE command_id='activate1'").get() as {count:number}).count).toBe(0);
    f.audit.exec("DROP TRIGGER fail_switch");await f.control.execute(request);expect(()=>f.audit.exec("DELETE FROM foundation_recovery_activation_events")).toThrow("immutable");});

  it("exposes preparation and switching only through the guarded production management channel",async()=>{const f=await fixture(),app=Fastify();apps.push(app);registerSecurityAgentFoundation(app,f.restored,{} as never,f.root,()=>false,
      {recoveryReadiness:{auditDb:f.audit,authorizer:allow,currentFingerprint:item=>f.fingerprints.get(item),verifier:{async verify({dependency}){return{decision:"satisfied",evidenceRef:`review:${dependency}`,materialFingerprint:f.fingerprints.get(dependency)!,expiresAt:"2099-01-01T00:00:00.000Z"};}}},recoveryActivation:f.options});
    expect((await app.inject({url:"/api/foundation/recovery/activation"})).statusCode).toBe(401);const management=foundationHostControl(app).management().headers();
    expect((await app.inject({url:"/api/foundation/recovery/activation",headers:management})).json()).toMatchObject({sourceRestoreAvailable:true,directCandidateBoot:false,automaticResume:false});
    expect((await app.inject({method:"POST",url:"/api/foundation/recovery/unfence",headers:management,payload:{}})).statusCode).toBe(404);});

  it("reconciles a candidate published before its final audit after a real SIGKILL",async()=>{const f=await fixture(),request={operation:"prepare" as const,commandId:"crash_prepare",candidateId:"crash_candidate",
      expectedReadinessDigest:f.readinessDigest,actor:"operator",reason:"Crash publication recovery"};await crash(f.root,"prepare_published",request);
    expect(existsSync(join(f.options.candidateRoot,"crash_candidate","READY"))).toBe(true);const result=await f.control.execute(request);expect(result).toMatchObject({replayed:true,audit:{status:"prepared",automaticResume:false}});
    expect(f.control.inspect().candidates).toEqual(expect.arrayContaining([expect.objectContaining({candidateId:"crash_candidate",status:"prepared"})]));});

  it.each(["switch_prepared","switch_published","switch_completed"])("reconciles %s after a real SIGKILL without double switching",async phase=>{const f=await fixture();await f.prepare();
    const request=switchRequest(f.control,"activate","candidate1",2,0,"crash_activate");await crash(f.root,phase,request);const result=await f.control.execute(request);
    expect(result).toMatchObject({replayed:phase==="switch_prepared"?false:true,audit:{status:"completed",automaticResume:false}});expect(f.control.inspect().active).toMatchObject({candidateId:"candidate1",generation:1});
    expect((f.audit.prepare("SELECT count(*) count FROM foundation_recovery_activation_events WHERE candidate_id='candidate1' AND event_type LIKE 'switch_completed%'").get() as {count:number}).count).toBe(1);});
});
