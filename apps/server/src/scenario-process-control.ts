import { createHash, createPublicKey, verify } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import type Database from "better-sqlite3";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { canonicalJson } from "@traceforge/orchestration-core";
import type { ProviderCapabilityReceipt, ScenarioCapabilityClaim } from "@traceforge/worker-runtime";
import { SqliteScenarioProcessSupervisionStore } from "./scenario-process-supervision.js";
import { ScenarioCapabilityRecoveryIssuer, scenarioCapabilityRecoverySigningPayload,
  type ScenarioCapabilityRecoveryAuthority, type SignedScenarioCapabilityRecoveryEvidence } from "./scenario-capability-recovery-issuer.js";
import { ScenarioProcessArchiveExportSigner, verifyScenarioProcessArchiveExport, type ScenarioProcessArchiveExportEnvelope } from "./scenario-process-archive-export.js";

const text=z.string().trim().min(1).max(1024),digest=z.string().regex(/^[a-f0-9]{64}$/),binding=z.object({id:text,version:text}).strict();
const claim=z.object({schemaVersion:z.literal(1),package:binding,generation:z.number().int().positive(),parentRequestId:text,
  capability:text,action:text,idempotencyKey:text,inputFingerprint:digest,attribution:z.object({caseId:text,runId:text,workId:text,
    workerId:text,scopeRef:text,leaseId:text}).strict(),startedAt:z.string().datetime()}).strict();
const receipt=z.object({id:text,provider:z.object({id:text,version:text,generation:z.number().int().positive()}).strict(),parentRequestId:text,
  capability:text,action:text,idempotencyKey:text,inputFingerprint:digest,attribution:z.record(z.string(),z.unknown()),status:z.literal("succeeded"),
  authorizationRef:text,output:z.unknown(),refs:z.array(z.string().max(2048)).max(1024),requestBytes:z.number().int().nonnegative(),
  responseBytes:z.number().int().nonnegative(),retryable:z.literal(false),startedAt:z.string().datetime(),completedAt:z.string().datetime(),
  replayed:z.boolean().optional()}).passthrough();
const envelope=z.object({format:z.literal("traceforge.scenario-capability-recovery.v1"),keyId:text,
  assertion:z.object({claim,outcome:z.enum(["succeeded","not_executed"]),receipt:receipt.nullable(),evidenceRef:text,
    issuedAt:z.string().datetime(),expiresAt:z.string().datetime()}).strict(),signature:z.string().max(128)}).strict();
const reconcileRequest=z.object({commandId:text,package:binding,idempotencyKey:text,actor:text,reason:text,evidence:z.unknown()}).strict();
const observeRequest=z.object({commandId:text,package:binding,idempotencyKey:text,issuerId:text,actor:text,reason:text}).strict();
const retireRequest=z.object({commandId:text,package:binding,source:text,actor:text,reason:text}).strict();
const exportRequest=z.object({commandId:text,package:binding,actor:text,reason:text}).strict();

export interface ScenarioProcessControlAuthorizer {authorize(input:{operation:"reconcile"|"retire"|"export";commandId:string;actor:string;reason:string;
  package:{id:string;version:string};idempotencyKey?:string}):Promise<{decision:"allowed";authorizationRef:string;expiresAt:string}|{decision:"denied"}>}
export interface ScenarioProcessControlOptions {authority?:(keyId:string)=>ScenarioCapabilityRecoveryAuthority|undefined;authorizer?:ScenarioProcessControlAuthorizer;
  recoveryIssuers?:readonly ScenarioCapabilityRecoveryIssuer[];archiveExportSigner?:ScenarioProcessArchiveExportSigner}

const hash=(value:unknown)=>createHash("sha256").update(canonicalJson(value)).digest("hex");
export {scenarioCapabilityRecoverySigningPayload};

