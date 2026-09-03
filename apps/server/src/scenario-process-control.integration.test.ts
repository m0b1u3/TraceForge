import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { canonicalJson } from "@traceforge/orchestration-core";
import { SCENARIO_PROCESS_PROTOCOL, ToolProviderFairScheduler, type ProviderCapabilityReceipt, type ScenarioCapabilityClaim, type ScenarioProcessManifest } from "@traceforge/worker-runtime";
import { database } from "./test-fixtures/execution-recovery.js";
import { ProcessExecutionCapacity } from "./process-execution-capacity.js";
import { ScenarioProcessControl, scenarioCapabilityRecoverySigningPayload } from "./scenario-process-control.js";
import { SqliteScenarioProcessSupervisionStore } from "./scenario-process-supervision.js";
import { ScenarioCapabilityRecoveryIssuer } from "./scenario-capability-recovery-issuer.js";
import { ScenarioProcessArchiveExportSigner, verifyScenarioProcessArchiveExport } from "./scenario-process-archive-export.js";
import { verifyScenarioCapabilityRecoveryObserver } from "./scenario-capability-observer-acceptance.js";

const databases:Database.Database[]=[];afterEach(()=>{for(const sqlite of databases.splice(0))if(sqlite.open)sqlite.close();});
const now="2026-09-02T00:00:30.000Z",manifest:ScenarioProcessManifest={protocol:SCENARIO_PROCESS_PROTOCOL,protocolVersion:1,id:"fixture.package",
  version:"1.0.0",source:"scenario:fixture.package",entrypoint:"package://runtime/main.mjs",providedCapabilities:["fixture.observe"],hostCapabilities:["fixture.lookup"]};
const claim:ScenarioCapabilityClaim={schemaVersion:1,package:{id:manifest.id,version:manifest.version},generation:1,parentRequestId:"parent",
  capability:"fixture.lookup",action:"fixture.inspect",idempotencyKey:"stable",inputFingerprint:"d".repeat(64),
  attribution:{caseId:"case",runId:"run",workId:"work",workerId:"worker",scopeRef:"scope",leaseId:"lease"},startedAt:"2026-09-02T00:00:00.000Z"};
const receipt:ProviderCapabilityReceipt={id:"receipt",provider:{id:manifest.id,version:manifest.version,generation:1},parentRequestId:claim.parentRequestId,
  capability:claim.capability,action:claim.action,idempotencyKey:claim.idempotencyKey,inputFingerprint:claim.inputFingerprint,
  attribution:{...claim.attribution,leaseExpiresAt:"2100-01-01T00:00:00.000Z",idempotencyKey:"effect"},status:"succeeded",authorizationRef:"authorization",
  output:{available:true},refs:["evidence:first"],requestBytes:1,responseBytes:1,retryable:false,startedAt:claim.startedAt,completedAt:"2026-09-02T00:00:10.000Z"};
const hashValue=(value:unknown)=>createHash("sha256").update(canonicalJson(value)).digest("hex");

function setup(){const sqlite=database();databases.push(sqlite);new ProcessExecutionCapacity(sqlite,new ToolProviderFairScheduler(),()=>now);
  const keys=generateKeyPairSync("ed25519"),store=new SqliteScenarioProcessSupervisionStore(sqlite,()=>now);
  const control=new ScenarioProcessControl(sqlite,store,{authority:key=>key==="recovery"?{publicKeyPem:keys.publicKey.export({type:"spki",format:"pem"}).toString(),
    packageIds:[manifest.id],capabilities:[claim.capability],validFrom:"2026-09-01T00:00:00.000Z",validUntil:"2026-09-03T00:00:00.000Z",maximumAgeMs:3600000}:undefined,
    authorizer:{async authorize(){return {decision:"allowed",authorizationRef:"operator-policy",expiresAt:"2026-09-02T00:05:00.000Z"};}}},()=>now);
  const evidence=(outcome:"succeeded"|"not_executed")=>{const payload={format:"traceforge.scenario-capability-recovery.v1" as const,keyId:"recovery",
    assertion:{claim,outcome,receipt:outcome==="succeeded"?receipt:null,evidenceRef:"execution-node:observation",
      issuedAt:"2026-09-02T00:00:20.000Z",expiresAt:"2026-09-02T00:05:00.000Z"}};
    return {...payload,signature:sign(null,Buffer.from(scenarioCapabilityRecoverySigningPayload(payload)),keys.privateKey).toString("base64")};};
  return {sqlite,store,control,evidence};}

