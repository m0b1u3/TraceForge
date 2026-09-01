import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { canonicalJson } from "@traceforge/orchestration-core";
import { ToolProviderFairScheduler, validateToolProviderResult, type ToolExecutionContext, type ToolProviderSchedulingIdentity } from "@traceforge/worker-runtime";
import { SqliteToolInvocationBindingStore } from "./worker-execution-adapters.js";
import { readExecutionRow } from "./db/execution-archive.js";
import { initializeGovernanceHistory, readGovernanceHistory } from "./db/governance-history.js";
import { SqliteProcessExecutionJournal } from "./execution-process-journal.js";
import type { ToolInvocationReconciliationAuthorizer, ToolInvocationReconciliationEvidenceVerifier, ToolInvocationReconciliationIdentity, ToolInvocationReconciliationAssertion } from "./tool-invocation-reconciliation.js";

type State = "reserved" | "dispatched" | "unknown" | "terminal_observed" | "released";
interface Identity {
  scheduling: ToolProviderSchedulingIdentity;
  invocation: ToolInvocationReconciliationIdentity;
  ownership: {ownerId:string;leaseId:string|null};
}
interface Row { idempotency_key:string; identity_json:string; host_id:string; state:State; request_id:string|null; proof_ref:string|null; created_at:string; updated_at:string }
const hash=(value:unknown)=>createHash("sha256").update(canonicalJson(value)).digest("hex");
const text=z.string().trim().min(1).max(512);

/** One durable external slot per managed invocation. It is independent of a local awaiting Promise. */
export class ManagedExecutionCapacity {
  private readonly hostId=randomUUID();
  private readonly local=new Map<string,ToolProviderSchedulingIdentity>();
  private readonly restored=new Set<string>();
  private reconciliationCursor="";
  constructor(private readonly sqlite:Database.Database, readonly scheduler:ToolProviderFairScheduler,
    private readonly bindings:SqliteToolInvocationBindingStore, private readonly now=()=>new Date().toISOString()) {
    sqlite.exec(`CREATE TABLE IF NOT EXISTS managed_execution_occupancy (
      idempotency_key TEXT PRIMARY KEY,identity_json TEXT NOT NULL,host_id TEXT NOT NULL,state TEXT NOT NULL,
      request_id TEXT,proof_ref TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS managed_execution_occupancy_state ON managed_execution_occupancy(state,idempotency_key);
      CREATE TABLE IF NOT EXISTS managed_execution_cleanup_audits (command_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,audit_json TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS managed_occupancy_admit BEFORE INSERT ON managed_execution_occupancy BEGIN
        SELECT CASE WHEN (SELECT count(*) FROM managed_execution_occupancy)>=100000 OR length(CAST(NEW.identity_json AS BLOB))>8192
          OR length(CAST(NEW.idempotency_key AS BLOB))>1024 OR NEW.state NOT IN ('reserved','unknown')
          THEN RAISE(ABORT,'Managed execution occupancy capacity or identity invalid') END;
        SELECT execution_physical_admit(execution_floor,maximum_database_bytes,maximum_wal_bytes,12288,'execution') FROM execution_physical_policy WHERE id=1;
      END;
      CREATE TRIGGER IF NOT EXISTS managed_occupancy_transition BEFORE UPDATE ON managed_execution_occupancy BEGIN
        SELECT CASE WHEN NEW.idempotency_key!=OLD.idempotency_key OR NEW.identity_json!=OLD.identity_json OR NEW.host_id!=OLD.host_id
          OR NEW.created_at!=OLD.created_at OR OLD.state='released' OR (OLD.request_id IS NOT NULL AND NEW.request_id IS NOT OLD.request_id)
          OR NEW.state NOT IN ('dispatched','unknown','terminal_observed','released')
          OR (NEW.state='dispatched' AND OLD.state!='reserved')
          OR (NEW.state='released' AND NEW.proof_ref IS NULL)
          THEN RAISE(ABORT,'Managed execution occupancy is fenced') END;
      END;
      CREATE TRIGGER IF NOT EXISTS managed_occupancy_keep BEFORE DELETE ON managed_execution_occupancy BEGIN SELECT RAISE(ABORT,'Execution occupancy keys are permanent'); END;
      CREATE TRIGGER IF NOT EXISTS managed_cleanup_admit BEFORE INSERT ON managed_execution_cleanup_audits BEGIN
        SELECT CASE WHEN (SELECT count(*) FROM managed_execution_cleanup_audits)>=50000 OR length(CAST(NEW.audit_json AS BLOB))>8192
          THEN RAISE(ABORT,'Managed cleanup audit capacity exceeded') END;
        SELECT execution_physical_admit(recovery_floor,maximum_database_bytes,maximum_wal_bytes,12288,'recovery') FROM execution_physical_policy WHERE id=1;
      END;
      CREATE TRIGGER IF NOT EXISTS managed_cleanup_keep BEFORE DELETE ON managed_execution_cleanup_audits BEGIN SELECT RAISE(ABORT,'Cleanup audits are permanent'); END;
      DROP TRIGGER IF EXISTS managed_cleanup_immutable;
      CREATE TRIGGER managed_cleanup_immutable BEFORE UPDATE ON managed_execution_cleanup_audits
        WHEN execution_archive_writing('managedCleanup',OLD.command_id)=0 BEGIN SELECT RAISE(ABORT,'Cleanup audits are immutable'); END;`);
    initializeGovernanceHistory(sqlite,"managedCleanup");
    this.adoptLegacy();
    this.restore();
  }