/** Operator control plane for unresolved calls and retired Package-version storage. */
export class ScenarioProcessControl {
  constructor(private readonly sqlite:Database.Database,private readonly store:SqliteScenarioProcessSupervisionStore,
    private readonly options:ScenarioProcessControlOptions={},private readonly now=()=>new Date().toISOString()){
    const issuers=options.recoveryIssuers??[];if(new Set(issuers.map(item=>item.id)).size!==issuers.length||new Set(issuers.map(item=>item.keyId)).size!==issuers.length
      ||issuers.some(item=>options.authority?.(item.keyId)!==undefined))throw new Error("Duplicate Scenario capability recovery issuer or key");
    sqlite.exec(`CREATE TABLE IF NOT EXISTS scenario_process_recovery_evidence (
      evidence_ref TEXT PRIMARY KEY,envelope_json TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS scenario_process_control_audits (
      command_id TEXT PRIMARY KEY,request_fingerprint TEXT NOT NULL,audit_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS scenario_process_retired_archives (
      package_id TEXT NOT NULL,package_version TEXT NOT NULL,digest TEXT NOT NULL,payload BLOB NOT NULL,
      original_bytes INTEGER NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(package_id,package_version));
      CREATE TRIGGER IF NOT EXISTS scenario_process_recovery_evidence_immutable BEFORE UPDATE ON scenario_process_recovery_evidence BEGIN SELECT RAISE(ABORT,'Scenario Process recovery evidence is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS scenario_process_recovery_evidence_delete BEFORE DELETE ON scenario_process_recovery_evidence BEGIN SELECT RAISE(ABORT,'Scenario Process recovery evidence is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS scenario_process_control_audits_immutable BEFORE UPDATE ON scenario_process_control_audits BEGIN SELECT RAISE(ABORT,'Scenario Process control audit is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS scenario_process_control_audits_delete BEFORE DELETE ON scenario_process_control_audits BEGIN SELECT RAISE(ABORT,'Scenario Process control audit is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS scenario_process_retired_archives_immutable BEFORE UPDATE ON scenario_process_retired_archives BEGIN SELECT RAISE(ABORT,'Scenario Process retired archive is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS scenario_process_retired_archives_delete BEFORE DELETE ON scenario_process_retired_archives BEGIN SELECT RAISE(ABORT,'Scenario Process retired archive is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS scenario_process_control_audit_capacity BEFORE INSERT ON scenario_process_control_audits BEGIN
        SELECT CASE WHEN (SELECT count(*) FROM scenario_process_control_audits)>=100000 OR length(CAST(NEW.audit_json AS BLOB))>65536 THEN RAISE(ABORT,'Scenario Process control audit capacity exceeded') END;
        SELECT execution_physical_admit(recovery_floor,maximum_database_bytes,maximum_wal_bytes,81920,'recovery') FROM execution_physical_policy WHERE id=1; END;
      CREATE TRIGGER IF NOT EXISTS scenario_process_evidence_capacity BEFORE INSERT ON scenario_process_recovery_evidence BEGIN
        SELECT CASE WHEN (SELECT count(*) FROM scenario_process_recovery_evidence)>=100000 OR length(CAST(NEW.envelope_json AS BLOB))>8388608 THEN RAISE(ABORT,'Scenario Process recovery evidence capacity exceeded') END;
        SELECT execution_physical_admit(recovery_floor,maximum_database_bytes,maximum_wal_bytes,length(CAST(NEW.envelope_json AS BLOB))+8192,'recovery') FROM execution_physical_policy WHERE id=1; END;
      CREATE TRIGGER IF NOT EXISTS scenario_process_retired_archive_capacity BEFORE INSERT ON scenario_process_retired_archives BEGIN
        SELECT CASE WHEN (SELECT count(*) FROM scenario_process_retired_archives)>=10000 OR NEW.original_bytes>16777216 OR length(NEW.payload)>16777216 THEN RAISE(ABORT,'Scenario Process retired archive capacity exceeded') END;
        SELECT execution_physical_admit(recovery_floor,maximum_database_bytes,maximum_wal_bytes,length(NEW.payload)+8192,'recovery') FROM execution_physical_policy WHERE id=1; END;`);
  }

