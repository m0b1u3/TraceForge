import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { canonicalJson } from "@traceforge/orchestration-core";
import { waitForCancellation } from "@traceforge/worker-runtime";
import type { FoundationRestoreFence } from "./db/foundation-restore-fence.js";

export const recoveryDependencySchema=z.enum(["vault_key","scenario_materials","context_resources","model_configuration","mcp_provider_configuration","external_effects"]);
export type RecoveryDependency=z.infer<typeof recoveryDependencySchema>;
const id=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/),text=z.string().trim().min(1).max(256),digest=z.string().regex(/^[a-f0-9]{64}$/);
const requestSchema=z.object({commandId:id,dependency:recoveryDependencySchema,operation:z.enum(["attest","revoke"]),expectedRevision:z.number().int().nonnegative(),
  actor:text,reason:z.string().trim().min(1).max(1024)}).strict();
const verifierResultSchema=z.discriminatedUnion("decision",[
  z.object({decision:z.literal("satisfied"),evidenceRef:z.string().trim().min(1).max(1024),materialFingerprint:digest,expiresAt:z.string().datetime()}).strict(),
  z.object({decision:z.literal("blocked"),reason:z.string().trim().min(1).max(512)}).strict(),
]);
export type FoundationReadinessRequest=z.infer<typeof requestSchema>;
export interface FoundationRecoveryReadinessOptions {
  auditDb:Database.Database;
  authorizer?:{authorize(input:FoundationReadinessRequest):Promise<{decision:"allowed";authorizationRef:string;expiresAt:string}|{decision:"denied"}>};
  verifier?:{verify(input:{dependency:RecoveryDependency;fence:FoundationRestoreFence}):Promise<
    {decision:"satisfied";evidenceRef:string;materialFingerprint:string;expiresAt:string}|{decision:"blocked";reason:string}>};
  currentFingerprint?:(dependency:RecoveryDependency)=>string|undefined;
}
const dependencies=recoveryDependencySchema.options,hash=(value:unknown)=>createHash("sha256").update(canonicalJson(value)).digest("hex");