  reserve(scheduling:ToolProviderSchedulingIdentity, source:string, context:ToolExecutionContext): void {
    const binding=this.bindings.get(context.idempotencyKey), execution=this.bindings.execution(context.idempotencyKey);
    if (!binding || !execution || execution.status!=="executing" || execution.lease_id!==context.leaseId
      || canonicalJson(binding.attribution)!==canonicalJson({caseId:context.caseId,runId:context.runId,workId:context.workId})
      || binding.tool.source!==source || binding.tool.name!==scheduling.toolName
      || scheduling.caseId!==context.caseId || scheduling.runId!==context.runId || scheduling.workId!==context.workId) throw new Error("Managed occupancy requires exact invocation ownership");
    const lease=this.sqlite.prepare(`SELECT 1 FROM scenario_work_leases l JOIN scenario_event_streams r ON r.run_id=l.run_id
      WHERE l.run_id=? AND l.work_id=? AND l.lease_id=? AND l.worker_id=? AND l.lease_expires_at>? AND r.case_id=? AND r.status='running'`)
      .get(context.runId,context.workId,context.leaseId,context.workerId,this.now(),context.caseId);
    if(!lease)throw new Error("Managed occupancy requires a current Worker lease");
    const identity:Identity={scheduling,invocation:{idempotencyKey:binding.idempotencyKey,invocationId:binding.invocationId,
      tool:binding.tool,inputFingerprint:binding.inputFingerprint,attribution:binding.attribution},ownership:{ownerId:execution.owner_id,leaseId:execution.lease_id}};
    const at=this.now();
    this.sqlite.prepare("INSERT INTO managed_execution_occupancy VALUES (?,?,?,'reserved',NULL,NULL,?,?)").run(context.idempotencyKey,canonicalJson(identity),this.hostId,at,at);
    this.local.set(context.idempotencyKey,structuredClone(scheduling));
  }

  beforeStart(key:string, requestId:string):void {
    if (!this.local.has(key)) throw new Error("Execution capacity is not locally owned");
    const result=this.sqlite.prepare("UPDATE managed_execution_occupancy SET state='dispatched',request_id=?,updated_at=? WHERE idempotency_key=? AND host_id=? AND state='reserved'")
      .run(text.parse(requestId),this.now(),key,this.hostId);
    if (result.changes!==1) throw new Error("Execution dispatch capacity is fenced");
  }