  inventory(value:unknown){const input=z.object({packageId:text.optional(),version:text.optional(),status:z.enum(["pending","retry_allowed","succeeded","archived"]).optional(),
    after:text.optional(),limit:z.coerce.number().int().min(1).max(100).default(50)}).strict().parse(value);
    const clauses=["(package_id||char(0)||package_version||char(0)||idempotency_key) > ?"],args:unknown[]=[input.after??""];
    if(input.packageId){clauses.push("package_id = ?");args.push(input.packageId);}if(input.version){clauses.push("package_version = ?");args.push(input.version);}
    if(input.status){clauses.push("status = ?");args.push(input.status);}args.push(input.limit+1);
    const rows=this.sqlite.prepare(`SELECT package_id AS packageId,package_version AS packageVersion,idempotency_key AS idempotencyKey,
      fingerprint,status,claim_digest AS claimDigest,attempt,recovery_evidence_ref AS recoveryEvidenceRef,started_at AS startedAt,completed_at AS completedAt,
      receipt_digest AS receiptDigest FROM scenario_process_capability_receipts WHERE ${clauses.join(" AND ")} ORDER BY package_id,package_version,idempotency_key LIMIT ?`).all(...args) as Record<string,unknown>[];
    const page=rows.slice(0,input.limit),last=page.at(-1);return {records:page,nextCursor:rows.length>input.limit?`${last!.packageId}\0${last!.packageVersion}\0${last!.idempotencyKey}`:null};}

  generations(value:unknown){const input=z.object({packageId:text.optional(),version:text.optional(),after:text.optional(),limit:z.coerce.number().int().min(1).max(100).default(50)}).strict().parse(value);
    const clauses=["(package_id||char(0)||package_version||char(0)||printf('%020d',generation)) > ?"],args:unknown[]=[input.after??""];
    if(input.packageId){clauses.push("package_id=?");args.push(input.packageId);}if(input.version){clauses.push("package_version=?");args.push(input.version);}args.push(input.limit+1);
    const rows=this.sqlite.prepare(`SELECT package_id AS packageId,package_version AS packageVersion,source,generation,state,detail_digest AS detailDigest,
      reserved_at AS reservedAt,updated_at AS updatedAt FROM scenario_process_generations WHERE ${clauses.join(" AND ")} ORDER BY package_id,package_version,generation LIMIT ?`).all(...args) as Record<string,unknown>[];
    const page=rows.slice(0,input.limit),last=page.at(-1);return {generations:page,nextCursor:rows.length>input.limit?`${last!.packageId}\0${last!.packageVersion}\0${String(last!.generation).padStart(20,"0")}`:null};}

  retiredArchives(value:unknown){const input=z.object({after:text.optional(),limit:z.coerce.number().int().min(1).max(100).default(50)}).strict().parse(value);
    const rows=this.sqlite.prepare(`SELECT package_id,package_version,digest,payload,original_bytes,created_at FROM scenario_process_retired_archives
      WHERE (package_id||char(0)||package_version)>? ORDER BY package_id,package_version LIMIT ?`).all(input.after??"",input.limit+1) as
      {package_id:string;package_version:string;digest:string;payload:Buffer;original_bytes:number;created_at:string}[];
    const verified=rows.map(row=>{const body=gunzipSync(row.payload,{maxOutputLength:16*1024*1024}).toString("utf8");if(Buffer.byteLength(body)!==row.original_bytes||hash(JSON.parse(body))!==row.digest)throw new Error("Scenario Process retired archive is corrupt");
      const parsed=JSON.parse(body) as any;if(parsed.format!=="traceforge.scenario-process-retired-receipts.v1"||parsed.package?.id!==row.package_id||parsed.package?.version!==row.package_version)throw new Error("Scenario Process retired archive identity mismatch");
      return {packageId:row.package_id,packageVersion:row.package_version,digest:row.digest,originalBytes:row.original_bytes,compressedBytes:row.payload.length,recordCount:Array.isArray(parsed.records)?parsed.records.length:0,createdAt:row.created_at};});
    const page=verified.slice(0,input.limit),last=page.at(-1);return {archives:page,nextCursor:rows.length>input.limit?`${last!.packageId}\0${last!.packageVersion}`:null};}