/** A durable checklist beside, never inside, the immutable restored database. It has no fence-removal operation. */
export class FoundationRecoveryReadinessControl {
  private readonly control:Database.Database;
  constructor(private readonly restored:Database.Database,private readonly fence:FoundationRestoreFence,private readonly options:FoundationRecoveryReadinessOptions,
    private readonly now=()=>new Date().toISOString()){
    if(options.auditDb===restored||options.auditDb.name===restored.name||options.auditDb.readonly)throw new Error("Recovery readiness requires an independent writable audit database");this.control=options.auditDb;
    this.control.exec(`CREATE TABLE IF NOT EXISTS foundation_recovery_readiness_operations(command_id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,request_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS foundation_recovery_readiness_events(sequence INTEGER PRIMARY KEY,restore_id TEXT NOT NULL,dependency TEXT NOT NULL,revision INTEGER NOT NULL,
        command_id TEXT NOT NULL UNIQUE,operation TEXT NOT NULL,audit_json TEXT NOT NULL,UNIQUE(restore_id,dependency,revision));
      CREATE INDEX IF NOT EXISTS foundation_readiness_scope ON foundation_recovery_readiness_events(restore_id,dependency,revision);
      CREATE TRIGGER IF NOT EXISTS foundation_readiness_operation_capacity BEFORE INSERT ON foundation_recovery_readiness_operations BEGIN
        SELECT CASE WHEN (SELECT count(*) FROM foundation_recovery_readiness_operations)>=10000 THEN RAISE(ABORT,'Recovery readiness command capacity exceeded') END;END;
      CREATE TRIGGER IF NOT EXISTS foundation_readiness_event_capacity BEFORE INSERT ON foundation_recovery_readiness_events BEGIN
        SELECT CASE WHEN (SELECT count(*) FROM foundation_recovery_readiness_events)>=50000 OR length(CAST(NEW.audit_json AS BLOB))>8192 THEN RAISE(ABORT,'Recovery readiness audit capacity exceeded') END;END;`);
    for(const table of ["foundation_recovery_readiness_operations","foundation_recovery_readiness_events"])for(const operation of ["UPDATE","DELETE"])
      this.control.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_${operation} BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT,'Recovery readiness history is immutable');END;`);
  }
  inspect(){const items=dependencies.map(dependency=>this.state(dependency)),externalBlockers=this.externalBlockers();
    const effective=items.map(item=>item.dependency==="external_effects"&&externalBlockers.length?{...item,status:"blocked" as const,blockers:externalBlockers}:item);
    const complete=effective.every(item=>item.status==="satisfied");
    const readinessDigest=complete?hash({restoreId:this.fence.restoreId,backupId:this.fence.backupId,dependencies:effective.map(item=>({dependency:item.dependency,
      revision:item.revision,evidenceRef:"evidenceRef" in item?item.evidenceRef:undefined,materialFingerprint:"materialFingerprint" in item?item.materialFingerprint:undefined,
      expiresAt:"expiresAt" in item?item.expiresAt:undefined}))}):null;
    return{restoreId:this.fence.restoreId,backupId:this.fence.backupId,dependencies:effective,externalBlockers,readinessDigest,
      assessmentStatus:complete?"review_complete_but_locked":"blocked",
      activationSupported:false,fenceRemains:true,executionReady:false,automaticResume:false};}
  activationSnapshot(expectedDigest:string){digest.parse(expectedDigest);const inspection=this.inspect();
    if(inspection.assessmentStatus!=="review_complete_but_locked"||inspection.readinessDigest!==expectedDigest)throw new Error("Recovery readiness is incomplete or changed");
    return{restoreId:this.fence.restoreId,backupId:this.fence.backupId,manifestDigest:this.fence.manifestDigest,readinessDigest:expectedDigest,
      dependencies:inspection.dependencies.map(item=>{if(item.status!=="satisfied"||!("evidenceRef" in item)||!("materialFingerprint" in item)||!("expiresAt" in item))
        throw new Error("Recovery dependency is not satisfied");return{dependency:item.dependency,revision:item.revision,evidenceRef:item.evidenceRef,
          materialFingerprint:item.materialFingerprint,expiresAt:item.expiresAt};})};}
  audit(commandId:string){id.parse(commandId);const row=this.control.prepare("SELECT audit_json FROM foundation_recovery_readiness_events WHERE command_id=?").get(commandId) as {audit_json:string}|undefined;
    if(!row)throw new Error("Recovery readiness audit missing");return JSON.parse(row.audit_json);}
  async execute(value:unknown){const input=requestSchema.parse(structuredClone(value)),fingerprint=hash(input),existing=this.control.prepare("SELECT request_hash FROM foundation_recovery_readiness_operations WHERE command_id=?").get(input.commandId) as {request_hash:string}|undefined;
    if(existing&&existing.request_hash!==fingerprint)throw new Error("Recovery readiness command conflict");
    const before=this.state(input.dependency);if(!existing&&before.revision!==input.expectedRevision)throw new Error("Recovery readiness revision conflict");
    const grant=structuredClone(await waitForCancellation(()=>this.options.authorizer?.authorize(structuredClone(input))??Promise.resolve({decision:"denied" as const}),AbortSignal.timeout(10000)));
    const authorized=()=>{if(grant.decision!=="allowed"||!grant.authorizationRef?.trim()||grant.authorizationRef.length>1024||!(Date.parse(grant.expiresAt)>Date.parse(this.now())))throw new Error("Recovery readiness authorization denied or expired");};authorized();
    if(existing)return{audit:this.audit(input.commandId),replayed:true,...this.inspect()};
    let evidence:null|{evidenceRef:string;materialFingerprint:string;expiresAt:string}=null,verificationBlocker:string|null=null;
    if(input.operation==="attest"){
      const result=verifierResultSchema.parse(structuredClone(await waitForCancellation(()=>this.options.verifier?.verify({dependency:input.dependency,fence:structuredClone(this.fence)})
        ??Promise.resolve({decision:"blocked" as const,reason:"No trusted verifier configured"}),AbortSignal.timeout(30000))));
      if(result.decision==="blocked")verificationBlocker=result.reason;
      else{if(!(Date.parse(result.expiresAt)>Date.parse(this.now())))throw new Error("Recovery dependency proof invalid or expired");
        evidence={evidenceRef:result.evidenceRef,materialFingerprint:result.materialFingerprint,expiresAt:result.expiresAt};
        const current=this.options.currentFingerprint?.(input.dependency);if(current!==undefined&&current!==evidence.materialFingerprint)throw new Error("Recovery dependency changed during verification");}
    }
    authorized();const current=this.state(input.dependency);if(current.revision!==input.expectedRevision)throw new Error("Recovery readiness state changed");
    const audit={...input,resultingRevision:current.revision+1,status:input.operation==="revoke"?"revoked":verificationBlocker?"blocked":"satisfied",evidence,verificationBlocker,
      authorizationRef:grant.decision==="allowed"?grant.authorizationRef:"",at:this.now(),activationSupported:false,fenceRemains:true};
    this.control.transaction(()=>{this.control.prepare("INSERT INTO foundation_recovery_readiness_operations VALUES (?,?,?)").run(input.commandId,fingerprint,canonicalJson(input));
      this.control.prepare("INSERT INTO foundation_recovery_readiness_events(restore_id,dependency,revision,command_id,operation,audit_json) VALUES (?,?,?,?,?,?)")
        .run(this.fence.restoreId,input.dependency,audit.resultingRevision,input.commandId,input.operation,canonicalJson(audit));})();
    return{audit,replayed:false,...this.inspect()};
  }
  private state(dependency:RecoveryDependency){const row=this.control.prepare("SELECT revision,operation,audit_json FROM foundation_recovery_readiness_events WHERE restore_id=? AND dependency=? ORDER BY revision DESC LIMIT 1")
    .get(this.fence.restoreId,dependency) as {revision:number;operation:string;audit_json:string}|undefined;if(!row)return{dependency,revision:0,status:"pending" as const};
    if(row.operation==="revoke")return{dependency,revision:row.revision,status:"revoked" as const};const audit=JSON.parse(row.audit_json) as {status?:string;verificationBlocker?:string;evidence?:{materialFingerprint:string;expiresAt:string;evidenceRef:string}};
    if(audit.status==="blocked")return{dependency,revision:row.revision,status:"blocked" as const,blockers:[{kind:"verifier",reason:audit.verificationBlocker??"blocked"}]};
    if(!audit.evidence||Date.parse(audit.evidence.expiresAt)<=Date.parse(this.now()))return{dependency,revision:row.revision,status:"expired" as const};
    const current=this.options.currentFingerprint?.(dependency);if(current!==undefined&&current!==audit.evidence.materialFingerprint)return{dependency,revision:row.revision,status:"stale" as const};
    return{dependency,revision:row.revision,status:"satisfied" as const,evidenceRef:audit.evidence.evidenceRef,
      materialFingerprint:audit.evidence.materialFingerprint,expiresAt:audit.evidence.expiresAt};}
  private externalBlockers(){const blockers:{kind:string;count:number}[]=[];const count=(table:string,where:string)=>{
    if(!this.restored.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))return 0;return(this.restored.prepare(`SELECT count(*) count FROM ${table} WHERE ${where}`).get() as {count:number}).count;};
    for(const [kind,table,where] of [["active_leases","scenario_work_leases","1=1"],["process_occupancy","process_execution_occupancy","state!='released'"],
      ["managed_occupancy","managed_execution_occupancy","state!='released'"],["uncertain_invocations","tool_invocation_executions","status IN ('prepared','executing','uncertain')"],
      ["nonterminal_models","scenario_model_calls","status='running'"],["model_admissions","scenario_model_admissions","status IN ('queued','admitted','running')"]] as const){const value=count(table,where);if(value)blockers.push({kind,count:value});}
    return blockers;}
}

export function registerFoundationRecoveryReadinessRoutes(app:FastifyInstance,restored:Database.Database,fence:FoundationRestoreFence,options?:FoundationRecoveryReadinessOptions){
  const control=options?new FoundationRecoveryReadinessControl(restored,fence,options):undefined;
  return registerFoundationRecoveryReadinessControlRoutes(app,fence,control);
}
export function registerFoundationRecoveryReadinessControlRoutes(app:FastifyInstance,fence:FoundationRestoreFence,control?:FoundationRecoveryReadinessControl){
  app.get("/api/foundation/recovery/readiness",async()=>control?.inspect()??({restoreId:fence.restoreId,dependencies:dependencies.map(dependency=>({dependency,revision:0,status:"pending"})),
    assessmentStatus:"blocked",reason:"Trusted readiness audit database and verifiers are not configured",activationSupported:false,fenceRemains:true,executionReady:false,automaticResume:false}));
  app.get("/api/foundation/recovery/readiness/audit",async(req,reply)=>{try{return control?.audit(z.object({commandId:id}).strict().parse(req.query).commandId)??reply.code(409).send({error:"Readiness control unavailable"});}
    catch(error){return reply.code(error instanceof z.ZodError?400:409).send({error:error instanceof Error?error.message.slice(0,512):"Readiness unavailable"});}});
  app.post("/api/foundation/recovery/readiness/execute",async(req,reply)=>{try{if(!control)throw new Error("Readiness control unavailable");return await control.execute(req.body);}
    catch(error){return reply.code(error instanceof z.ZodError?400:409).send({error:error instanceof Error?error.message.slice(0,512):"Readiness unavailable"});}});
  return control;
}
