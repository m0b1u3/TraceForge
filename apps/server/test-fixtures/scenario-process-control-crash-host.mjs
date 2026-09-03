import { readFileSync } from "node:fs";
import { database } from "../src/test-fixtures/execution-recovery.ts";
import { SCENARIO_PROCESS_PROTOCOL, ToolProviderFairScheduler } from "@traceforge/worker-runtime";
import { ProcessExecutionCapacity } from "../src/process-execution-capacity.ts";
import { ScenarioCapabilityRecoveryIssuer } from "../src/scenario-capability-recovery-issuer.ts";
import { verifyScenarioCapabilityRecoveryObserver } from "../src/scenario-capability-observer-acceptance.ts";
import { ScenarioProcessControl } from "../src/scenario-process-control.ts";
import { SqliteScenarioProcessSupervisionStore } from "../src/scenario-process-supervision.ts";

const [path,keyPath,phase,mode]=process.argv.slice(2),now="2026-09-02T00:00:30.000Z";
const sqlite=database(path);new ProcessExecutionCapacity(sqlite,new ToolProviderFairScheduler(),()=>now);
const store=new SqliteScenarioProcessSupervisionStore(sqlite,()=>now),manifest={protocol:SCENARIO_PROCESS_PROTOCOL,protocolVersion:1,id:"fixture.package",version:"1.0.0",
  source:"scenario:fixture.package",entrypoint:"package://runtime/main.mjs",providedCapabilities:["fixture.observe"],hostCapabilities:["fixture.lookup"]};
const claim={schemaVersion:1,package:{id:manifest.id,version:manifest.version},generation:1,parentRequestId:"parent",capability:"fixture.lookup",action:"fixture.inspect",
  idempotencyKey:"stable",inputFingerprint:"d".repeat(64),attribution:{caseId:"case",runId:"run",workId:"work",workerId:"worker",scopeRef:"scope",leaseId:"lease"},startedAt:"2026-09-02T00:00:00.000Z"};
const receipt={id:"receipt",provider:{id:manifest.id,version:manifest.version,generation:1},parentRequestId:claim.parentRequestId,capability:claim.capability,action:claim.action,
  idempotencyKey:claim.idempotencyKey,inputFingerprint:claim.inputFingerprint,attribution:{...claim.attribution,leaseExpiresAt:"2100-01-01T00:00:00.000Z",idempotencyKey:"effect"},
  status:"succeeded",authorizationRef:"authorization",output:{available:true},refs:["evidence:first"],requestBytes:1,responseBytes:1,retryable:false,startedAt:claim.startedAt,completedAt:"2026-09-02T00:00:10.000Z"};
const observer={async observe(value,signal){signal.throwIfAborted();return {outcome:"succeeded",receipt:value.idempotencyKey===claim.idempotencyKey?receipt:{...receipt,idempotencyKey:value.idempotencyKey,
  inputFingerprint:value.inputFingerprint,parentRequestId:value.parentRequestId},evidenceRef:"execution-node:terminal"};}},secondClaim={...claim,parentRequestId:"parent-2",idempotencyKey:"stable-2",inputFingerprint:"e".repeat(64)};
const acceptance=await verifyScenarioCapabilityRecoveryObserver(observer,{observerId:"observer",reference:"fixture-acceptance",expiresAt:"2026-09-03T00:00:00.000Z",
  probes:[claim,secondClaim].map(value=>({claim:value,expectedOutcome:"succeeded",expectedEvidenceFingerprint:"6faac0fabe9df3c12a166fda1683900556af27a416dbde0c282ee30a23bb0aa6"})),
  async readEvidence(){return {terminal:true};},async captureExternalState(){return {writes:0};},now:()=>now});
const privateKeyPem=readFileSync(keyPath,"utf8"),issuer=new ScenarioCapabilityRecoveryIssuer({id:"observer",keyId:"recovery",privateKeyPem,packageIds:[manifest.id],capabilities:[claim.capability],
  validFrom:"2026-09-01T00:00:00.000Z",validUntil:"2026-09-03T00:00:00.000Z",maximumEvidenceAgeMs:3600000,observer,acceptance},()=>now);
const control=new ScenarioProcessControl(sqlite,store,{recoveryIssuers:[issuer],authorizer:{async authorize(){return {decision:"allowed",authorizationRef:"operator-policy",expiresAt:"2026-09-02T00:05:00.000Z"};}}},()=>now);

if(phase.startsWith("reconcile")){
  if(!store.getCapabilityReceipt(claim.package,claim.idempotencyKey))store.claimCapabilityReceipt(manifest,claim);
}else if(!store.snapshot(manifest)){
  store.reserveGeneration(manifest,1,1,"a".repeat(64));store.recordLifecycle(manifest,1,"failed",{error:"launch rejected"});
  store.claimCapabilityReceipt(manifest,claim);store.settleCapabilityReceipt(manifest,claim.inputFingerprint,receipt);store.revoke(manifest,"review withdrawn");
}
if(mode==="crash"&&phase.endsWith("uncommitted")){
  sqlite.function("crash_scenario_control",()=>process.kill(process.pid,"SIGKILL"));
  const table=phase.startsWith("reconcile")?"scenario_process_recovery_evidence":"scenario_process_retired_archives";
  sqlite.exec(`CREATE TEMP TRIGGER crash AFTER INSERT ON ${table} BEGIN SELECT crash_scenario_control();END`);
}
const request=phase.startsWith("reconcile")?{commandId:"reconcile-crash",package:claim.package,idempotencyKey:claim.idempotencyKey,issuerId:issuer.id,actor:"operator",reason:"recover observed result"}
  :{commandId:"retire-crash",package:claim.package,source:manifest.source,actor:"operator",reason:"retention elapsed"};
const result=phase.startsWith("reconcile")?await control.observeAndReconcile(request):await control.retire(request);
if(mode==="crash"){process.stdout.write("ready\n");setInterval(()=>{},1000);}
else {const capability=phase.startsWith("reconcile")?store.getCapabilityReceipt(claim.package,claim.idempotencyKey):undefined,snapshot=store.snapshot(manifest),integrity=sqlite.pragma("integrity_check",{simple:true});
  process.stdout.write(`${JSON.stringify({replayed:result.replayed,outcome:result.audit.outcome,capability:capability?.status??null,state:snapshot?.state??null,
    evidence:(sqlite.prepare("SELECT count(*) AS n FROM scenario_process_recovery_evidence").get()).n,archives:(sqlite.prepare("SELECT count(*) AS n FROM scenario_process_retired_archives").get()).n,integrity})}\n`);sqlite.close();}