  supervision(value:unknown){const input=z.object({packageId:text.optional(),after:text.optional(),limit:z.coerce.number().int().min(1).max(100).default(50)}).strict().parse(value);
    const rows=(input.packageId?this.sqlite.prepare(`SELECT * FROM scenario_process_supervision WHERE package_id=? AND package_version>? ORDER BY package_version LIMIT ?`).all(input.packageId,input.after??"",input.limit+1)
      :this.sqlite.prepare(`SELECT * FROM scenario_process_supervision WHERE (package_id||char(0)||package_version)>? ORDER BY package_id,package_version LIMIT ?`).all(input.after??"",input.limit+1)) as Record<string,unknown>[];
    const page=rows.slice(0,input.limit);const last=page.at(-1);return {processes:page,nextCursor:rows.length>input.limit?(input.packageId?String(last!.package_version):`${last!.package_id}\0${last!.package_version}`):null};}

  async reconcile(value:unknown){const input=reconcileRequest.parse(structuredClone(value)),requestFingerprint=hash(input);
    return this.reconcileWith(input,requestFingerprint,async()=>input.evidence);}

  async observeAndReconcile(value:unknown){const input=observeRequest.parse(structuredClone(value)),requestFingerprint=hash(input),issuer=this.options.recoveryIssuers?.find(item=>item.id===input.issuerId);
    if(!issuer)throw new Error("Scenario capability recovery issuer is unavailable");
    return this.reconcileWith(input,requestFingerprint,claimValue=>issuer.issue(claimValue));}

  private async reconcileWith(input:z.infer<typeof reconcileRequest>|z.infer<typeof observeRequest>,requestFingerprint:string,evidence: (claim:ScenarioCapabilityClaim)=>Promise<unknown>){const prior=this.audit(input.commandId);
    if(prior){if(prior.requestFingerprint!==requestFingerprint)throw new Error("Scenario Process control command conflicts");return {audit:prior,replayed:true};}
    const row=this.capability(input.package,input.idempotencyKey);if(!row)throw new Error("Unknown Scenario Process capability claim");
    if(row.status!=="pending")throw new Error(`Scenario Process capability is ${row.status}, not pending`);
    const claimValue=this.readClaim(row),grant=await this.authorize({operation:"reconcile",...input});
    if(grant.decision!=="allowed")return this.recordDenied(input,requestFingerprint,"reconcile");
    let verified:SignedScenarioCapabilityRecoveryEvidence;
    try{verified=this.verifyEvidence(await evidence(claimValue),claimValue);}catch(error){
      const audit=this.insertAudit(input.commandId,requestFingerprint,{operation:"reconcile",commandId:input.commandId,package:input.package,
        idempotencyKey:input.idempotencyKey,actor:input.actor,reason:input.reason,outcome:"rejected",failure:"Recovery evidence could not be trusted",at:this.now()});
      throw Object.assign(new Error("Scenario Process recovery evidence could not be trusted"),{audit,cause:error});}
    const evidenceRef=`scenario-recovery-evidence:${hash(verified)}`;
    const audit=this.sqlite.transaction(()=>{if(Date.parse(grant.expiresAt)<=Date.parse(this.now()))throw new Error("Scenario Process control authorization expired");
      const current=this.capability(input.package,input.idempotencyKey);if(!current||current.status!=="pending"||current.claim_digest!==row.claim_digest)throw new Error("Scenario Process capability changed during reconciliation");
      const body=canonicalJson(verified),saved=this.sqlite.prepare("SELECT envelope_json FROM scenario_process_recovery_evidence WHERE evidence_ref=?").get(evidenceRef) as {envelope_json:string}|undefined;
      if(saved&&saved.envelope_json!==body)throw new Error("Scenario Process recovery evidence conflict");if(!saved)this.sqlite.prepare("INSERT INTO scenario_process_recovery_evidence VALUES (?,?,?)").run(evidenceRef,body,this.now());
      if(verified.assertion.outcome==="succeeded")this.store.settleCapabilityReceipt(input.package,claimValue.inputFingerprint,verified.assertion.receipt as unknown as ProviderCapabilityReceipt);
      else if(this.sqlite.prepare(`UPDATE scenario_process_capability_receipts SET status='retry_allowed',recovery_evidence_ref=? WHERE package_id=? AND package_version=? AND idempotency_key=? AND status='pending'`)
        .run(evidenceRef,input.package.id,input.package.version,input.idempotencyKey).changes!==1)throw new Error("Scenario Process retry release conflict");
      if(verified.assertion.outcome==="succeeded")this.sqlite.prepare(`UPDATE scenario_process_capability_receipts SET recovery_evidence_ref=? WHERE package_id=? AND package_version=? AND idempotency_key=?`).run(evidenceRef,input.package.id,input.package.version,input.idempotencyKey);
      return this.insertAudit(input.commandId,requestFingerprint,{operation:"reconcile",commandId:input.commandId,package:input.package,idempotencyKey:input.idempotencyKey,
        actor:input.actor,reason:input.reason,outcome:verified.assertion.outcome==="succeeded"?"resolved_succeeded":"resolved_retry_allowed",
        evidenceRef,authorizationRef:grant.authorizationRef,at:this.now()});})();
    return {audit,replayed:false};}

