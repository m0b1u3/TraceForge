import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { archiveExecutionRow, archiveStores, readExecutionRow, type ArchiveKind } from "./db/execution-archive.js";
import { governanceHash, readGovernanceHistory, type GovernanceHistoryIndex, type GovernanceHistoryKind } from "./db/governance-history.js";
import { isExecutionStorageCapacityError, isExecutionStorageWriteError } from "./db/execution-storage.js";

const text=z.string().min(1).max(1024).refine(value=>value.trim().length>0&&Buffer.byteLength(value)<=1024,"Invalid governance identifier");
const kind=z.enum(["managedCleanup","processCleanup"]);
const entry=z.object({kind,key:text}).strict();
const requestSchema=z.object({commandId:text,actor:text,reason:text,caseId:text,runId:text,entries:z.array(entry).min(1).max(32)}).strict()
  .refine(value=>new Set(value.entries.map(e=>JSON.stringify(e))).size===value.entries.length,"Duplicate governance archive entries");
type Request=z.infer<typeof requestSchema>;
export interface GovernanceHistoryAuthorizer {
  authorize(input:Request & {operation:"archive";records:GovernanceHistoryIndex[]}):Promise<
    {decision:"allowed";authorizationRef:string;expiresAt:string}|{decision:"denied"}>;
}
interface Audit extends Request {
  format:"traceforge.governance-archive.v1";outcome:"archived";authorizationRef:string;at:string;
  results:Array<{kind:ArchiveKind;key:string;originalBytes:number;compressedBytes:number;replayed:boolean}>;
}
/** Archives accepted cleanup history, never occupancy state. Service operations do not require a fictitious Run. */
export class GovernanceHistoryControl {
  constructor(private readonly sqlite:Database.Database,private readonly authorizer?:GovernanceHistoryAuthorizer,
    private readonly now=()=>new Date().toISOString(),private readonly retentionMs=86400000) {
    if(!Number.isSafeInteger(retentionMs)||retentionMs<0)throw new Error("Invalid governance archive retention");
  }

