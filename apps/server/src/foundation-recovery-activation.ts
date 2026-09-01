import { createHash, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { constants, closeSync, copyFileSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { z } from "zod";
import { canonicalJson } from "@traceforge/orchestration-core";
import { waitForCancellation } from "@traceforge/worker-runtime";
import { registerExecutionArchiveFunctions } from "./db/execution-archive.js";
import { assertFoundationRestorePublished, readFoundationRestoreFence, type FoundationRestoreFence } from "./db/foundation-restore-fence.js";
import { SqliteScenarioEventStore } from "./scenario-event-store.js";
import type { FoundationRecoveryReadinessControl } from "./foundation-recovery-readiness.js";

const id=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/),digest=z.string().regex(/^[a-f0-9]{64}$/),text=z.string().trim().min(1).max(1024);
const dependencySchema=z.enum(["vault_key","scenario_materials","context_resources","model_configuration","mcp_provider_configuration","external_effects"]);
const prepareSchema=z.object({operation:z.literal("prepare"),commandId:id,candidateId:id,expectedReadinessDigest:digest,actor:text,reason:text}).strict();
const switchSchema=z.object({operation:z.enum(["activate","rollback"]),commandId:id,candidateId:id,expectedRevision:z.number().int().nonnegative(),
  expectedGeneration:z.number().int().nonnegative(),planFingerprint:digest,actor:text,reason:text}).strict();
export const foundationRecoveryActivationRequestSchema=z.discriminatedUnion("operation",[prepareSchema,switchSchema]);
export type FoundationRecoveryActivationRequest=z.infer<typeof foundationRecoveryActivationRequestSchema>;
type ReadinessSnapshot=ReturnType<FoundationRecoveryReadinessControl["activationSnapshot"]>;
export interface FoundationRecoveryActivationOptions {
  auditDb:Database.Database;
  candidateRoot:string;
  controlRoot:string;
  authorizer?:{authorize(input:FoundationRecoveryActivationRequest):Promise<{decision:"allowed";authorizationRef:string;expiresAt:string}|{decision:"denied"}>};
  assembler?:{assemble(input:{candidateId:string;dependency:z.infer<typeof dependencySchema>;evidenceRef:string;materialFingerprint:string;expiresAt:string;
    source:Pick<FoundationRestoreFence,"restoreId"|"backupId"|"manifestDigest">}):Promise<{decision:"assembled";assemblyRef:string;materialFingerprint:string}|{decision:"blocked";reason:string}>};
  /** Re-read current host material before every preview, switch and active-host boot. */
  currentFingerprint?:(dependency:z.infer<typeof dependencySchema>)=>string|undefined;
  maximumBytes?:number;
  maximumCandidates?:number;
  timeoutMs?:number;
}
const assemblySchema=z.discriminatedUnion("decision",[
  z.object({decision:z.literal("assembled"),assemblyRef:z.string().trim().min(1).max(1024),materialFingerprint:digest}).strict(),
  z.object({decision:z.literal("blocked"),reason:z.string().trim().min(1).max(512)}).strict(),
]);
const candidateManifestSchema=z.object({format:z.literal(1),profile:z.literal("foundation-recovery-candidate-v1"),candidateId:id,
  source:z.object({restoreId:id,backupId:id,manifestDigest:digest,readinessDigest:digest}).strict(),createdAt:z.string().datetime(),
  provenanceDigest:digest,databaseInitialDigest:digest,pausedRunIds:z.array(z.string().min(1).max(256)).max(10000),
  assemblies:z.array(z.object({dependency:dependencySchema,revision:z.number().int().positive(),evidenceRef:text,materialFingerprint:digest,expiresAt:z.string().datetime(),assemblyRef:text}).strict()).length(6),
  assets:z.array(z.object({file:z.string().regex(/^asset-[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/),sha256:digest,bytes:z.number().int().nonnegative()}).strict()).max(128),
  automaticResume:z.literal(false),executionReady:z.literal(false)}).strict();
type CandidateManifest=z.infer<typeof candidateManifestSchema>;
const pointerSchema=z.object({format:z.literal(1),candidateId:id,provenanceDigest:digest,generation:z.number().int().positive(),
  previousCandidateId:id.nullable(),switchedAt:z.string().datetime()}).strict();
export type FoundationActivePointer=z.infer<typeof pointerSchema>;
const hash=(value:string|Buffer|unknown)=>createHash("sha256").update(typeof value==="string"||Buffer.isBuffer(value)?value:canonicalJson(value)).digest("hex");

function privateDirectory(path:string){const absolute=resolve(path);let current=absolute;while(true){try{if(lstatSync(current).isSymbolicLink())throw new Error("Recovery activation roots cannot contain symlinks");}
  catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}const parent=resolve(current,"..");if(parent===current)break;current=parent;}
  mkdirSync(absolute,{recursive:true,mode:0o700});if(!lstatSync(absolute).isDirectory())throw new Error("Recovery activation root must be a directory");
  if(process.platform!=="win32"&&(lstatSync(absolute).mode&0o077)!==0)throw new Error("Recovery activation roots must be private (0700)");return realpathSync(absolute);}
function bounded(path:string,maximum:number){const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const stat=fstatSync(fd);if(!stat.isFile()||stat.size>maximum)throw new Error("Recovery activation file invalid");return readFileSync(fd);}finally{closeSync(fd);}}
function fileHash(path:string,maximum:number){const body=bounded(path,maximum);return{sha256:hash(body),bytes:body.length};}
function sync(path:string){const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{fsyncSync(fd);}finally{closeSync(fd);}}
function durable(path:string,body:string){writeFileSync(path,body,{flag:"wx",mode:0o600});sync(path);}
function inside(root:string,path:string){const absolute=resolve(path);return absolute.startsWith(root+sep)&&absolute!==root;}
function requestHash(input:FoundationRecoveryActivationRequest){return hash(input);}