  async retire(value:unknown){const input=retireRequest.parse(structuredClone(value)),requestFingerprint=hash(input),prior=this.audit(input.commandId);
    if(prior){if(prior.requestFingerprint!==requestFingerprint)throw new Error("Scenario Process control command conflicts");return {audit:prior,replayed:true};}
    const grant=await this.authorize({operation:"retire",...input});if(grant.decision!=="allowed")return this.recordDenied(input,requestFingerprint,"retire");
    const audit=this.sqlite.transaction(()=>{if(Date.parse(grant.expiresAt)<=Date.parse(this.now()))throw new Error("Scenario Process control authorization expired");
      const process=this.sqlite.prepare("SELECT source,state,revoked_reason FROM scenario_process_supervision WHERE package_id=? AND package_version=?").get(input.package.id,input.package.version) as {source:string;state:string;revoked_reason:string|null}|undefined;
      if(!process||process.source!==input.source)throw new Error("Unknown Scenario Process version");if(!process.revoked_reason||process.state!=="revoked")throw new Error("Scenario Process version must be revoked before retirement");
      if(this.sqlite.prepare(`SELECT 1 FROM scenario_process_generations WHERE package_id=? AND package_version=? AND state IN ('reserved','started','ready') LIMIT 1`).get(input.package.id,input.package.version))throw new Error("Active Scenario Process generation prevents retirement");
      if(this.sqlite.prepare(`SELECT 1 FROM process_execution_occupancy WHERE json_extract(identity_json,'$.source')=? AND json_extract(identity_json,'$.version')=?
        AND json_extract(identity_json,'$.operation') LIKE 'scenario-process:generation:%' AND state!='released' LIMIT 1`).get(input.source,input.package.version))throw new Error("Unreleased Scenario Process occupancy prevents retirement");
      if(this.sqlite.prepare(`SELECT 1 FROM scenario_process_capability_receipts WHERE package_id=? AND package_version=? AND status='pending' LIMIT 1`).get(input.package.id,input.package.version))throw new Error("Unresolved capability prevents Scenario Process retirement");
      const rows=this.sqlite.prepare("SELECT * FROM scenario_process_capability_receipts WHERE package_id=? AND package_version=? ORDER BY idempotency_key").all(input.package.id,input.package.version);
      const body=canonicalJson({format:"traceforge.scenario-process-retired-receipts.v1",package:input.package,records:rows}),originalBytes=Buffer.byteLength(body);
      if(originalBytes>16*1024*1024)throw new Error("Scenario Process retired archive exceeds 16 MiB");const payload=gzipSync(body),archiveDigest=hash(JSON.parse(body));
      this.sqlite.prepare("INSERT INTO scenario_process_retired_archives VALUES (?,?,?,?,?,?)").run(input.package.id,input.package.version,archiveDigest,payload,originalBytes,this.now());
      this.sqlite.prepare(`UPDATE scenario_process_capability_receipts SET status='archived',receipt_json=NULL WHERE package_id=? AND package_version=?`).run(input.package.id,input.package.version);
      this.sqlite.prepare(`UPDATE scenario_process_supervision SET state='retired',updated_at=? WHERE package_id=? AND package_version=? AND state='revoked'`).run(this.now(),input.package.id,input.package.version);
      return this.insertAudit(input.commandId,requestFingerprint,{operation:"retire",...input,outcome:"retired",authorizationRef:grant.authorizationRef,
        archiveDigest,recordCount:rows.length,originalBytes,compressedBytes:payload.length,at:this.now()});})();return {audit,replayed:false};}

