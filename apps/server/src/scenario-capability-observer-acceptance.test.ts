import { createHash, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "@traceforge/orchestration-core";
import type { ProviderCapabilityReceipt, ScenarioCapabilityClaim } from "@traceforge/worker-runtime";
import { verifyScenarioCapabilityRecoveryObserver } from "./scenario-capability-observer-acceptance.js";
import { ScenarioCapabilityRecoveryIssuer } from "./scenario-capability-recovery-issuer.js";

const now="2026-09-02T00:00:30.000Z",claim:ScenarioCapabilityClaim={schemaVersion:1,package:{id:"fixture.package",version:"1.0.0"},generation:1,
  parentRequestId:"parent",capability:"fixture.lookup",action:"fixture.inspect",idempotencyKey:"stable",inputFingerprint:"d".repeat(64),
  attribution:{caseId:"case",runId:"run",workId:"work",workerId:"worker",scopeRef:"scope",leaseId:"lease"},startedAt:"2026-09-02T00:00:00.000Z"};
const receipt=(value:ScenarioCapabilityClaim):ProviderCapabilityReceipt=>({id:`receipt:${value.idempotencyKey}`,provider:{...value.package,generation:value.generation},parentRequestId:value.parentRequestId,
  capability:value.capability,action:value.action,idempotencyKey:value.idempotencyKey,inputFingerprint:value.inputFingerprint,attribution:{...value.attribution,leaseExpiresAt:"2100-01-01T00:00:00.000Z",idempotencyKey:"effect"},
  status:"succeeded",authorizationRef:"authorization",output:{available:true},refs:["evidence:first"],requestBytes:1,responseBytes:1,retryable:false,startedAt:value.startedAt,completedAt:"2026-09-02T00:00:10.000Z"});
const fingerprint=(value:unknown)=>createHash("sha256").update(canonicalJson(value)).digest("hex"),second={...claim,parentRequestId:"parent-2",idempotencyKey:"stable-2",inputFingerprint:"e".repeat(64)};

describe("Scenario capability Observer deployment acceptance",()=>{
  it("accepts only a deterministic, cancellable and side-effect-free Observer and binds the exact instance to its acceptance",async()=>{const observer={async observe(value:ScenarioCapabilityClaim,signal:AbortSignal){signal.throwIfAborted();return {outcome:"succeeded" as const,receipt:receipt(value),evidenceRef:`facts:${value.idempotencyKey}`};}},fact={terminal:true};
    const acceptance=await verifyScenarioCapabilityRecoveryObserver(observer,{observerId:"observer",reference:"acceptance:1",expiresAt:"2026-09-03T00:00:00.000Z",
      probes:[claim,second].map(value=>({claim:value,expectedOutcome:"succeeded",expectedEvidenceFingerprint:fingerprint(fact)})),async readEvidence(_reference,signal){signal.throwIfAborted();return fact;},async captureExternalState(){return {writes:0};},now:()=>now});
    const keys=generateKeyPairSync("ed25519"),base={id:"issuer",keyId:"key",privateKeyPem:keys.privateKey.export({type:"pkcs8",format:"pem"}).toString(),packageIds:[claim.package.id],capabilities:[claim.capability],validFrom:"2026-09-01T00:00:00.000Z",validUntil:"2026-09-03T00:00:00.000Z",maximumEvidenceAgeMs:3600000,acceptance};
    await expect(new ScenarioCapabilityRecoveryIssuer({...base,observer},()=>now).issue(claim)).resolves.toMatchObject({assertion:{outcome:"succeeded"}});
    const lookalike={...observer};await expect(new ScenarioCapabilityRecoveryIssuer({...base,keyId:"key-2",observer:lookalike},()=>now).issue(claim)).rejects.toThrow(/acceptance/);
  });
  it("rejects observation side effects and non-deterministic results",async()=>{let writes=0,calls=0;const observer={async observe(value:ScenarioCapabilityClaim,signal:AbortSignal){signal.throwIfAborted();calls++;writes++;return {outcome:"succeeded" as const,receipt:receipt({...value,parentRequestId:`${value.parentRequestId}:${calls}`}),evidenceRef:"facts:terminal"};}};
    await expect(verifyScenarioCapabilityRecoveryObserver(observer,{observerId:"observer",reference:"acceptance:bad",expiresAt:"2026-09-03T00:00:00.000Z",probes:[claim,second].map(value=>({claim:value,expectedOutcome:"succeeded",expectedEvidenceFingerprint:fingerprint({terminal:true})})),async readEvidence(){return {terminal:true};},async captureExternalState(){return {writes};},now:()=>now})).rejects.toThrow(/side effect|deterministic/);
  });
});
