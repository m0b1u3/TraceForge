import { sign } from "node:crypto";
import type Database from "better-sqlite3";
import { ToolProviderFairScheduler, type ToolExecutionContext } from "@traceforge/worker-runtime";
import { ProcessExecutionCapacity, processCleanupSigningPayload, type SignedProcessCleanup } from "../process-execution-capacity.js";
import { ManagedExecutionCapacity } from "../managed-execution-capacity.js";
import { SqliteProcessExecutionJournal } from "../execution-process-journal.js";
import { SignedToolRecoveryEvidenceVerifier } from "../tool-recovery-evidence.js";
import { at, authority, evidence, initialize, keys, signEvidence } from "./execution-recovery.js";
import type { GovernanceHistoryKind } from "../db/governance-history.js";

export const archiveAt="2026-08-31T01:00:00.000Z";
export const archiveAllow={async authorize(){return {decision:"allowed" as const,authorizationRef:"test-only archive grant",expiresAt:"2099-01-01T00:00:00.000Z"};}};
export const cleanupAllow={async authorize(){return {decision:"allowed" as const,authorizationRef:"test-only cleanup grant",expiresAt:"2099-01-01T00:00:00.000Z",reason:"test-only grant"};}};
export function archiveRequest(kind:GovernanceHistoryKind){return {commandId:"archive",actor:"operator",reason:"Archive verified history",caseId:"case",runId:kind==="managedCleanup"?"run":"service",entries:[{kind,key:"cleanup"}]};}

/** Mechanism-only fixture: signed independent cleanup, no model or real sandbox certification. */
export async function seedGovernanceHistory(sqlite:Database.Database,kind:GovernanceHistoryKind){
  const scheduler=new ToolProviderFairScheduler({global:1,maximumWaitMs:10});
  const attribution={caseId:"case",runId:kind==="managedCleanup"?"run":"service",workId:"work",leaseId:"lease",workerId:"worker",
    leaseExpiresAt:"2099-01-01T00:00:00.000Z",scopeRef:"scope",actionId:"observe",idempotencyKey:kind==="processCleanup"?"service-call":"call"};
  const journal=new SqliteProcessExecutionJournal(sqlite);
  const identity={caseId:attribution.caseId,runId:attribution.runId,workId:"work",leaseId:"lease",idempotencyKey:attribution.idempotencyKey,requestId:"request"};
  const launch={nodeId:"node",generationId:"generation",requestId:"request",launchId:"a".repeat(64),requestFingerprint:"b".repeat(64)};
  const trusted={...authority(),processAcceptance:{reference:"test-only acceptance",nodeIds:["node"]}};
  const claim=()=>journal.claim({schemaVersion:2,identity,launch,nodeId:"node",requestFingerprint:launch.requestFingerprint,status:"claimed",cleanup:"unverified",process:null,events:[],lostEvents:false,updatedAt:at});
  if(kind==="processCleanup"){
    const capacity=new ProcessExecutionCapacity(sqlite,scheduler,()=>at);
    const lease=await capacity.acquire({source:"neutral",version:"1",operation:"discover",kind:"service",attribution});
    lease.beforeStart("request");claim();lease.finish(true);
    const record=capacity.list("case","service").items[0]!;
    const payload:Omit<SignedProcessCleanup,"signature">={format:"traceforge.process-cleanup.v1",keyId:"key",occupancyId:record.id,identity:record.identity,
      process:{identity,launch},cleanup:"terminal",evidenceRef:"test-only independent report",issuedAt:at,expiresAt:"2026-08-30T00:05:00.000Z"};
    const request={commandId:"cleanup",actor:"operator",reason:"Confirmed neutral cleanup",occupancyId:record.id,evidence:{...payload,
      signature:sign(null,Buffer.from(processCleanupSigningPayload(payload)),keys.privateKey).toString("base64")}};
    const replay=()=>capacity.release(request,cleanupAllow,()=>trusted);
    const released=await replay();
    return {scheduler,request,replay,released,occupancyKey:record.id,inspect:()=>capacity.inspect(record.id),trusted};
  }
  const c=initialize(sqlite);
  await c.bindings.prepare({idempotencyKey:"call",invocationId:"first",tool:{name:"observe",source:"neutral",version:"1",contractFingerprint:"a".repeat(64)},
    inputFingerprint:"b".repeat(64),attribution:{caseId:"case",runId:"run",workId:"work"}});
  await c.bindings.beginExecution("call","lease","worker");
  const capacity=new ManagedExecutionCapacity(sqlite,scheduler,c.bindings,()=>at);
  const scheduling={providerId:"neutral.provider",providerVersion:"1",toolName:"observe",caseId:"case",runId:"run",workId:"work"};
  const permit=await scheduler.acquire(scheduling);
  capacity.reserve(scheduling,"neutral",{...attribution} as unknown as ToolExecutionContext);
  capacity.beforeStart("call","request");claim();capacity.finish("call",true);permit.release();
  const payload=evidence(c);payload.process={identity,launch};payload.assertion.cleanup.status="terminal";
  const request={commandId:"cleanup",actor:"operator",reason:"Confirm neutral cleanup",idempotencyKey:"call",evidence:signEvidence(payload)};
  const verifier=new SignedToolRecoveryEvidenceVerifier(sqlite,()=>trusted,()=>at);
  const replay=()=>capacity.release(request,cleanupAllow,verifier);
  const released=await replay();
  return {scheduler,request,replay,released,occupancyKey:"call",inspect:()=>capacity.inspect("call"),trusted};
}