  async exportRetired(value:unknown){const input=exportRequest.parse(structuredClone(value)),requestFingerprint=hash(input),prior=this.audit(input.commandId),signer=this.options.archiveExportSigner;
    if(!signer)throw new Error("Scenario Process archive export is disabled");if(prior&&prior.requestFingerprint!==requestFingerprint)throw new Error("Scenario Process control command conflicts");
    const grant=await this.authorize({operation:"export",...input});if(grant.decision!=="allowed")return this.recordDenied(input,requestFingerprint,"export");
    if(prior){if(prior.outcome!=="exported")throw new Error("Scenario Process export command did not complete");const archive=this.exportEnvelope(input.package,prior);
      verifyScenarioProcessArchiveExport(archive,signer.authority(),this.now());return {audit:prior,archive,replayed:true};}
    const row=this.retiredArchive(input.package),archive=signer.sign({package:input.package,archiveDigest:row.digest,originalBytes:row.original_bytes,
      compressedBytes:row.payload.length,createdAt:row.created_at,payloadBase64:row.payload.toString("base64")});
    verifyScenarioProcessArchiveExport(archive,signer.authority(),this.now());
    const audit=this.sqlite.transaction(()=>{if(Date.parse(grant.expiresAt)<=Date.parse(this.now()))throw new Error("Scenario Process control authorization expired");
      const current=this.retiredArchive(input.package);if(current.digest!==row.digest||!current.payload.equals(row.payload))throw new Error("Scenario Process retired archive changed during export");
      return this.insertAudit(input.commandId,requestFingerprint,{operation:"export",...input,outcome:"exported",authorizationRef:grant.authorizationRef,
        keyId:archive.keyId,signature:archive.signature,exportedAt:archive.exportedAt,archiveDigest:archive.archiveDigest,at:this.now()});})();
    return {audit,archive,replayed:false};}

  history(value:unknown){const input=z.object({after:text.optional(),limit:z.coerce.number().int().min(1).max(100).default(50)}).strict().parse(value);
    const rows=this.sqlite.prepare("SELECT command_id,audit_json FROM scenario_process_control_audits WHERE command_id>? ORDER BY command_id LIMIT ?").all(input.after??"",input.limit+1) as {command_id:string;audit_json:string}[];
    return {audits:rows.slice(0,input.limit).map(row=>JSON.parse(row.audit_json)),nextCursor:rows.length>input.limit?rows[input.limit-1]!.command_id:null};}