  finish(key:string, terminalObserved:boolean):void {
    const identity=this.local.get(key);if(!identity)throw new Error("External occupancy is not locally owned");
    let released=false;
    try {
      const row=this.required(key);
      if (row.state==="reserved") {this.releaseRow(key,"host:not_dispatched");released=true;}
      else if (row.state!=="released") this.sqlite.prepare("UPDATE managed_execution_occupancy SET state=?,updated_at=? WHERE idempotency_key=?")
        .run(terminalObserved ? "terminal_observed" : "unknown",this.now(),key);
    } finally {
      // Install the external hold BEFORE the caller releases its local scheduler lease.
      // Even an unreadable/failed SQLite settlement must keep its in-memory fence.
      if (!released) this.scheduler.retain(JSON.stringify(["managed",key]),identity);
      if (!released) this.restored.add(key);
      this.local.delete(key);
    }
  }

  private adoptLegacy():void {
    const rows=this.sqlite.prepare(`SELECT b.idempotency_key,m.provider_id,m.version FROM tool_invocation_bindings b
      JOIN tool_invocation_executions e USING(idempotency_key) JOIN tool_provider_manifests m
        ON json_extract(m.manifest_json,'$.source')=b.tool_source
      WHERE e.status IN ('executing','uncertain','completed')
        AND EXISTS(SELECT 1 FROM json_each(m.manifest_json,'$.tools') t WHERE json_extract(t.value,'$.name')=b.tool_name AND json_extract(t.value,'$.version')=b.tool_version)
        AND NOT EXISTS(SELECT 1 FROM managed_execution_occupancy o WHERE o.idempotency_key=b.idempotency_key)
      ORDER BY b.idempotency_key LIMIT 100001`).all() as Array<{idempotency_key:string;provider_id:string;version:string}>;
    if(new Set(rows.map(row=>row.idempotency_key)).size!==rows.length)throw new Error("Ambiguous legacy Provider ownership; admission blocked");
    this.sqlite.transaction(()=>{
      for(const row of rows){
        const binding=this.bindings.get(row.idempotency_key)!,execution=this.bindings.execution(row.idempotency_key)!;
        const observation=new SqliteProcessExecutionJournal(this.sqlite).get(row.idempotency_key);
        const identity:Identity={scheduling:{providerId:row.provider_id,providerVersion:row.version,toolName:binding.tool.name,...binding.attribution},
          invocation:{idempotencyKey:binding.idempotencyKey,invocationId:binding.invocationId,tool:binding.tool,inputFingerprint:binding.inputFingerprint,attribution:binding.attribution},
          ownership:{ownerId:execution.owner_id,leaseId:execution.lease_id}};
        this.sqlite.prepare("INSERT INTO managed_execution_occupancy VALUES (?,?,?,'unknown',?,NULL,?,?)")
          .run(row.idempotency_key,canonicalJson(identity),this.hostId,observation?.identity.requestId??null,execution.updated_at,this.now());
      }
    })();
  }

  private restore():void {
    // A crash before the dispatch barrier cannot have started a process through this path.
    this.sqlite.prepare("UPDATE managed_execution_occupancy SET state='released',proof_ref='host:not_dispatched',updated_at=? WHERE state='reserved'").run(this.now());
    const rows=this.sqlite.prepare("SELECT * FROM managed_execution_occupancy WHERE state!='released'").iterate() as IterableIterator<Row>;
    for (const row of rows) {this.scheduler.retain(JSON.stringify(["managed",row.idempotency_key]),JSON.parse(row.identity_json).scheduling);this.restored.add(row.idempotency_key);}
  }