export class FoundationRecoveryActivationControl {
  private readonly roots:{candidate:string;control:string};private readonly maximum:number;private readonly entries:number;private readonly timeout:number;private busy=false;
  constructor(private readonly options:FoundationRecoveryActivationOptions,private readonly restored?:Database.Database,private readonly fence?:FoundationRestoreFence,
    private readonly readiness?:FoundationRecoveryReadinessControl,private readonly now=()=>new Date().toISOString()){
    if(options.auditDb.readonly||options.auditDb===restored)throw new Error("Recovery activation requires an independent writable audit database");
    this.roots={candidate:privateDirectory(options.candidateRoot),control:privateDirectory(options.controlRoot)};
    if(this.roots.candidate===this.roots.control||this.roots.candidate.startsWith(this.roots.control+sep)||this.roots.control.startsWith(this.roots.candidate+sep))throw new Error("Candidate and activation control roots must be disjoint");
    if(restored&&inside(this.roots.candidate,restored.name))throw new Error("Restored evidence cannot be inside the candidate root");
    this.maximum=options.maximumBytes??64*1024**3;this.entries=options.maximumCandidates??32;this.timeout=options.timeoutMs??300000;
    if(!Number.isSafeInteger(this.maximum)||this.maximum<1||this.maximum>64*1024**3||!Number.isSafeInteger(this.entries)||this.entries<1||this.entries>1024||!Number.isSafeInteger(this.timeout)||this.timeout<1||this.timeout>300000)throw new Error("Invalid recovery activation limits");
    options.auditDb.exec(`CREATE TABLE IF NOT EXISTS foundation_recovery_activation_operations(command_id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,request_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS foundation_recovery_activation_events(sequence INTEGER PRIMARY KEY,candidate_id TEXT NOT NULL,revision INTEGER NOT NULL,command_id TEXT NOT NULL UNIQUE,
        event_type TEXT NOT NULL,audit_json TEXT NOT NULL,UNIQUE(candidate_id,revision));
      CREATE INDEX IF NOT EXISTS foundation_recovery_activation_candidate ON foundation_recovery_activation_events(candidate_id,revision);
      CREATE TRIGGER IF NOT EXISTS foundation_recovery_activation_operation_capacity BEFORE INSERT ON foundation_recovery_activation_operations BEGIN
        SELECT CASE WHEN (SELECT count(*) FROM foundation_recovery_activation_operations)>=10000 THEN RAISE(ABORT,'Recovery activation command capacity exceeded') END;END;
      CREATE TRIGGER IF NOT EXISTS foundation_recovery_activation_event_capacity BEFORE INSERT ON foundation_recovery_activation_events BEGIN
        SELECT CASE WHEN (SELECT count(*) FROM foundation_recovery_activation_events)>=50000 OR length(CAST(NEW.audit_json AS BLOB))>16384 THEN RAISE(ABORT,'Recovery activation audit capacity exceeded') END;END;`);
    for(const table of ["foundation_recovery_activation_operations","foundation_recovery_activation_events"])for(const operation of ["UPDATE","DELETE"])
      options.auditDb.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_${operation} BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT,'Recovery activation history is immutable');END;`);
  }
  inspect(){const pointer=this.pointer();return{enabled:true,active:pointer,candidates:this.list(),automaticResume:false,directCandidateBoot:false,
    sourceRestoreAvailable:!!this.restored&&!!this.fence&&!!this.readiness,limits:{maximumBytes:this.maximum,maximumCandidates:this.entries,timeoutMs:this.timeout}};}
  list(){return readdirSync(this.roots.candidate).slice(0,this.entries+1).map(candidateId=>{try{const manifest=this.candidate(candidateId);return{candidateId,revision:this.revision(candidateId),status:this.pointer()?.candidateId===candidateId?"active":"prepared",provenanceDigest:manifest.provenanceDigest};}
    catch{return{candidateId,revision:this.revision(candidateId),status:"quarantined" as const};}});}
  audit(commandId:string){id.parse(commandId);const row=this.options.auditDb.prepare("SELECT audit_json FROM foundation_recovery_activation_events WHERE command_id=? OR substr(command_id,1,length(?)+1)=?||':' ORDER BY sequence DESC LIMIT 1").get(commandId,commandId,commandId) as {audit_json:string}|undefined;
    if(!row)throw new Error("Recovery activation audit missing");return JSON.parse(row.audit_json);}
  preview(value:unknown){const input=z.object({operation:z.enum(["activate","rollback"]),candidateId:id,expectedRevision:z.number().int().nonnegative(),expectedGeneration:z.number().int().nonnegative()}).strict().parse(value);
    const manifest=this.candidate(input.candidateId),revision=this.revision(input.candidateId),current=this.pointer(),generation=current?.generation??0;
    if(revision!==input.expectedRevision||generation!==input.expectedGeneration)throw new Error("Recovery activation preview revision changed");
    if(input.operation==="activate"&&current?.candidateId===input.candidateId)throw new Error("Candidate is already active");
    if(input.operation==="rollback"&&current?.previousCandidateId!==input.candidateId)throw new Error("Rollback target is not the immediately previous active candidate");
    const plan={operation:input.operation,candidateId:input.candidateId,candidateRevision:revision,currentCandidateId:current?.candidateId??null,
      expectedGeneration:generation,nextGeneration:generation+1,provenanceDigest:manifest.provenanceDigest,automaticResume:false};
    return{...plan,planFingerprint:hash(plan)};}
  async execute(value:unknown){const input=foundationRecoveryActivationRequestSchema.parse(structuredClone(value)),fingerprint=requestHash(input);
    const old=this.options.auditDb.prepare("SELECT request_hash FROM foundation_recovery_activation_operations WHERE command_id=?").get(input.commandId) as {request_hash:string}|undefined;
    if(old&&old.request_hash!==fingerprint)throw new Error("Recovery activation command conflict");
    const grant=structuredClone(await waitForCancellation(()=>this.options.authorizer?.authorize(structuredClone(input))??Promise.resolve({decision:"denied" as const}),AbortSignal.timeout(10000)));
    const authorized=()=>{if(grant.decision!=="allowed"||!grant.authorizationRef?.trim()||grant.authorizationRef.length>1024||!(Date.parse(grant.expiresAt)>Date.parse(this.now())))throw new Error("Recovery activation authorization denied or expired");};authorized();
    if(old){authorized();return this.recoverReplay(input);}
    if(this.busy)throw new Error("Recovery activation control busy");this.busy=true;try{return input.operation==="prepare"?await this.prepare(input,grant):this.switch(input,grant);}finally{this.busy=false;}}
  private async prepare(input:z.infer<typeof prepareSchema>,grant:{decision:"allowed";authorizationRef:string;expiresAt:string}|{decision:"denied"}){
    if(!this.restored||!this.fence||!this.readiness)throw new Error("Candidate preparation is available only on the inspection host");
    const restored=this.restored,fence=this.fence,snapshot=this.readiness.activationSnapshot(input.expectedReadinessDigest);if(snapshot.restoreId!==fence.restoreId)throw new Error("Recovery readiness source mismatch");
    assertFoundationRestorePublished(restored,fence);if(readdirSync(this.roots.candidate).length>=this.entries)throw new Error("Recovery candidate capacity exceeded");
    const sourceBytes=statSync(restored.name).size;if(sourceBytes>this.maximum)throw new Error("Recovery candidate byte capacity exceeded");
    const destination=join(this.roots.candidate,input.candidateId);
    const started={operation:"prepare",candidateId:input.candidateId,restoreId:fence.restoreId,readinessDigest:snapshot.readinessDigest,authorizationRef:grant.decision==="allowed"?grant.authorizationRef:"",at:this.now()};
    this.options.auditDb.transaction(()=>{this.insertOperation(input);this.event(input.candidateId,input.commandId,"started",started);})();
    mkdirSync(destination,{mode:0o700});sync(this.roots.candidate);durable(join(destination,"CANDIDATE_ONLY"),"Requires an active recovery pointer");
    const deadline=Date.now()+this.timeout,assemblies:CandidateManifest["assemblies"]=[];
    for(const proof of snapshot.dependencies){if(Date.now()>=deadline)throw new Error("Recovery candidate preparation deadline exceeded");
      const result=assemblySchema.parse(structuredClone(await waitForCancellation(()=>this.options.assembler?.assemble({candidateId:input.candidateId,dependency:proof.dependency,
        evidenceRef:proof.evidenceRef,materialFingerprint:proof.materialFingerprint,expiresAt:proof.expiresAt,source:{restoreId:fence.restoreId,backupId:fence.backupId,manifestDigest:fence.manifestDigest}})
        ??Promise.resolve({decision:"blocked" as const,reason:"No trusted recovery dependency assembler configured"}),AbortSignal.timeout(Math.min(30000,Math.max(1,deadline-Date.now()))))));
      if(result.decision==="blocked")throw new Error(`Recovery dependency assembly blocked: ${result.reason}`);
      if(result.materialFingerprint!==proof.materialFingerprint)throw new Error("Recovery dependency changed during assembly");assemblies.push({...proof,assemblyRef:result.assemblyRef});}
    const database=join(destination,"database.sqlite");await restored.backup(database);const restoredRoot=dirname(restored.name);
    const sourceManifest=JSON.parse(bounded(join(restoredRoot,"manifest.json"),128*1024).toString()) as {assets?:{id:string;sha256:string;bytes:number}[]};
    const assets:CandidateManifest["assets"]=[];for(const asset of sourceManifest.assets??[]){const file=`asset-${id.parse(asset.id)}`;copyFileSync(join(restoredRoot,file),join(destination,file),constants.COPYFILE_EXCL);
      const found=fileHash(join(destination,file),this.maximum);if(found.sha256!==asset.sha256||found.bytes!==asset.bytes)throw new Error("Recovery candidate attachment changed");assets.push({file,...found});}
    const candidate=new Database(database);let pausedRunIds:string[]=[],provenanceDigest="";try{registerExecutionArchiveFunctions(candidate);const candidateFence=readFoundationRestoreFence(candidate);if(!candidateFence||canonicalJson(candidateFence)!==canonicalJson(fence))throw new Error("Recovery candidate fence source mismatch");
      candidate.transaction(()=>{candidate.exec("DROP TRIGGER foundation_restore_fence_INSERT;DROP TRIGGER foundation_restore_fence_UPDATE;DROP TRIGGER foundation_restore_fence_DELETE;DROP TABLE foundation_restore_fence");
        candidate.exec("CREATE TABLE foundation_recovery_provenance(id INTEGER PRIMARY KEY CHECK(id=1),body TEXT NOT NULL);CREATE TABLE foundation_recovery_candidate_guard(id INTEGER PRIMARY KEY CHECK(id=1),candidate_id TEXT NOT NULL,provenance_digest TEXT NOT NULL)");})();
      const events=new SqliteScenarioEventStore(candidate),at=this.now();pausedRunIds=events.listRuns().filter(run=>run.status==="running").map(run=>run.runId);
      for(const runId of pausedRunIds){const revision=events.revision(runId),event={type:"run_paused" as const,reason:"Recovered candidate requires explicit operator resume",requestedBy:"system" as const,at};
        events.append({runId,commandId:`foundation-recovery-pause-${input.candidateId}`,fingerprint:hash({runId,revision,event}),expectedRevision:revision,events:[event]});}
      const provenance={candidateId:input.candidateId,source:snapshot,assemblies,createdAt:this.now(),automaticResume:false};provenanceDigest=hash(provenance);
      candidate.transaction(()=>{candidate.prepare("INSERT INTO foundation_recovery_provenance VALUES (1,?)").run(canonicalJson(provenance));candidate.prepare("INSERT INTO foundation_recovery_candidate_guard VALUES (1,?,?)").run(input.candidateId,provenanceDigest);
        for(const table of ["foundation_recovery_provenance","foundation_recovery_candidate_guard"])for(const operation of ["INSERT","UPDATE","DELETE"])
          candidate.exec(`CREATE TRIGGER ${table}_${operation} BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT,'Recovery candidate provenance is immutable');END;`);})();
      candidate.pragma("wal_checkpoint(TRUNCATE)");candidate.close();
      const databaseInitialDigest=fileHash(database,this.maximum).sha256;
      const manifestWithoutDigest={format:1 as const,profile:"foundation-recovery-candidate-v1" as const,candidateId:input.candidateId,
        source:{restoreId:snapshot.restoreId,backupId:snapshot.backupId,manifestDigest:snapshot.manifestDigest,readinessDigest:snapshot.readinessDigest},createdAt:this.now(),
        databaseInitialDigest,pausedRunIds,assemblies,assets,automaticResume:false as const,executionReady:false as const};
      const manifest:CandidateManifest={...manifestWithoutDigest,provenanceDigest};const body=canonicalJson(manifest);durable(join(destination,"candidate.json"),body);durable(join(destination,"READY"),hash(body));sync(destination);
      const audit={...started,status:"prepared",provenanceDigest,databaseInitialDigest,pausedRunIds,assemblies:assemblies.map(a=>({dependency:a.dependency,revision:a.revision,assemblyRef:a.assemblyRef,materialFingerprint:a.materialFingerprint})),at:this.now(),automaticResume:false};
      this.event(input.candidateId,input.commandId,"prepared",audit,true);return{audit,replayed:false,...this.inspect()};
    }catch(error){if(candidate.open)candidate.close();throw error;}}
  private recoverReplay(input:FoundationRecoveryActivationRequest){if(input.operation==="prepare"){
      const manifest=this.candidate(input.candidateId);if(manifest.source.readinessDigest!==input.expectedReadinessDigest)throw new Error("Published recovery candidate no longer matches the command");
      const latest=this.audit(input.commandId) as {status?:string};if(latest.status!=="prepared")this.event(input.candidateId,input.commandId,"prepared_reconciled",{operation:"prepare",candidateId:input.candidateId,
        status:"prepared",provenanceDigest:manifest.provenanceDigest,pausedRunIds:manifest.pausedRunIds,at:this.now(),automaticResume:false},true);
      return{audit:this.audit(input.commandId),replayed:true,...this.inspect()};}
    const manifest=this.candidate(input.candidateId);let pointer=this.pointer(),alreadySwitched=pointer?.candidateId===input.candidateId&&pointer.generation===input.expectedGeneration+1;
    const priorCandidateId=alreadySwitched?pointer!.previousCandidateId:pointer?.candidateId??null;
    const plan={operation:input.operation,candidateId:input.candidateId,candidateRevision:input.expectedRevision,currentCandidateId:priorCandidateId,
      expectedGeneration:input.expectedGeneration,nextGeneration:input.expectedGeneration+1,provenanceDigest:manifest.provenanceDigest,automaticResume:false};
    if(hash(plan)!==input.planFingerprint)throw new Error("Recovery activation replay plan changed");
    if(!alreadySwitched){if((pointer?.generation??0)!==input.expectedGeneration)throw new Error("Recovery activation pointer changed after prepared switch");
      this.writePointer({format:1,candidateId:input.candidateId,provenanceDigest:manifest.provenanceDigest,generation:input.expectedGeneration+1,
        previousCandidateId:pointer?.candidateId??null,switchedAt:this.now()},input.commandId);pointer=this.pointer();}
    const latest=this.audit(input.commandId) as {status?:string};if(latest.status!=="completed")this.event(input.candidateId,input.commandId,"switch_completed_reconciled",{operation:input.operation,
      candidateId:input.candidateId,status:"completed",generation:pointer!.generation,at:this.now(),restartRequired:true,automaticResume:false},true);
    return{audit:this.audit(input.commandId),replayed:true,...this.inspect()};}
  private switch(input:z.infer<typeof switchSchema>,grant:{decision:"allowed";authorizationRef:string;expiresAt:string}|{decision:"denied"}){
    const plan=this.preview({operation:input.operation,candidateId:input.candidateId,expectedRevision:input.expectedRevision,expectedGeneration:input.expectedGeneration});
    if(plan.planFingerprint!==input.planFingerprint)throw new Error("Recovery activation plan changed");const current=this.pointer();
    const prepared={operation:input.operation,candidateId:input.candidateId,planFingerprint:input.planFingerprint,fromCandidateId:current?.candidateId??null,
      generation:plan.nextGeneration,authorizationRef:grant.decision==="allowed"?grant.authorizationRef:"",at:this.now(),automaticResume:false};
    this.options.auditDb.transaction(()=>{this.insertOperation(input);this.event(input.candidateId,input.commandId,"switch_prepared",prepared);})();
    this.writePointer({format:1,candidateId:input.candidateId,provenanceDigest:plan.provenanceDigest,generation:plan.nextGeneration,
      previousCandidateId:current?.candidateId??null,switchedAt:this.now()},input.commandId);
    const audit={...prepared,status:"completed",restartRequired:true};this.event(input.candidateId,input.commandId,"switch_completed",audit,true);return{audit,replayed:false,...this.inspect()};}
  private candidate(candidateId:string){id.parse(candidateId);const root=join(this.roots.candidate,candidateId);if(!inside(this.roots.candidate,root)||lstatSync(root).isSymbolicLink())throw new Error("Invalid recovery candidate root");
    const body=bounded(join(root,"candidate.json"),256*1024),ready=bounded(join(root,"READY"),64).toString();if(hash(body)!==ready)throw new Error("Recovery candidate publication mismatch");
    const manifest=candidateManifestSchema.parse(JSON.parse(body.toString()));if(manifest.candidateId!==candidateId)throw new Error("Recovery candidate identity mismatch");
    for(const assembly of manifest.assemblies){if(Date.parse(assembly.expiresAt)<=Date.parse(this.now()))throw new Error(`Recovery assembly proof expired: ${assembly.dependency}`);
      if(this.options.currentFingerprint?.(assembly.dependency)!==assembly.materialFingerprint)throw new Error(`Recovery assembly is missing or stale: ${assembly.dependency}`);}
    const expected=["CANDIDATE_ONLY","READY","candidate.json","database.sqlite",...manifest.assets.map(a=>a.file)],actual=readdirSync(root);
    const active=this.pointer()?.candidateId===candidateId,allowed=active?[...expected,"database.sqlite-wal","database.sqlite-shm"]:expected;
    if(actual.some(name=>!allowed.includes(name))||expected.some(name=>!actual.includes(name)))throw new Error("Unexpected recovery candidate files");
    for(const asset of manifest.assets){const found=fileHash(join(root,asset.file),this.maximum);if(found.sha256!==asset.sha256||found.bytes!==asset.bytes)throw new Error("Recovery candidate attachment mismatch");}
    const db=new Database(join(root,"database.sqlite"),{readonly:true,fileMustExist:true});try{registerExecutionArchiveFunctions(db);if(readFoundationRestoreFence(db))throw new Error("Recovery candidate still has an inspection fence");
      const guard=db.prepare("SELECT candidate_id,provenance_digest FROM foundation_recovery_candidate_guard WHERE id=1").get() as {candidate_id:string;provenance_digest:string}|undefined;
      if(!guard||guard.candidate_id!==candidateId||guard.provenance_digest!==manifest.provenanceDigest)throw new Error("Recovery candidate provenance mismatch");}finally{db.close();}return manifest;}
  private pointer(){const path=join(this.roots.control,"ACTIVE.json");if(!existsSync(path))return null;return pointerSchema.parse(JSON.parse(bounded(path,4096).toString()));}
  private writePointer(pointer:FoundationActivePointer,commandId:string){this.candidate(pointer.candidateId);const temporary=join(this.roots.control,`.ACTIVE-${commandId}-${randomUUID()}.tmp`);
    durable(temporary,canonicalJson(pointer));renameSync(temporary,join(this.roots.control,"ACTIVE.json"));sync(this.roots.control);}
  private revision(candidateId:string){return(this.options.auditDb.prepare("SELECT count(*) count FROM foundation_recovery_activation_events WHERE candidate_id=?").get(candidateId) as {count:number}).count;}
  private insertOperation(input:FoundationRecoveryActivationRequest){this.options.auditDb.prepare("INSERT INTO foundation_recovery_activation_operations VALUES (?,?,?)").run(input.commandId,requestHash(input),canonicalJson(input));}
  private event(candidateId:string,commandId:string,eventType:string,audit:unknown,separate=false){const insert=()=>this.options.auditDb.prepare("INSERT INTO foundation_recovery_activation_events(candidate_id,revision,command_id,event_type,audit_json) VALUES (?,?,?,?,?)")
    .run(candidateId,this.revision(candidateId)+1,separate?`${commandId}:${eventType}`:commandId,eventType,canonicalJson(audit));if(separate)insert();else insert();}
}

export function resolveFoundationActiveDatabase(configuredPath:string,options?:FoundationRecoveryActivationOptions){if(!options)return{path:configuredPath};
  const candidateRoot=privateDirectory(options.candidateRoot),controlRoot=privateDirectory(options.controlRoot),pointerPath=join(controlRoot,"ACTIVE.json");if(!existsSync(pointerPath))return{path:configuredPath};
  const pointer=pointerSchema.parse(JSON.parse(bounded(pointerPath,4096).toString())),root=join(candidateRoot,pointer.candidateId),path=join(root,"database.sqlite");
  const manifest=candidateManifestSchema.parse(JSON.parse(bounded(join(root,"candidate.json"),256*1024).toString()));
  if(manifest.candidateId!==pointer.candidateId||manifest.provenanceDigest!==pointer.provenanceDigest||bounded(join(root,"READY"),64).toString()!==hash(canonicalJson(manifest)))throw new Error("Active recovery pointer publication mismatch");
  for(const assembly of manifest.assemblies){if(Date.parse(assembly.expiresAt)<=Date.now())throw new Error(`Active recovery assembly proof expired: ${assembly.dependency}`);
    if(options.currentFingerprint?.(assembly.dependency)!==assembly.materialFingerprint)throw new Error(`Active recovery assembly is missing or stale: ${assembly.dependency}`);}
  if(!inside(candidateRoot,path))throw new Error("Active recovery candidate path escaped its root");return{path,candidate:{candidateId:pointer.candidateId,provenanceDigest:pointer.provenanceDigest,generation:pointer.generation}};}

export function assertRecoveryCandidateBoot(path:string,authorization?:{candidateId:string;provenanceDigest:string;generation:number}){if(path===":memory:"||!existsSync(join(dirname(path),"CANDIDATE_ONLY")))return;
  if(!authorization)throw new Error("Recovery candidate is not bootable without the active host pointer");const manifest=candidateManifestSchema.parse(JSON.parse(bounded(join(dirname(path),"candidate.json"),256*1024).toString()));
  if(manifest.candidateId!==authorization.candidateId||manifest.provenanceDigest!==authorization.provenanceDigest||bounded(join(dirname(path),"READY"),64).toString()!==hash(canonicalJson(manifest)))
    throw new Error("Active recovery candidate authorization mismatch");}

export function assertRecoveryCandidateDatabase(sqlite:Database.Database,authorization?:{candidateId:string;provenanceDigest:string;generation:number}){const table=sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='foundation_recovery_candidate_guard'").get();
  if(!table){if(authorization)throw new Error("Active pointer does not reference a recovery candidate");return;}if(!authorization)throw new Error("Recovery candidate database lacks active pointer authorization");
  const row=sqlite.prepare("SELECT candidate_id,provenance_digest FROM foundation_recovery_candidate_guard WHERE id=1").get() as {candidate_id:string;provenance_digest:string}|undefined;
  if(!row||row.candidate_id!==authorization.candidateId||row.provenance_digest!==authorization.provenanceDigest)throw new Error("Recovery candidate database provenance mismatch");}

export function registerFoundationRecoveryActivationRoutes(app:FastifyInstance,control:FoundationRecoveryActivationControl){app.get("/api/foundation/recovery/activation",async()=>control.inspect());
  app.get("/api/foundation/recovery/activation/audit",async(req,reply)=>{try{return control.audit(z.object({commandId:id}).strict().parse(req.query).commandId);}catch(error){return reply.code(error instanceof z.ZodError?400:409).send({error:error instanceof Error?error.message.slice(0,512):"Recovery activation audit failed"});}});
  app.post("/api/foundation/recovery/activation/preview",async(req,reply)=>{try{return control.preview(req.body);}catch(error){return reply.code(error instanceof z.ZodError?400:409).send({error:error instanceof Error?error.message.slice(0,512):"Recovery activation preview failed"});}});
  app.post("/api/foundation/recovery/activation/execute",async(req,reply)=>{try{return await control.execute(req.body);}catch(error){return reply.code(error instanceof z.ZodError?400:409).send({error:error instanceof Error?error.message.slice(0,512):"Recovery activation failed"});}});}
