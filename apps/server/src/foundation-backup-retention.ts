import { existsSync, lstatSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { canonicalJson } from "@traceforge/orchestration-core";
import { waitForCancellation } from "@traceforge/worker-runtime";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { FoundationBackupControl, foundationBackupDigestSchema as digest, foundationBackupIdSchema as id } from "./foundation-backup.js";
import { FoundationOfflineMediaControl } from "./foundation-offline-media.js";

const text=z.string().trim().min(1).max(256);
const scope=z.object({kind:z.enum(["backup","media"]),id,digest}).strict();
const previewSchema=scope.extend({operation:z.enum(["hold","release","purge"]),expectedRevision:z.number().int().nonnegative()}).strict();
const requestSchema=previewSchema.extend({commandId:id,actor:text,reason:z.string().trim().min(1).max(1024),planFingerprint:digest}).strict();
export type FoundationRetentionRequest=z.infer<typeof requestSchema>;
export interface FoundationRetentionAuthorizer {authorize(input:FoundationRetentionRequest):Promise<
  {decision:"allowed";authorizationRef:string;expiresAt:string}|{decision:"denied"}>}
interface Target {kind:"backup"|"media";id:string;digest:string;root:string;files:string[]}
const hash=(value:unknown)=>createHash("sha256").update(canonicalJson(value)).digest("hex");

/** Default-hold, two-step retention lifecycle. Purge is exact-file deletion, not a claim of physical secure erase. */
export class FoundationBackupRetentionControl {
  constructor(private readonly sqlite:Database.Database,private readonly backups:FoundationBackupControl,
    private readonly media:FoundationOfflineMediaControl|undefined,private readonly authorizer?:FoundationRetentionAuthorizer,
    private readonly now=()=>new Date().toISOString()){
    sqlite.exec(`CREATE TABLE IF NOT EXISTS foundation_retention_operations(command_id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,request_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS foundation_retention_events(sequence INTEGER PRIMARY KEY,target_key TEXT NOT NULL,revision INTEGER NOT NULL,
        command_id TEXT NOT NULL UNIQUE,operation TEXT NOT NULL,audit_json TEXT NOT NULL,UNIQUE(target_key,revision));
      CREATE TABLE IF NOT EXISTS foundation_retention_purge_steps(sequence INTEGER PRIMARY KEY,command_id TEXT NOT NULL,phase TEXT NOT NULL,body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS foundation_retention_target ON foundation_retention_events(target_key,revision);
      CREATE INDEX IF NOT EXISTS foundation_retention_purge_command ON foundation_retention_purge_steps(command_id,sequence);
      CREATE TRIGGER IF NOT EXISTS foundation_retention_operation_capacity BEFORE INSERT ON foundation_retention_operations BEGIN
        SELECT CASE WHEN (SELECT count(*) FROM foundation_retention_operations)>=10000 THEN RAISE(ABORT,'Retention command capacity exceeded') END;
        SELECT execution_physical_admit(recovery_floor,maximum_database_bytes,maximum_wal_bytes,32768,'recovery') FROM execution_physical_policy WHERE id=1;END;
      CREATE TRIGGER IF NOT EXISTS foundation_retention_event_capacity BEFORE INSERT ON foundation_retention_events BEGIN
        SELECT CASE WHEN (SELECT count(*) FROM foundation_retention_events)>=50000 OR length(CAST(NEW.audit_json AS BLOB))>8192 THEN RAISE(ABORT,'Retention audit capacity exceeded') END;END;
      CREATE TRIGGER IF NOT EXISTS foundation_retention_step_capacity BEFORE INSERT ON foundation_retention_purge_steps BEGIN
        SELECT CASE WHEN (SELECT count(*) FROM foundation_retention_purge_steps)>=10000 OR length(CAST(NEW.body AS BLOB))>2097152
          OR (SELECT coalesce(sum(length(CAST(body AS BLOB))),0) FROM foundation_retention_purge_steps)+length(CAST(NEW.body AS BLOB))>268435456
          THEN RAISE(ABORT,'Retention purge audit capacity exceeded') END;
        SELECT execution_physical_admit(recovery_floor,maximum_database_bytes,maximum_wal_bytes,length(CAST(NEW.body AS BLOB))+4096,'recovery') FROM execution_physical_policy WHERE id=1;END;`);
    for(const table of ["foundation_retention_operations","foundation_retention_events","foundation_retention_purge_steps"])
      for(const operation of ["UPDATE","DELETE"])sqlite.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_${operation} BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT,'Retention history is immutable');END;`);
  }
  inspect(value:unknown){const input=scope.parse(value),state=this.state(input);return{...input,...state,automaticDeletion:false,secureEraseCertified:false};}
  inventory(){const roots=[{kind:"backup" as const,path:this.backups.trustedBackupRoot()},...(this.media?[{kind:"media" as const,path:this.media.trustedMediaRoot()}]:[])];
    return roots.flatMap(root=>readdirSync(root.path).slice(0,1025).map(name=>({kind:root.kind,id:name,
      publication:existsSync(join(root.path,name,"READY"))?"published_unverified":"quarantined",automaticDeletion:false}))).slice(0,2048);}
  preview(value:unknown){const input=previewSchema.parse(value),target=this.target(input),state=this.state(input);
    if(state.revision!==input.expectedRevision)throw new Error("Retention revision conflict");
    if(input.operation==="release"&&state.status!=="forensic_hold")throw new Error("Only forensic hold can be released");
    if(input.operation==="hold"&&state.status!=="destroyable")throw new Error("Only a destroyable target can return to hold");
    if(input.operation==="purge"&&state.status!=="destroyable")throw new Error("Target must be explicitly released before purge");
    const plan={...input,resultingRevision:state.revision+1,resultingStatus:input.operation==="release"?"destroyable":input.operation==="hold"?"forensic_hold":"purged",
      filesDigest:hash(target.files),fileCount:target.files.length,secureEraseCertified:false,automaticDeletion:false};
    return{...plan,planFingerprint:hash(plan)};
  }
  audit(commandId:string){id.parse(commandId);return{event:this.sqlite.prepare("SELECT * FROM foundation_retention_events WHERE command_id=?").get(commandId)??null,
    purge:this.sqlite.prepare("SELECT sequence,phase,body FROM foundation_retention_purge_steps WHERE command_id=? ORDER BY sequence LIMIT 8").all(commandId)};}
  async execute(value:unknown){const input=requestSchema.parse(structuredClone(value)),requestHash=hash(input);
    const grant=structuredClone(await waitForCancellation(()=>this.authorizer?.authorize(structuredClone(input))??Promise.resolve({decision:"denied" as const}),AbortSignal.timeout(10000)));
    const authorized=()=>{if(grant.decision!=="allowed"||!grant.authorizationRef?.trim()||grant.authorizationRef.length>1024||!(Date.parse(grant.expiresAt)>Date.parse(this.now())))throw new Error("Retention authorization denied or expired");};authorized();
    const existing=this.sqlite.prepare("SELECT request_hash FROM foundation_retention_operations WHERE command_id=?").get(input.commandId) as {request_hash:string}|undefined;
    if(existing){if(existing.request_hash!==requestHash)throw new Error("Retention command conflict");const event=this.sqlite.prepare("SELECT audit_json FROM foundation_retention_events WHERE command_id=?").get(input.commandId) as {audit_json:string}|undefined;
      if(event)return{audit:JSON.parse(event.audit_json),replayed:true};if(input.operation!=="purge")throw new Error("Interrupted retention command requires inspection");return this.finishPurge(input,true,authorized);}
    const preview=this.preview({kind:input.kind,id:input.id,digest:input.digest,operation:input.operation,expectedRevision:input.expectedRevision});
    if(preview.planFingerprint!==input.planFingerprint)throw new Error("Retention plan changed");authorized();
    this.sqlite.transaction(()=>{this.sqlite.prepare("INSERT INTO foundation_retention_operations VALUES (?,?,?)").run(input.commandId,requestHash,canonicalJson(input));
      if(input.operation==="purge"){const target=this.target(input),body=canonicalJson({target:{kind:target.kind,id:target.id,digest:target.digest,root:target.root,files:target.files},authorizationRef:grant.decision==="allowed"?grant.authorizationRef:"",at:this.now()});
        this.sqlite.prepare("INSERT INTO foundation_retention_purge_steps(command_id,phase,body) VALUES (?, 'prepared', ?)").run(input.commandId,body);}
      else this.commitEvent(input,preview,grant.decision==="allowed"?grant.authorizationRef:"");})();
    if(input.operation!=="purge")return{audit:JSON.parse((this.sqlite.prepare("SELECT audit_json FROM foundation_retention_events WHERE command_id=?").get(input.commandId) as {audit_json:string}).audit_json),replayed:false};
    return this.finishPurge(input,false,authorized);
  }
  private finishPurge(input:FoundationRetentionRequest,replayed:boolean,authorized:()=>void){const row=this.sqlite.prepare("SELECT body FROM foundation_retention_purge_steps WHERE command_id=? AND phase='prepared'").get(input.commandId) as {body:string}|undefined;
    if(!row)throw new Error("Purge preparation missing");const prepared=JSON.parse(row.body) as {target:Target;authorizationRef:string};const target=prepared.target;
    authorized();const deadline=Date.now()+60000;
    if(existsSync(target.root)){const rootStat=lstatSync(target.root);if(rootStat.isSymbolicLink()||!rootStat.isDirectory())throw new Error("Purge root changed or is unsafe");
      if(target.files.every(name=>existsSync(join(target.root,name)))){const current=this.target(input);if(current.root!==target.root||canonicalJson(current.files)!==canonicalJson(target.files))throw new Error("Purge target changed after authorization");}}
    for(let index=0;index<target.files.length;index++){if(index%128===0){authorized();if(Date.now()>=deadline)throw new Error("Retention purge deadline exceeded");}const path=join(target.root,target.files[index]!);
      if(!existsSync(path))continue;const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink())throw new Error("Purge target changed or contains unsafe file");unlinkSync(path);}
    if(existsSync(target.root)){if(readdirSync(target.root).length)throw new Error("Purge target contains unreviewed residue");rmdirSync(target.root);}
    if(!this.sqlite.prepare("SELECT 1 FROM foundation_retention_purge_steps WHERE command_id=? AND phase='files_removed'").get(input.commandId))
      this.sqlite.prepare("INSERT INTO foundation_retention_purge_steps(command_id,phase,body) VALUES (?, 'files_removed', ?)").run(input.commandId,canonicalJson({at:this.now(),secureEraseCertified:false}));
    const preview={...this.previewForPurged(input),planFingerprint:input.planFingerprint};this.sqlite.transaction(()=>this.commitEvent(input,preview,prepared.authorizationRef))();
    return{audit:JSON.parse((this.sqlite.prepare("SELECT audit_json FROM foundation_retention_events WHERE command_id=?").get(input.commandId) as {audit_json:string}).audit_json),replayed};
  }
  private previewForPurged(input:FoundationRetentionRequest){const state=this.state(input);if(state.revision!==input.expectedRevision||state.status!=="destroyable")throw new Error("Retention state changed during purge");
    return{...input,resultingRevision:state.revision+1,resultingStatus:"purged",filesDigest:"removed",fileCount:0,secureEraseCertified:false,automaticDeletion:false};}
  private commitEvent(input:FoundationRetentionRequest,plan:{resultingRevision:number;resultingStatus:string},authorizationRef:string){const audit={...input,resultingRevision:plan.resultingRevision,resultingStatus:plan.resultingStatus,
    authorizationRef,at:this.now(),automaticDeletion:false,secureEraseCertified:false};this.sqlite.prepare("INSERT INTO foundation_retention_events(target_key,revision,command_id,operation,audit_json) VALUES (?,?,?,?,?)")
      .run(this.key(input),plan.resultingRevision,input.commandId,input.operation,canonicalJson(audit));}
  private state(input:{kind:string;id:string;digest:string}){const row=this.sqlite.prepare("SELECT revision,operation FROM foundation_retention_events WHERE target_key=? ORDER BY revision DESC LIMIT 1").get(this.key(input)) as {revision:number;operation:string}|undefined;
    const status:"forensic_hold"|"destroyable"|"purged"=row?.operation==="release"?"destroyable":row?.operation==="purge"?"purged":"forensic_hold";return{revision:row?.revision??0,status};}
  private target(input:{kind:"backup"|"media";id:string;digest:string}):Target{return input.kind==="backup"?this.backups.retentionTarget(input.id,input.digest):this.requiredMedia().retentionTarget(input.id,input.digest);}
  private requiredMedia(){if(!this.media)throw new Error("Offline media control unavailable");return this.media;}
  private key(input:{kind:string;id:string;digest:string}){return canonicalJson([input.kind,input.id,input.digest]);}
}

export function registerFoundationRetentionRoutes(app:FastifyInstance,control:FoundationBackupRetentionControl){const route=(suffix:string,method:"GET"|"POST",handler:(value:unknown)=>unknown)=>app.route({method,
  url:`/api/foundation/retention${suffix}`,handler:async(req,reply)=>{try{return await handler(method==="GET"?req.query:req.body);}catch(error){return reply.code(error instanceof z.ZodError?400:409).send({error:error instanceof Error?error.message.slice(0,512):"Retention unavailable"});}}});
  route("","GET",value=>control.inspect(value));route("/inventory","GET",()=>control.inventory());route("/preview","POST",value=>control.preview(value));
  route("/execute","POST",value=>control.execute(value));route("/audit","GET",value=>control.audit(z.object({commandId:id}).strict().parse(value).commandId));}