  /** Reuse already committed, independently authorized reconciliation proofs, never process exit alone. */
  reconcile():number {
    let released=0;
    const rows=this.sqlite.prepare(`SELECT o.idempotency_key,a.command_id FROM managed_execution_occupancy o
      JOIN tool_invocation_reconciliation_audits a USING(idempotency_key)
      WHERE o.state!='released' AND a.outcome='resolved' AND a.authorization_decision='allowed' AND o.idempotency_key>?
      ORDER BY o.idempotency_key LIMIT 100`)
      .all(this.reconciliationCursor) as Array<{idempotency_key:string;command_id:string}>;
    this.reconciliationCursor=rows.length===100 ? rows.at(-1)!.idempotency_key : "";
    for (const row of rows) {
      if (this.local.has(row.idempotency_key)) continue;
      const audit=readExecutionRow<{verified_assertion_json:string}>(this.sqlite,"reconciliation",row.command_id)!;
      const assertion=JSON.parse(audit.verified_assertion_json) as ToolInvocationReconciliationAssertion;
      try {this.assertProof(this.required(row.idempotency_key),assertion);} catch {continue;}
      this.releaseRow(row.idempotency_key,`invocation-reconciliation:${row.command_id}`); released++;
    }
    this.refreshReleased(); return released;
  }

  refreshReleased():void {
    for (const key of this.restored) if (this.required(key).state==="released") {this.scheduler.releaseRetained(JSON.stringify(["managed",key]));this.restored.delete(key);}
  }

  inspect(key:string) {
    const row=this.required(key), identity=JSON.parse(row.identity_json) as Identity;
    return {idempotencyKey:key,...identity.scheduling,state:row.state,requestId:row.request_id,proofRef:row.proof_ref,
      externallyOccupied:row.state!=="released",localWaitActive:this.local.has(key),createdAt:row.created_at,updatedAt:row.updated_at,automaticRetryAllowed:false};
  }

  async release(value:unknown, authorizer:ToolInvocationReconciliationAuthorizer, verifier:ToolInvocationReconciliationEvidenceVerifier) {
    const input=z.object({commandId:text,actor:text,reason:text,idempotencyKey:text,evidence:z.unknown()}).strict().parse(value);
    if (input.evidence===undefined) throw new Error("Cleanup evidence required");
    if (Buffer.byteLength(JSON.stringify(input))>131072) throw new Error("Cleanup request exceeds bound");
    const fingerprint=hash(input);
    const previous=this.audit(input.commandId);
    if (previous) {if(previous.fingerprint!==fingerprint)throw new Error("Cleanup command identity conflict");this.refreshReleased();return {...JSON.parse(previous.audit_json),replayed:true};}
    const row=this.required(input.idempotencyKey), identity=JSON.parse(row.identity_json) as Identity;
    if (row.state==="released" || this.local.has(input.idempotencyKey)) throw new Error("Cleanup requires retained external occupancy");
    const receipt=readExecutionRow<{result_json:string}>(this.sqlite,"receipt",input.idempotencyKey);
    const result=receipt ? validateToolProviderResult(JSON.parse(receipt.result_json)) : null;
    const resolution=result ? "confirmed_result" as const : "confirmed_no_effect" as const;
    let assertion:ToolInvocationReconciliationAssertion|undefined;
    let outcome:"released"|"denied"|"rejected"="rejected";
    try {
      const decision=await deadline(()=>authorizer.authorize({actor:input.actor,reason:input.reason,resolution,identity:structuredClone(identity.invocation)}));
      if(decision.decision!=="allowed") outcome="denied";
      else {
        assertion=await deadline(()=>verifier.verify({evidence:input.evidence,resolution,result,expectedIdentity:structuredClone(identity.invocation),expectedExecutionOwnership:structuredClone(identity.ownership)}));
        this.assertProof(row,assertion);
        const issued=Date.parse(assertion.issuedAt),expires=Date.parse(assertion.expiresAt),now=Date.parse(this.now());
        if(!Number.isFinite(issued)||!Number.isFinite(expires)||issued<Date.parse(row.created_at)||issued>now||expires<=now
          || assertion.outcome!==(result ? "result_confirmed" : "no_effect_confirmed") || assertion.resultFingerprint!==(result ? hash(result) : null)) throw new Error("Stale or mismatched cleanup evidence");
        outcome="released";
      }
    } catch {outcome="rejected";}
    const audit={commandId:input.commandId,idempotencyKey:input.idempotencyKey,actor:input.actor,outcome,
      proofRef:outcome==="released" ? assertion!.cleanup.evidenceRef : null,createdAt:this.now(),automaticRetryAllowed:false};
    const committed=this.sqlite.transaction(()=>{
      const raced=this.audit(input.commandId);
      if(raced){if(raced.fingerprint!==fingerprint)throw new Error("Cleanup command identity conflict");return {...JSON.parse(raced.audit_json),replayed:true};}
      if(this.required(input.idempotencyKey).state!==row.state || this.local.has(input.idempotencyKey)) throw new Error("Cleanup occupancy changed during verification");
      this.sqlite.prepare("INSERT INTO managed_execution_cleanup_audits VALUES (?,?,?)").run(input.commandId,fingerprint,canonicalJson(audit));
      if(outcome==="released")this.releaseRow(input.idempotencyKey,`managed-cleanup:${input.commandId}`);
      return {...audit,replayed:false};
    })();
    this.refreshReleased();return committed;
  }