  private verifyEvidence(value:unknown,expected:ScenarioCapabilityClaim){if(Buffer.byteLength(canonicalJson(value))>8*1024*1024)throw new Error("Evidence exceeds capacity");
    const signed=envelope.parse(structuredClone(value)),issuer=this.options.recoveryIssuers?.find(item=>item.keyId===signed.keyId),authority=this.options.authority?.(signed.keyId)??issuer?.authority(),at=Date.parse(this.now()),issued=Date.parse(signed.assertion.issuedAt),expires=Date.parse(signed.assertion.expiresAt);
    if(!authority||authority.revoked||!authority.packageIds.includes(expected.package.id)||!authority.capabilities.includes(expected.capability))throw new Error("Recovery authority is outside scope");
    if(!Number.isSafeInteger(authority.maximumAgeMs)||authority.maximumAgeMs<1||![at,issued,expires,Date.parse(authority.validFrom),Date.parse(authority.validUntil)].every(Number.isFinite)
      ||issued>at||issued<Date.parse(authority.validFrom)||expires> Date.parse(authority.validUntil)||expires<=at||expires<=issued||at-issued>authority.maximumAgeMs||expires-issued>authority.maximumAgeMs)throw new Error("Recovery evidence is not temporally valid");
    const bytes=Buffer.from(signed.signature,"base64"),key=createPublicKey(authority.publicKeyPem),{signature,...payload}=signed;
    if(key.asymmetricKeyType!=="ed25519"||bytes.length!==64||bytes.toString("base64")!==signed.signature||!verify(null,Buffer.from(scenarioCapabilityRecoverySigningPayload(payload)),key,bytes))throw new Error("Recovery evidence signature is invalid");
    if(canonicalJson(signed.assertion.claim)!==canonicalJson(expected))throw new Error("Recovery evidence claim mismatch");
    if((signed.assertion.outcome==="succeeded")!==!!signed.assertion.receipt)throw new Error("Recovery evidence outcome mismatch");
    if(signed.assertion.receipt){const result=signed.assertion.receipt;if(result.provider.id!==expected.package.id||result.provider.version!==expected.package.version||result.provider.generation!==expected.generation
      ||result.parentRequestId!==expected.parentRequestId||result.capability!==expected.capability||result.action!==expected.action||result.idempotencyKey!==expected.idempotencyKey
      ||result.inputFingerprint!==expected.inputFingerprint||result.startedAt!==expected.startedAt
      ||result.attribution.caseId!==expected.attribution.caseId||result.attribution.runId!==expected.attribution.runId||result.attribution.workId!==expected.attribution.workId
      ||result.attribution.workerId!==expected.attribution.workerId||result.attribution.scopeRef!==expected.attribution.scopeRef||result.attribution.leaseId!==expected.attribution.leaseId)throw new Error("Recovered receipt identity mismatch");}
    return signed as unknown as SignedScenarioCapabilityRecoveryEvidence;}
  private capability(pkg:{id:string;version:string},key:string){return this.sqlite.prepare("SELECT * FROM scenario_process_capability_receipts WHERE package_id=? AND package_version=? AND idempotency_key=?").get(pkg.id,pkg.version,key) as any;}
  private retiredArchive(pkg:{id:string;version:string}){const row=this.sqlite.prepare("SELECT digest,payload,original_bytes,created_at FROM scenario_process_retired_archives WHERE package_id=? AND package_version=?").get(pkg.id,pkg.version) as {digest:string;payload:Buffer;original_bytes:number;created_at:string}|undefined;
    if(!row)throw new Error("Scenario Process retired archive is unavailable");const raw=gunzipSync(row.payload,{maxOutputLength:16*1024*1024}).toString("utf8"),decoded=JSON.parse(raw) as any;
    if(Buffer.byteLength(raw)!==row.original_bytes||hash(decoded)!==row.digest||decoded.format!=="traceforge.scenario-process-retired-receipts.v1"||decoded.package?.id!==pkg.id||decoded.package?.version!==pkg.version)throw new Error("Scenario Process retired archive is corrupt");return row;}
  private exportEnvelope(pkg:{id:string;version:string},audit:any):ScenarioProcessArchiveExportEnvelope{const row=this.retiredArchive(pkg);return {format:"traceforge.scenario-process-retired-archive.v1",keyId:audit.keyId,package:pkg,
    archiveDigest:row.digest,originalBytes:row.original_bytes,compressedBytes:row.payload.length,createdAt:row.created_at,exportedAt:audit.exportedAt,payloadBase64:row.payload.toString("base64"),signature:audit.signature};}
  private readClaim(row:any):ScenarioCapabilityClaim{if(!row.claim_json||hash(JSON.parse(row.claim_json))!==row.claim_digest)throw new Error("Scenario Process capability claim is corrupt");return claim.parse(JSON.parse(row.claim_json));}
  private async authorize(input:any){let timer:ReturnType<typeof setTimeout>|undefined;const grant=await Promise.race([
    this.options.authorizer?.authorize(structuredClone(input))??Promise.resolve({decision:"denied" as const}),
    new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("Scenario Process control authorization deadline")),10000);}),
  ]).finally(()=>{if(timer)clearTimeout(timer);});if(grant.decision==="allowed"&&(!grant.authorizationRef.trim()||!(Date.parse(grant.expiresAt)>Date.parse(this.now()))))throw new Error("Scenario Process control authorization is invalid");return grant;}
  private recordDenied(input:any,fingerprint:string,operation:string){const audit=this.insertAudit(input.commandId,fingerprint,{operation,...input,evidence:undefined,outcome:"denied",at:this.now()});return {audit,replayed:false};}
  private audit(commandId:string):any{const row=this.sqlite.prepare("SELECT request_fingerprint,audit_json FROM scenario_process_control_audits WHERE command_id=?").get(commandId) as {request_fingerprint:string;audit_json:string}|undefined;return row?{...JSON.parse(row.audit_json),requestFingerprint:row.request_fingerprint}:undefined;}
  private insertAudit(commandId:string,requestFingerprint:string,audit:any){const body=canonicalJson(audit);this.sqlite.prepare("INSERT INTO scenario_process_control_audits VALUES (?,?,?)").run(commandId,requestFingerprint,body);return {...audit,requestFingerprint};}
}

