import { createHash, createPublicKey, verify } from "node:crypto";
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import type { StartProcessRequest } from "@traceforge/execution-node";
import { canonicalJson } from "@traceforge/orchestration-core";
import { ToolProviderFairScheduler, type ToolProviderSchedulingIdentity } from "@traceforge/worker-runtime";
import { z } from "zod";
import { SqliteProcessExecutionJournal } from "./execution-process-journal.js";
import type { RecoveryEvidenceAuthority } from "./tool-recovery-evidence.js";
import { initializeGovernanceHistory, readGovernanceHistory } from "./db/governance-history.js";

export interface ProcessCapacityInput {
  source: string; version: string; operation: string; kind: "work" | "service";
  attribution: StartProcessRequest["attribution"];
  parentInvocationKey?: string;
}
export interface ProcessCapacityLease { beforeStart(requestId:string):void; finish(terminalObserved:boolean):void }
export interface ProcessCleanupAuthorizer {
  authorize(input:{commandId:string;actor:string;reason:string;occupancyId:string;identity:unknown}):Promise<
    {decision:"allowed";authorizationRef:string;expiresAt:string}|{decision:"denied"}>;
}
type SavedIdentity = Omit<ProcessCapacityInput,"kind"|"attribution"> & {kind:"work"|"service"|"legacy";
  attribution:Pick<StartProcessRequest["attribution"],"idempotencyKey"|"caseId"|"runId"|"workId"|"leaseId">};
interface Row { id:string; process_key:string; identity_json:string; state:string; request_id:string|null; proof_ref:string|null; created_at:string }
const hash=(value:unknown)=>createHash("sha256").update(canonicalJson(value)).digest("hex");
const text=z.string().min(1).max(1024);
const proofSchema=z.object({format:z.literal("traceforge.process-cleanup.v1"),keyId:text,occupancyId:text,identity:z.unknown(),
  process:z.object({identity:z.unknown(),launch:z.unknown()}).strict(),cleanup:z.enum(["terminal","not_started"]),
  evidenceRef:text,issuedAt:z.string().datetime(),expiresAt:z.string().datetime(),signature:z.string().max(128)}).strict();
export type SignedProcessCleanup = z.infer<typeof proofSchema>;
export const processCleanupSigningPayload=(value:Omit<SignedProcessCleanup,"signature">)=>canonicalJson(value);