  async archive(value:unknown) {
    if(Buffer.byteLength(JSON.stringify(value))>65536)throw new Error("Governance archive request too large");
    const input=requestSchema.parse(structuredClone(value)),fingerprint=governanceHash({operation:"governance_archive",...input});
    const records=input.entries.map(e=>this.scoped(e.kind,e.key,input.caseId,input.runId).index);
    let timer:ReturnType<typeof setTimeout>|undefined;
    const grant=await Promise.race([this.authorizer?.authorize({...structuredClone(input),operation:"archive",records:structuredClone(records)}),
      new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("Governance archive authorization deadline")),10000);})]).finally(()=>clearTimeout(timer));
    if(grant?.decision!=="allowed"||!grant.authorizationRef?.trim()||!(Date.parse(grant.expiresAt)>Date.parse(this.now())))throw new Error("Governance archive denied");
    const result=this.sqlite.transaction(()=>{
      if(!(Date.parse(grant.expiresAt)>Date.parse(this.now())))throw new Error("Governance archive grant expired");
      const prior=this.sqlite.prepare("SELECT fingerprint,audit_json FROM execution_archive_commands WHERE command_id=?").get(input.commandId) as {fingerprint:string;audit_json:string}|undefined;
      if(prior){
        if(prior.fingerprint!==fingerprint)throw new Error("Governance archive command conflict");
        const audit=JSON.parse(prior.audit_json) as Audit;
        for(const e of audit.entries)this.scoped(e.kind,e.key,input.caseId,input.runId);
        for(const e of audit.results)if(!readExecutionRow(this.sqlite,e.kind,e.key))throw new Error("Archived governance dependency missing");
        return {audit,replayed:true};
      }
      const archiveEntries=new Map<string,{kind:ArchiveKind;key:string}>();let bytes=0;
      for(const e of input.entries){
        const saved=this.scoped(e.kind,e.key,input.caseId,input.runId);this.eligible(saved);
        bytes+=Buffer.byteLength(JSON.stringify(saved.row));
        if(saved.evidenceKey){
          bytes+=Buffer.byteLength(JSON.stringify(readExecutionRow(this.sqlite,"evidence",saved.evidenceKey)));
          archiveEntries.set(`evidence:${saved.evidenceKey}`,{kind:"evidence",key:saved.evidenceKey});
        }
        archiveEntries.set(JSON.stringify(e),e);
      }
      if(bytes>16*1024*1024)throw new Error("Governance archive batch exceeds 16 MiB");
      const audit:Audit={...input,format:"traceforge.governance-archive.v1",outcome:"archived",authorizationRef:grant.authorizationRef,at:this.now(),results:[]};
      audit.results=[...archiveEntries.values()].map(e=>({...e,...archiveExecutionRow(this.sqlite,e.kind,e.key,audit.at)}));
      if(!(Date.parse(grant.expiresAt)>Date.parse(this.now())))throw new Error("Governance archive grant expired before commit");
      const body=JSON.stringify(audit);if(Buffer.byteLength(body)>65536)throw new Error("Governance archive audit too large");
      this.sqlite.prepare("INSERT INTO execution_archive_commands VALUES (?,?,?)").run(input.commandId,fingerprint,body);
      return {audit,replayed:false};
    })();return result;
  }

  candidates(value:unknown){
    const input=z.object({caseId:text,runId:text,kind,after:z.string().max(1024).default(""),limit:z.coerce.number().int().min(1).max(100).default(50)}).strict().parse(value);
    // Scan a bounded page of permanent keys. Ineligible rows are reported, not silently skipped.
    const rows=this.sqlite.prepare(`SELECT * FROM execution_governance_history WHERE case_id=? AND run_id=? AND kind=? AND entry_key>?
      ORDER BY entry_key LIMIT ?`).all(input.caseId,input.runId,input.kind,input.after,input.limit+1) as GovernanceHistoryIndex[];
    return {entries:rows.slice(0,input.limit).map(row=>{
      const record=this.inspect({caseId:input.caseId,runId:input.runId,kind:input.kind,key:row.entry_key});
      return {kind:row.kind,key:row.entry_key,...record};
    }),nextCursor:rows.length>input.limit?rows[input.limit-1]!.entry_key:null};
  }

  inspect(value:unknown){
    const input=z.object({caseId:text,runId:text,kind,key:text}).strict().parse(value);
    const saved=this.scoped(input.kind,input.key,input.caseId,input.runId);
    let eligible=true,blockedReason:string|null=null;
    try{this.eligible(saved);}catch(error){eligible=false;blockedReason=error instanceof Error?error.message:"Not eligible";}
    const archived=this.sqlite.prepare("SELECT digest,original_bytes AS originalBytes,length(payload) AS compressedBytes,created_at AS archivedAt FROM execution_archives WHERE kind=? AND entry_key=?")
      .get(input.kind,input.key) as {digest:string;originalBytes:number;compressedBytes:number;archivedAt:string}|undefined;
    const store=archiveStores[input.kind];
    const hot=this.sqlite.prepare(`SELECT ${store.fields.map(f=>`length(CAST(${f} AS BLOB))`).join("+")} AS bytes FROM ${store.table} WHERE command_id=?`).get(input.key) as {bytes:number};
    return {identity:saved.index,occupancyState:saved.occupancy.state,storage:archived?"cold":"hot",archive:archived??null,
      hotBodyBytes:hot.bytes,eligible,blockedReason,readOnly:true,automaticRetryAllowed:false};
  }

  private scoped(kind:GovernanceHistoryKind,key:string,caseId:string,runId:string){
    // Scope check precedes loading/decompressing potentially sensitive history.
    const index=this.sqlite.prepare("SELECT case_id,run_id FROM execution_governance_history WHERE kind=? AND entry_key=?").get(kind,key) as {case_id:string;run_id:string}|undefined;
    if(!index||index.case_id!==caseId||index.run_id!==runId)throw new Error("Governance history scope unavailable");
    return readGovernanceHistory(this.sqlite,kind,key);
  }
  private eligible(saved:ReturnType<typeof readGovernanceHistory>){
    if(saved.index.outcome!=="released"||saved.occupancy.state!=="released"
      || saved.occupancy.proof_ref!==(saved.index.kind==="processCleanup"?saved.index.evidence_ref:`managed-cleanup:${saved.index.entry_key}`))throw new Error("Only confirmed cleanup history can be archived");
    if(!Number.isFinite(Date.parse(saved.index.created_at))||Date.parse(this.now())-Date.parse(saved.index.created_at)<this.retentionMs)throw new Error("Governance history retention has not elapsed");
    if(saved.index.kind==="managedCleanup"&&!saved.evidenceKey)throw new Error("Managed cleanup has no retained signed evidence");
  }
}

export function registerGovernanceHistoryRoutes(app:FastifyInstance,control:GovernanceHistoryControl){
  const failure=(reply:import("fastify").FastifyReply,error:unknown)=>reply.code(isExecutionStorageCapacityError(error)?507:isExecutionStorageWriteError(error)?503:409).send({error:"Governance history operation rejected"});
  app.get("/api/security-tools/storage/governance-history",async(request,reply)=>{try{return control.inspect(request.query);}catch(error){return failure(reply,error);}});
  app.get("/api/security-tools/storage/governance-candidates",async(request,reply)=>{try{return control.candidates(request.query);}catch(error){return failure(reply,error);}});
  app.post("/api/security-tools/storage/governance-archive",{bodyLimit:65536},async(request,reply)=>{try{return await control.archive(request.body);}catch(error){return failure(reply,error);}});
}
