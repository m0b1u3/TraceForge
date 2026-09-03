import { createHash } from "node:crypto";
import { canonicalJson } from "@traceforge/orchestration-core";
import type { ScenarioCapabilityClaim } from "@traceforge/worker-runtime";
import type { ScenarioCapabilityRecoveryObservation, ScenarioCapabilityRecoveryObserver } from "./scenario-capability-recovery-issuer.js";

export interface ScenarioCapabilityObserverProbe {claim:ScenarioCapabilityClaim;expectedOutcome:"succeeded"|"not_executed";expectedEvidenceFingerprint:string}
export interface ScenarioCapabilityObserverAcceptanceOptions {observerId:string;reference:string;expiresAt:string;probes:readonly ScenarioCapabilityObserverProbe[];
  readEvidence(reference:string,signal:AbortSignal):Promise<unknown>;captureExternalState():Promise<unknown>;timeoutMs?:number;now?:()=>string}
export interface ScenarioCapabilityObserverAcceptance {format:"traceforge.scenario-capability-observer-acceptance.v1";observerId:string;reference:string;
  probeDigest:string;probeCount:number;completedAt:string;expiresAt:string}

const accepted=new WeakMap<ScenarioCapabilityRecoveryObserver,string>();
const hash=(value:unknown)=>createHash("sha256").update(canonicalJson(value)).digest("hex");

/** Deployment acceptance harness. Snapshot/evidence readers must themselves be trusted host adapters. */
export async function verifyScenarioCapabilityRecoveryObserver(observer:ScenarioCapabilityRecoveryObserver,
  options:ScenarioCapabilityObserverAcceptanceOptions):Promise<ScenarioCapabilityObserverAcceptance>{
  const now=options.now??(()=>new Date().toISOString()),timeout=options.timeoutMs??10000;
  if(!options.observerId.trim()||!options.reference.trim()||options.probes.length<2||options.probes.length>64||!Number.isSafeInteger(timeout)||timeout<100||timeout>60000
    ||!(Date.parse(options.expiresAt)>Date.parse(now())))throw new Error("Invalid Scenario capability Observer acceptance plan");
  const identities=new Set<string>();
  for(const probe of options.probes){const identity=canonicalJson([probe.claim.package,probe.claim.capability,probe.claim.action,probe.claim.idempotencyKey]);
    if(identities.has(identity)||!/^[a-f0-9]{64}$/.test(probe.expectedEvidenceFingerprint))throw new Error("Invalid or duplicate Scenario capability Observer probe");identities.add(identity);
    const before=canonicalJson(await options.captureExternalState()),first=await boundedObserve(observer,probe.claim,timeout),middle=canonicalJson(await options.captureExternalState());
    const evidence=await boundedRead(options.readEvidence,first.evidenceRef,timeout),afterRead=canonicalJson(await options.captureExternalState());
    const second=await boundedObserve(observer,probe.claim,timeout),after=canonicalJson(await options.captureExternalState());
    if(before!==middle||middle!==afterRead||afterRead!==after)throw new Error("Scenario capability Observer acceptance detected an observation side effect");
    if(first.outcome!==probe.expectedOutcome||canonicalJson(first)!==canonicalJson(second)||hash(evidence)!==probe.expectedEvidenceFingerprint)throw new Error("Scenario capability Observer acceptance is not deterministic or evidence is not reproducible");
    validateObservation(first,probe.claim);
  }
  const cancellationBefore=canonicalJson(await options.captureExternalState()),aborted=new AbortController();aborted.abort(new Error("acceptance cancellation probe"));
  const cancellation=observer.observe(structuredClone(options.probes[0]!.claim),aborted.signal);let cancellationTimer:ReturnType<typeof setTimeout>|undefined;
  await Promise.race([cancellation.then(()=>{throw new Error("Scenario capability Observer ignored a pre-aborted signal");},()=>undefined),
    new Promise<never>((_,reject)=>{cancellationTimer=setTimeout(()=>reject(new Error("Scenario capability Observer cancellation deadline")),Math.min(timeout,1000));})]).finally(()=>{if(cancellationTimer)clearTimeout(cancellationTimer);});
  if(cancellationBefore!==canonicalJson(await options.captureExternalState()))throw new Error("Scenario capability Observer acceptance detected a cancellation side effect");
  const acceptance={format:"traceforge.scenario-capability-observer-acceptance.v1" as const,observerId:options.observerId,reference:options.reference,
    probeDigest:hash(options.probes),probeCount:options.probes.length,completedAt:now(),expiresAt:options.expiresAt};
  accepted.set(observer,hash(acceptance));return acceptance;
}

export function assertScenarioCapabilityObserverAcceptance(observer:ScenarioCapabilityRecoveryObserver,acceptance:ScenarioCapabilityObserverAcceptance,now:string):void{
  if(acceptance.format!=="traceforge.scenario-capability-observer-acceptance.v1"||accepted.get(observer)!==hash(acceptance)||!(Date.parse(acceptance.expiresAt)>Date.parse(now)))throw new Error("Scenario capability Observer acceptance is missing, mismatched, or expired");
}

async function boundedObserve(observer:ScenarioCapabilityRecoveryObserver,claim:ScenarioCapabilityClaim,timeout:number){const controller=new AbortController(),timer=setTimeout(()=>controller.abort(new Error("Observer acceptance deadline")),timeout);
  try{return structuredClone(await Promise.race([observer.observe(structuredClone(claim),controller.signal),new Promise<never>((_,reject)=>controller.signal.addEventListener("abort",()=>reject(controller.signal.reason),{once:true}))]));}
  finally{clearTimeout(timer);controller.abort();}}
async function boundedRead(reader:ScenarioCapabilityObserverAcceptanceOptions["readEvidence"],reference:string,timeout:number){const controller=new AbortController(),timer=setTimeout(()=>controller.abort(new Error("Evidence acceptance deadline")),timeout);
  try{return structuredClone(await Promise.race([reader(reference,controller.signal),new Promise<never>((_,reject)=>controller.signal.addEventListener("abort",()=>reject(controller.signal.reason),{once:true}))]));}
  finally{clearTimeout(timer);controller.abort();}}
function validateObservation(value:ScenarioCapabilityRecoveryObservation,claim:ScenarioCapabilityClaim){if(!value||!value.evidenceRef?.trim()||Buffer.byteLength(value.evidenceRef)>1024||(value.outcome==="succeeded")!==!!value.receipt)throw new Error("Scenario capability Observer returned an invalid observation");
  const receipt=value.receipt;if(receipt&&(receipt.provider.id!==claim.package.id||receipt.provider.version!==claim.package.version||receipt.provider.generation!==claim.generation
    ||receipt.parentRequestId!==claim.parentRequestId||receipt.capability!==claim.capability||receipt.action!==claim.action||receipt.idempotencyKey!==claim.idempotencyKey
    ||receipt.inputFingerprint!==claim.inputFingerprint||receipt.status!=="succeeded"))throw new Error("Scenario capability Observer receipt identity mismatch");}