/** Per-process accounting shared with Managed Providers; service discovery is not a fabricated Work invocation. */
export class ProcessExecutionCapacity {
  private readonly held=new Set<string>();
  private readonly local=new Set<string>();
  constructor(private readonly sqlite:Database.Database,readonly scheduler:ToolProviderFairScheduler,
    private readonly now=()=>new Date().toISOString()) {
    sqlite.exec(`CREATE TABLE IF NOT EXISTS process_execution_occupancy (
      id TEXT PRIMARY KEY,process_key TEXT NOT NULL UNIQUE,identity_json TEXT NOT NULL,state TEXT NOT NULL,
      request_id TEXT,proof_ref TEXT,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS process_cleanup_commands (command_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,proof_json TEXT NOT NULL,audit_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS process_occupancy_scope ON process_execution_occupancy
        (json_extract(identity_json,'$.attribution.caseId'),json_extract(identity_json,'$.attribution.runId'),id);
      CREATE TRIGGER IF NOT EXISTS process_occupancy_bound BEFORE INSERT ON process_execution_occupancy BEGIN
        SELECT CASE WHEN NEW.state NOT IN ('reserved','unknown') OR NEW.proof_ref IS NOT NULL
          THEN RAISE(ABORT,'Invalid initial process occupancy') END;
        SELECT CASE WHEN (SELECT count(*) FROM process_execution_occupancy)>=100000 OR length(CAST(NEW.identity_json AS BLOB))>8192
          OR length(CAST(NEW.process_key AS BLOB))>1024 THEN RAISE(ABORT,'Process occupancy capacity exceeded') END;
        SELECT execution_physical_admit(execution_floor,maximum_database_bytes,maximum_wal_bytes,12288,'execution') FROM execution_physical_policy WHERE id=1;
      END;
      CREATE TRIGGER IF NOT EXISTS process_occupancy_fence BEFORE UPDATE ON process_execution_occupancy BEGIN
        SELECT CASE WHEN NEW.id!=OLD.id OR NEW.process_key!=OLD.process_key OR NEW.identity_json!=OLD.identity_json OR NEW.created_at!=OLD.created_at
          OR OLD.state='released' OR (OLD.request_id IS NOT NULL AND NEW.request_id IS NOT OLD.request_id)
          OR (NEW.state='dispatched' AND OLD.state!='reserved') OR (NEW.state='released' AND NEW.proof_ref IS NULL)
          OR NEW.state NOT IN ('dispatched','unknown','terminal_observed','released') THEN RAISE(ABORT,'Process occupancy fenced') END;
      END;
      CREATE TRIGGER IF NOT EXISTS process_cleanup_bound BEFORE INSERT ON process_cleanup_commands BEGIN
        SELECT CASE WHEN (SELECT count(*) FROM process_cleanup_commands)>=50000 OR length(CAST(NEW.proof_json AS BLOB))>65536
          OR length(CAST(NEW.audit_json AS BLOB))>8192 THEN RAISE(ABORT,'Process cleanup audit capacity exceeded') END;
        SELECT execution_physical_admit(recovery_floor,maximum_database_bytes,maximum_wal_bytes,77824,'recovery') FROM execution_physical_policy WHERE id=1;
      END;`);
    for(const table of ["process_execution_occupancy","process_cleanup_commands"])sqlite.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_keep BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'Process capacity keys are permanent'); END;`);
    sqlite.exec("DROP TRIGGER IF EXISTS process_cleanup_immutable; CREATE TRIGGER process_cleanup_immutable BEFORE UPDATE ON process_cleanup_commands WHEN execution_archive_writing('processCleanup',OLD.command_id)=0 BEGIN SELECT RAISE(ABORT,'Process cleanup proof is immutable'); END");
    initializeGovernanceHistory(sqlite,"processCleanup");
    sqlite.prepare("UPDATE process_execution_occupancy SET state='released',proof_ref='host:not_dispatched' WHERE state='reserved'").run();
    for(const row of sqlite.prepare("SELECT * FROM process_execution_occupancy WHERE state!='released'").iterate() as Iterable<Row>)this.retain(row);
  }

  async acquire(value:ProcessCapacityInput,signal?:AbortSignal,authorize?:()=>void):Promise<ProcessCapacityLease> {
    const input=structuredClone(value),attribution=input.attribution;
    z.enum(['work','service']).parse(input.kind);
    const identity=this.scheduling(input),key=attribution.idempotencyKey,id=hash([input.source,input.version,key]);
    if(!key || Buffer.byteLength(key)>1024)throw new Error("Invalid process capacity key");
    const check=()=>{
      signal?.throwIfAborted();authorize?.();
      this.assertOwnership(input);
    };
    check();const permit=await this.scheduler.acquire(identity,signal);
    try{check();this.sqlite.prepare("INSERT INTO process_execution_occupancy VALUES (?,?,?,'reserved',NULL,NULL,?)").run(id,key,canonicalJson(input),this.now());}
    catch(error){permit.release();throw error;}
    this.local.add(id);let finished=false;
    return {beforeStart:(requestId)=>{
      check();if(finished)throw new Error("Process admission already settled");
      if(this.sqlite.prepare("UPDATE process_execution_occupancy SET state='dispatched',request_id=? WHERE id=? AND state='reserved'").run(text.parse(requestId),id).changes!==1)throw new Error("Process dispatch fenced");
    },finish:(terminal)=>{
      if(finished)return;finished=true;let released=false;
      try{
        const row=this.required(id);
        if(row.state==="reserved"){this.releaseRow(id,"host:not_dispatched");released=true;}
        else this.sqlite.prepare("UPDATE process_execution_occupancy SET state=? WHERE id=? AND state!='released'").run(terminal?"terminal_observed":"unknown",id);
      }finally{
        if(!released){this.scheduler.retain(this.schedulerKey(id),identity);this.held.add(id);}
        this.local.delete(id);permit.release();
      }
    }};
  }

  /** Shared dispatch fence for host-scoped process and brokered network operations. */
  assertOwnership(input:ProcessCapacityInput):void {
    const attribution=input.attribution;
    if(!(Date.parse(attribution.leaseExpiresAt)>Date.parse(this.now())))throw new Error("Process capacity lease expired");
    if(input.kind==="work"){
      const row=this.sqlite.prepare(`SELECT 1 FROM scenario_work_leases l JOIN scenario_event_streams r ON r.run_id=l.run_id
        JOIN tool_invocation_bindings b ON b.run_id=l.run_id AND b.work_id=l.work_id JOIN tool_invocation_executions e USING(idempotency_key)
        WHERE l.run_id=? AND l.work_id=? AND l.lease_id=? AND l.worker_id=? AND r.case_id=? AND r.status='running'
        AND l.lease_expires_at>? AND b.idempotency_key=? AND e.status='executing' AND e.lease_id=l.lease_id`)
        .get(attribution.runId,attribution.workId,attribution.leaseId,attribution.workerId,attribution.caseId,this.now(),input.parentInvocationKey);
      if(!row)throw new Error("Process capacity requires the exact current Work invocation");
    }
  }

  /** Legacy provenance cannot reconstruct a source; retain it conservatively under an explicit unknown-source bucket. */
  restoreLegacy():void {
    const managed=this.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name='managed_execution_occupancy'").get();
    const rows=this.sqlite.prepare(`SELECT j.idempotency_key FROM execution_process_journal j
      WHERE NOT EXISTS(SELECT 1 FROM process_execution_occupancy p WHERE p.process_key=j.idempotency_key)
      ${managed?"AND NOT EXISTS(SELECT 1 FROM managed_execution_occupancy m WHERE m.idempotency_key=j.idempotency_key)":""}
      ORDER BY j.idempotency_key LIMIT 100001`).all() as {idempotency_key:string}[];
    this.sqlite.transaction(()=>{for(const row of rows){
      const observed=new SqliteProcessExecutionJournal(this.sqlite).get(row.idempotency_key)!;
      const identity:SavedIdentity={source:"legacy.unattributed",version:"unknown",operation:"unattributed-process",kind:"legacy",attribution:observed.identity};
      const id=hash([identity.source,identity.version,row.idempotency_key]);
      this.sqlite.prepare("INSERT INTO process_execution_occupancy VALUES (?,?,?,'unknown',?,NULL,?)").run(id,row.idempotency_key,canonicalJson(identity),observed.identity.requestId,this.now());
    }})();
    for(const row of this.sqlite.prepare("SELECT * FROM process_execution_occupancy WHERE state!='released'").iterate() as Iterable<Row>)this.retain(row);
  }

  inspect(id:string){const row=this.required(id);return {id,identity:JSON.parse(row.identity_json) as SavedIdentity,state:row.state,requestId:row.request_id,
    proofRef:row.proof_ref,createdAt:row.created_at,localWaitActive:this.local.has(id),automaticRetryAllowed:false};}

  list(caseId:string,runId:string,limit=100,after="") {
    text.parse(caseId);text.parse(runId);z.number().int().min(1).max(100).parse(limit);
    z.string().max(1024).parse(after);
    const rows=this.sqlite.prepare(`SELECT id FROM process_execution_occupancy
      WHERE json_extract(identity_json,'$.attribution.caseId')=? AND json_extract(identity_json,'$.attribution.runId')=? AND id>?
      ORDER BY id LIMIT ?`).all(caseId,runId,after,limit+1) as {id:string}[];
    const page=rows.slice(0,limit);
    return {items:page.map(row=>this.inspect(row.id)),nextCursor:rows.length>limit?page.at(-1)!.id:null};
  }

  async release(value:unknown,authorizer:ProcessCleanupAuthorizer|undefined,authority:(keyId:string)=>RecoveryEvidenceAuthority|undefined){
    if(Buffer.byteLength(JSON.stringify(value))>65536)throw new Error("Process proof exceeds bound");
    const input=z.object({commandId:text,actor:text,reason:text,occupancyId:text,evidence:proofSchema}).strict().parse(structuredClone(value));
    const row=this.required(input.occupancyId),identity=JSON.parse(row.identity_json) as SavedIdentity,fingerprint=hash(input);
    let timer:ReturnType<typeof setTimeout>|undefined;
    const grant=await Promise.race([authorizer?.authorize({commandId:input.commandId,actor:input.actor,reason:input.reason,occupancyId:row.id,identity:structuredClone(identity)}),
      new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("Process cleanup authorization deadline")),10000);})]).finally(()=>{if(timer)clearTimeout(timer);});
    if(grant?.decision!=="allowed" || !grant.authorizationRef?.trim() || !(Date.parse(grant.expiresAt)>Date.parse(this.now())))throw new Error("Process cleanup denied");
    const previous=this.sqlite.prepare("SELECT 1 FROM execution_governance_history WHERE kind='processCleanup' AND entry_key=?").get(input.commandId)
      ? readGovernanceHistory(this.sqlite,"processCleanup",input.commandId).row : undefined;
    if(previous){if(previous.fingerprint!==fingerprint)throw new Error("Process cleanup command conflict");this.refresh();return {...JSON.parse(previous.audit_json),replayed:true};}
    if(row.state==="released" || this.local.has(row.id))throw new Error("Process cleanup requires retained occupancy");
    const evidence=input.evidence,auth=authority(evidence.keyId),now=Date.parse(this.now()),issued=Date.parse(evidence.issuedAt),expires=Date.parse(evidence.expiresAt);
    const journal=new SqliteProcessExecutionJournal(this.sqlite).get(row.process_key);
    if(!auth || auth.revoked || !auth.sources.includes(identity.source) || !auth.processAcceptance?.reference.trim()
      || !journal?.launch || journal.schemaVersion!==2 || !auth.processAcceptance.nodeIds.includes(journal.nodeId)
      || !(Date.parse(auth.validFrom)<=issued && Date.parse(row.created_at)<=issued && issued<=now && now<expires && expires<=Date.parse(auth.validUntil))
      || !Number.isSafeInteger(auth.maximumAgeMs) || auth.maximumAgeMs<1 || now-issued>auth.maximumAgeMs || expires-issued>auth.maximumAgeMs
      || evidence.occupancyId!==row.id || canonicalJson(evidence.identity)!==row.identity_json
      || canonicalJson(evidence.process.identity)!==canonicalJson(journal.identity) || canonicalJson(evidence.process.launch)!==canonicalJson(journal.launch)
      || journal.identity.requestId!==row.request_id || ["caseId","runId","workId","leaseId","idempotencyKey"].some(k=>journal.identity[k as keyof typeof journal.identity]!==identity.attribution[k as keyof typeof identity.attribution])
      || (evidence.cleanup==="not_started" && (journal.status!=="claimed" || journal.process!==null)))throw new Error("Process cleanup evidence does not cover this occupancy");
    const signature=Buffer.from(evidence.signature,"base64"),key=createPublicKey(auth.publicKeyPem),{signature:_signature,...payload}=evidence;
    if(key.asymmetricKeyType!=="ed25519" || signature.length!==64 || signature.toString("base64")!==evidence.signature
      || !verify(null,Buffer.from(processCleanupSigningPayload(payload)),key,signature))throw new Error("Invalid process cleanup signature");
    const audit={commandId:input.commandId,occupancyId:row.id,actor:input.actor,reason:input.reason,authorizationRef:grant.authorizationRef,
      proofRef:`process-cleanup:${hash(evidence)}`,createdAt:this.now(),automaticRetryAllowed:false};
    this.sqlite.transaction(()=>{
      if(!(Date.parse(grant.expiresAt)>Date.parse(this.now())) || this.required(row.id).state!==row.state || this.local.has(row.id))throw new Error("Process occupancy changed during verification");
      this.sqlite.prepare("INSERT INTO process_cleanup_commands VALUES (?,?,?,?)").run(input.commandId,fingerprint,canonicalJson(evidence),canonicalJson(audit));
      this.releaseRow(row.id,audit.proofRef);
    })();this.refresh();return {...audit,replayed:false};
  }
  private scheduling(input:SavedIdentity):ToolProviderSchedulingIdentity{return {providerId:input.source,providerVersion:input.version,toolName:input.operation,
    caseId:input.attribution.caseId,runId:input.attribution.runId,workId:input.attribution.workId};}
  private schedulerKey(id:string){return JSON.stringify(["process",id]);}
  private retain(row:Row){this.scheduler.retain(this.schedulerKey(row.id),this.scheduling(JSON.parse(row.identity_json)));this.held.add(row.id);}
  private refresh(){for(const id of this.held)if(this.required(id).state==="released"){this.scheduler.releaseRetained(this.schedulerKey(id));this.held.delete(id);}}
  private required(id:string):Row{const row=this.sqlite.prepare("SELECT * FROM process_execution_occupancy WHERE id=?").get(id) as Row|undefined;if(!row)throw new Error("Unknown process occupancy");return row;}
  private releaseRow(id:string,proof:string){this.sqlite.prepare("UPDATE process_execution_occupancy SET state='released',proof_ref=? WHERE id=?").run(proof,id);}
}

export function registerProcessCapacityRoutes(app:FastifyInstance,capacity:ProcessExecutionCapacity,authorizer:ProcessCleanupAuthorizer|undefined,authority:(keyId:string)=>RecoveryEvidenceAuthority|undefined){
  app.get("/api/security-tools/process-occupancies",async(request,reply)=>{try{
    const input=z.object({caseId:text,runId:text,limit:z.coerce.number().int().min(1).max(100).default(100),after:z.string().max(1024).default("")}).strict().parse(request.query);
    return capacity.list(input.caseId,input.runId,input.limit,input.after);
  }catch{return reply.code(409).send({error:"Process occupancies unavailable"});}});
  app.get("/api/security-tools/process-occupancy",async(request,reply)=>{try{const input=z.object({id:text,caseId:text,runId:text}).strict().parse(request.query),record=capacity.inspect(input.id);
    if(record.identity.attribution.caseId!==input.caseId || record.identity.attribution.runId!==input.runId)throw new Error("Scope mismatch");return record;
  }catch{return reply.code(409).send({error:"Process occupancy unavailable"});}});
  app.post("/api/security-tools/process-cleanup",{bodyLimit:65536},async(request,reply)=>{try{return await capacity.release(request.body,authorizer,authority);}catch{return reply.code(409).send({error:"Process cleanup rejected"});}});
}