export function registerScenarioProcessControlRoutes(app:FastifyInstance,control:ScenarioProcessControl){
  app.get("/api/security-tools/scenario-processes",async(request,reply)=>route(reply,()=>control.supervision(request.query)));
  app.get("/api/security-tools/scenario-process-generations",async(request,reply)=>route(reply,()=>control.generations(request.query)));
  app.get("/api/security-tools/scenario-process-capabilities",async(request,reply)=>route(reply,()=>control.inventory(request.query)));
  app.get("/api/security-tools/scenario-process-retired-archives",async(request,reply)=>route(reply,()=>control.retiredArchives(request.query)));
  app.get("/api/security-tools/scenario-process-control/audits",async(request,reply)=>route(reply,()=>control.history(request.query)));
  app.post("/api/security-tools/scenario-process-control/reconcile",{bodyLimit:8*1024*1024},async(request,reply)=>route(reply,()=>control.reconcile(request.body)));
  app.post("/api/security-tools/scenario-process-control/observe-reconcile",async(request,reply)=>route(reply,()=>control.observeAndReconcile(request.body)));
  app.post("/api/security-tools/scenario-process-control/retire",async(request,reply)=>route(reply,()=>control.retire(request.body)));
  app.post("/api/security-tools/scenario-process-control/export-retired",async(request,reply)=>route(reply,()=>control.exportRetired(request.body)));
}
async function route(reply:FastifyReply,fn:()=>unknown){try{const result:any=await fn();return result?.audit?.outcome==="denied"?reply.code(403).send(result):result;}
  catch(error){return reply.code(error instanceof z.ZodError?400:409).send({error:error instanceof Error?error.message:"Scenario Process control failed"});}}