describe("Scenario Process operator control",()=>{
  it("settles an unresolved capability only from scoped signed evidence and preserves an idempotent audit",async()=>{const {store,control,evidence}=setup();
    expect(store.claimCapabilityReceipt(manifest,claim)).toBe(true);const request={commandId:"reconcile-1",package:claim.package,idempotencyKey:claim.idempotencyKey,
      actor:"operator",reason:"execution node confirmed the terminal result",evidence:evidence("succeeded")};
    const first=await control.reconcile(request),replay=await control.reconcile(structuredClone(request));expect(first.audit.outcome).toBe("resolved_succeeded");
    expect(replay.replayed).toBe(true);expect(store.getCapabilityReceipt(claim.package,claim.idempotencyKey)).toMatchObject({status:"succeeded",receipt:{output:{available:true}}});
    expect(control.inventory({status:"succeeded"}).records).toHaveLength(1);expect(control.history({}).audits).toHaveLength(1);});

  it("releases a definitely-not-executed call for one identity-preserving retry",async()=>{const {store,control,evidence}=setup();
    store.claimCapabilityReceipt(manifest,claim);await control.reconcile({commandId:"reconcile-2",package:claim.package,idempotencyKey:claim.idempotencyKey,
      actor:"operator",reason:"dispatch was rejected before execution",evidence:evidence("not_executed")});
    expect(store.getCapabilityReceipt(claim.package,claim.idempotencyKey)).toMatchObject({status:"retry_allowed"});
    expect(store.claimCapabilityReceipt(manifest,{...claim,generation:2,startedAt:"2026-09-02T00:01:00.000Z"})).toBe(true);
    expect(store.getCapabilityReceipt(claim.package,claim.idempotencyKey)).toMatchObject({status:"pending"});
    expect(()=>store.claimCapabilityReceipt(manifest,{...claim,generation:2,startedAt:"2026-09-02T00:01:00.000Z"})).not.toThrow();});

  it("uses an accepted scoped observer/issuer, rejects a revoked evidence generation, and accepts a rotated key",async()=>{const {sqlite,store}=setup();store.claimCapabilityReceipt(manifest,claim);let revoked=false;
    const oldKeys=generateKeyPairSync("ed25519"),fact={terminal:true},observer={async observe(value:typeof claim,signal:AbortSignal){signal.throwIfAborted();const current=value.idempotencyKey===claim.idempotencyKey?receipt:{...receipt,idempotencyKey:value.idempotencyKey,inputFingerprint:value.inputFingerprint,parentRequestId:value.parentRequestId};
      return {outcome:"succeeded" as const,receipt:current,evidenceRef:"execution-node:terminal"};}},secondClaim={...claim,parentRequestId:"parent-2",idempotencyKey:"stable-2",inputFingerprint:"e".repeat(64)};
    const acceptance=await verifyScenarioCapabilityRecoveryObserver(observer,{observerId:"accepted-observer",reference:"deployment-acceptance:1",expiresAt:"2026-09-03T00:00:00.000Z",
      probes:[claim,secondClaim].map(value=>({claim:value,expectedOutcome:"succeeded" as const,expectedEvidenceFingerprint:hashValue(fact)})),async readEvidence(){return fact;},async captureExternalState(){return {writes:0};},now:()=>now});
    const oldIssuer=new ScenarioCapabilityRecoveryIssuer({id:"old-observer",keyId:"old-key",privateKeyPem:oldKeys.privateKey.export({type:"pkcs8",format:"pem"}).toString(),
      packageIds:[manifest.id],capabilities:[claim.capability],validFrom:"2026-09-01T00:00:00.000Z",validUntil:"2026-09-03T00:00:00.000Z",maximumEvidenceAgeMs:3600000,revoked:()=>revoked,observer,acceptance},()=>now);
    const stale=await oldIssuer.issue(claim);revoked=true;const newKeys=generateKeyPairSync("ed25519"),newIssuer=new ScenarioCapabilityRecoveryIssuer({id:"current-observer",keyId:"current-key",
      privateKeyPem:newKeys.privateKey.export({type:"pkcs8",format:"pem"}).toString(),packageIds:[manifest.id],capabilities:[claim.capability],validFrom:"2026-09-01T00:00:00.000Z",
      validUntil:"2026-09-03T00:00:00.000Z",maximumEvidenceAgeMs:3600000,observer,acceptance},()=>now);
    const control=new ScenarioProcessControl(sqlite,store,{recoveryIssuers:[oldIssuer,newIssuer],authorizer:{async authorize(){return {decision:"allowed",authorizationRef:"operator-policy",expiresAt:"2026-09-02T00:05:00.000Z"};}}},()=>now);
    await expect(control.reconcile({commandId:"revoked-evidence",package:claim.package,idempotencyKey:claim.idempotencyKey,actor:"operator",reason:"old observation",evidence:stale})).rejects.toThrow(/could not be trusted/);
    const result=await control.observeAndReconcile({commandId:"rotated-evidence",package:claim.package,idempotencyKey:claim.idempotencyKey,issuerId:newIssuer.id,actor:"operator",reason:"current observation"});
    expect(result.audit).toMatchObject({outcome:"resolved_succeeded"});expect(store.getCapabilityReceipt(claim.package,claim.idempotencyKey)).toMatchObject({status:"succeeded"});});

  it("retires only a revoked version with no unresolved calls and compresses hot receipts",async()=>{const {sqlite,store,control}=setup();
    store.reserveGeneration(manifest,1,1,"a".repeat(64));store.recordLifecycle(manifest,1,"failed",{error:"launch rejected"});store.claimCapabilityReceipt(manifest,claim);store.settleCapabilityReceipt(manifest,claim.inputFingerprint,receipt);
    store.revoke(manifest,"review withdrawn");const retirement={commandId:"retire-1",package:claim.package,source:manifest.source,actor:"operator",reason:"retention elapsed"};
    sqlite.prepare("INSERT INTO process_execution_occupancy VALUES (?,?,?,'unknown',?,NULL,?)").run("occupancy","process-key",canonicalJson({source:manifest.source,
      version:manifest.version,operation:"scenario-process:generation:1",kind:"service",attribution:{idempotencyKey:"process-key",caseId:"case",runId:"run",workId:"work",leaseId:"lease"}}),"request",now);
    await expect(control.retire(retirement)).rejects.toThrow(/Unreleased/);sqlite.prepare("UPDATE process_execution_occupancy SET state='released',proof_ref='process-cleanup:verified' WHERE id='occupancy'").run();
    const result=await control.retire(retirement);
    expect(result.audit).toMatchObject({outcome:"retired",recordCount:1});expect(store.snapshot(manifest)).toMatchObject({state:"retired"});expect(store.countCapabilityReceipts(claim.package)).toBe(0);
    const archive=sqlite.prepare("SELECT original_bytes,length(payload) AS bytes FROM scenario_process_retired_archives").get() as {original_bytes:number;bytes:number};
    expect(archive.bytes).toBeLessThan(archive.original_bytes);expect(control.retiredArchives({}).archives).toMatchObject([{packageId:manifest.id,recordCount:1}]);
    expect(()=>store.reserveGeneration(manifest,2,2,"a".repeat(64))).toThrow(/revoked/);});

  it("exports a retired archive through fresh authorization and verifies signature, payload and replay",async()=>{const {sqlite,store}=setup(),keys=generateKeyPairSync("ed25519");let revoked=false;
    const signer=new ScenarioProcessArchiveExportSigner({keyId:"archive-key",privateKeyPem:keys.privateKey.export({type:"pkcs8",format:"pem"}).toString(),
      validFrom:"2026-09-01T00:00:00.000Z",validUntil:"2026-09-03T00:00:00.000Z",revoked:()=>revoked},()=>now);
    const control=new ScenarioProcessControl(sqlite,store,{archiveExportSigner:signer,authorizer:{async authorize(){return {decision:"allowed",authorizationRef:"operator-policy",expiresAt:"2026-09-02T00:05:00.000Z"};}}},()=>now);
    store.reserveGeneration(manifest,1,1,"a".repeat(64));store.recordLifecycle(manifest,1,"failed",{error:"launch rejected"});store.claimCapabilityReceipt(manifest,claim);store.settleCapabilityReceipt(manifest,claim.inputFingerprint,receipt);store.revoke(manifest,"review withdrawn");
    await control.retire({commandId:"retire-export",package:claim.package,source:manifest.source,actor:"operator",reason:"retention elapsed"});const request={commandId:"export-1",package:claim.package,actor:"operator",reason:"move to independent cold storage"};
    const first=await control.exportRetired(request),replay=await control.exportRetired(request);if(!("archive" in first)||!("archive" in replay))throw new Error("Archive export unexpectedly denied");
    expect(replay).toMatchObject({replayed:true,archive:{signature:first.archive.signature}});
    verifyScenarioProcessArchiveExport(first.archive,signer.authority(),now);expect(()=>verifyScenarioProcessArchiveExport({...first.archive,payloadBase64:first.archive.payloadBase64.slice(0,-4)+"AAAA"},signer.authority(),now)).toThrow();
    revoked=true;expect(()=>verifyScenarioProcessArchiveExport(first.archive,signer.authority(),now)).toThrow(/authority/);});
});