  private assertProof(row:Row, assertion:ToolInvocationReconciliationAssertion):void {
    const identity=JSON.parse(row.identity_json) as Identity;
    const observation=new SqliteProcessExecutionJournal(this.sqlite).get(row.idempotency_key);
    if(!observation || observation.schemaVersion!==2 || !observation.launch || !row.request_id
      || observation.identity.requestId!==row.request_id || observation.identity.caseId!==identity.scheduling.caseId
      || observation.identity.runId!==identity.scheduling.runId || observation.identity.workId!==identity.scheduling.workId
      || observation.identity.leaseId!==identity.ownership.leaseId) throw new Error("Cleanup requires matching durable process provenance");
    if(assertion.schemaVersion!==1 || canonicalJson(assertion.identity)!==canonicalJson(identity.invocation)
      || canonicalJson(assertion.executionOwnership)!==canonicalJson(identity.ownership)
      || !["terminal","not_started"].includes(assertion.cleanup?.status) || !assertion.cleanup.evidenceRef?.trim()) throw new Error("Cleanup proof does not cover this external occupancy");
  }
  private releaseRow(key:string,proof:string):void {this.sqlite.prepare("UPDATE managed_execution_occupancy SET state='released',proof_ref=?,updated_at=? WHERE idempotency_key=? AND state!='released'").run(proof,this.now(),key);}
  private required(key:string):Row {const row=this.sqlite.prepare("SELECT * FROM managed_execution_occupancy WHERE idempotency_key=?").get(key) as Row|undefined;if(!row)throw new Error("Unknown managed occupancy");return row;}
  private audit(key:string){return this.sqlite.prepare("SELECT 1 FROM execution_governance_history WHERE kind='managedCleanup' AND entry_key=?").get(key)
    ? readGovernanceHistory(this.sqlite,"managedCleanup",key).row : undefined;}
}

async function deadline<T>(operation:()=>Promise<T>):Promise<T>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([operation(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("Cleanup verification deadline exceeded")),10000);})]);}finally{if(timer)clearTimeout(timer);}}

export function registerManagedExecutionCapacityRoutes(app:FastifyInstance, capacity:ManagedExecutionCapacity,
  authorizer:ToolInvocationReconciliationAuthorizer, verifier:ToolInvocationReconciliationEvidenceVerifier):void {
  app.get("/api/security-tools/execution-capacity",async()=>capacity.scheduler.snapshot());
  app.get("/api/security-tools/execution-occupancy",async(request,reply)=>{try{
    const query=z.object({idempotencyKey:text,caseId:text,runId:text}).strict().parse(request.query),record=capacity.inspect(query.idempotencyKey);
    if(record.caseId!==query.caseId||record.runId!==query.runId)return reply.code(409).send({error:"Occupancy Case/Run mismatch"});return record;
  }catch{return reply.code(409).send({error:"Occupancy unavailable"});}});
  app.post("/api/security-tools/execution-cleanup",async(request,reply)=>{try{const audit=await capacity.release(request.body,authorizer,verifier);
    return reply.code(audit.outcome==="released"?200:403).send(audit);
  }catch{return reply.code(409).send({error:"Cleanup release failed closed"});}});
}
