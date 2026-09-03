import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { canonicalJson } from "@traceforge/orchestration-core";
import type { ProviderCapabilityReceipt, ScenarioCapabilityClaim } from "@traceforge/worker-runtime";
import { assertScenarioCapabilityObserverAcceptance, type ScenarioCapabilityObserverAcceptance } from "./scenario-capability-observer-acceptance.js";

export interface SignedScenarioCapabilityRecoveryEvidence {format:"traceforge.scenario-capability-recovery.v1";keyId:string;assertion:{
  claim:ScenarioCapabilityClaim;outcome:"succeeded"|"not_executed";receipt:ProviderCapabilityReceipt|null;evidenceRef:string;issuedAt:string;expiresAt:string};signature:string}
export interface ScenarioCapabilityRecoveryAuthority {publicKeyPem:string;packageIds:readonly string[];capabilities:readonly string[];
  validFrom:string;validUntil:string;maximumAgeMs:number;revoked?:boolean}
export const scenarioCapabilityRecoverySigningPayload=(value:unknown)=>canonicalJson(value);

export interface ScenarioCapabilityRecoveryObservation {
  outcome:"succeeded"|"not_executed";
  receipt:ProviderCapabilityReceipt|null;
  /** Stable reference into the observer's independently retained facts. */
  evidenceRef:string;
}
export interface ScenarioCapabilityRecoveryObserver {
  observe(claim:ScenarioCapabilityClaim,signal:AbortSignal):Promise<ScenarioCapabilityRecoveryObservation>;
}
export interface ScenarioCapabilityRecoveryIssuerOptions {
  id:string;keyId:string;privateKeyPem:string;packageIds:readonly string[];capabilities:readonly string[];
  validFrom:string;validUntil:string;maximumEvidenceAgeMs:number;observationTimeoutMs?:number;
  revoked?:boolean|(()=>boolean);observer:ScenarioCapabilityRecoveryObserver;acceptance:ScenarioCapabilityObserverAcceptance;
}

/** Trusted-host adapter: observes external facts, but can only sign its configured Package/capability scope. */
export class ScenarioCapabilityRecoveryIssuer {
  readonly id:string;readonly keyId:string;private readonly key;private readonly publicKeyPem:string;
  constructor(private readonly options:ScenarioCapabilityRecoveryIssuerOptions,private readonly now=()=>new Date().toISOString()){
    for(const value of [options.id,options.keyId,...options.packageIds,...options.capabilities])if(!value?.trim()||Buffer.byteLength(value)>1024)throw new Error("Invalid Scenario capability recovery issuer identity");
    if(!options.packageIds.length||!options.capabilities.length||new Set(options.packageIds).size!==options.packageIds.length||new Set(options.capabilities).size!==options.capabilities.length)throw new Error("Invalid Scenario capability recovery issuer scope");
    const from=Date.parse(options.validFrom),until=Date.parse(options.validUntil);
    if(!Number.isFinite(from)||!Number.isFinite(until)||until<=from||!Number.isSafeInteger(options.maximumEvidenceAgeMs)||options.maximumEvidenceAgeMs<1000||options.maximumEvidenceAgeMs>86400000)throw new Error("Invalid Scenario capability recovery issuer validity");
    const timeout=options.observationTimeoutMs??10000;if(!Number.isSafeInteger(timeout)||timeout<100||timeout>60000)throw new Error("Invalid Scenario capability recovery observation timeout");
    this.id=options.id;this.keyId=options.keyId;this.key=createPrivateKey(options.privateKeyPem);
    if(this.key.asymmetricKeyType!=="ed25519")throw new Error("Scenario capability recovery issuer requires Ed25519");
    this.publicKeyPem=createPublicKey(this.key).export({type:"spki",format:"pem"}).toString();
  }
  authority():ScenarioCapabilityRecoveryAuthority{return {publicKeyPem:this.publicKeyPem,packageIds:[...this.options.packageIds],capabilities:[...this.options.capabilities],
    validFrom:this.options.validFrom,validUntil:this.options.validUntil,maximumAgeMs:this.options.maximumEvidenceAgeMs,revoked:this.revoked()};}
  async issue(claim:ScenarioCapabilityClaim):Promise<SignedScenarioCapabilityRecoveryEvidence>{
    if(this.revoked())throw new Error("Scenario capability recovery issuer is revoked");
    assertScenarioCapabilityObserverAcceptance(this.options.observer,this.options.acceptance,this.now());
    if(!this.options.packageIds.includes(claim.package.id)||!this.options.capabilities.includes(claim.capability))throw new Error("Scenario capability recovery issuer is outside scope");
    const issuedAt=this.now(),issued=Date.parse(issuedAt),validFrom=Date.parse(this.options.validFrom),validUntil=Date.parse(this.options.validUntil);
    if(!Number.isFinite(issued)||issued<validFrom||issued>=validUntil)throw new Error("Scenario capability recovery issuer is not currently valid");
    const timeout=this.options.observationTimeoutMs??10000,controller=new AbortController(),timer=setTimeout(()=>controller.abort(new Error("Scenario capability recovery observation deadline")),timeout);
    let observation:ScenarioCapabilityRecoveryObservation;
    try{observation=structuredClone(await Promise.race([this.options.observer.observe(structuredClone(claim),controller.signal),
      new Promise<never>((_,reject)=>controller.signal.addEventListener("abort",()=>reject(controller.signal.reason),{once:true}))]));}
    finally{clearTimeout(timer);controller.abort();}
    if(!observation||!(["succeeded","not_executed"] as const).includes(observation.outcome)||typeof observation.evidenceRef!=="string"
      ||!observation.evidenceRef.trim()||Buffer.byteLength(observation.evidenceRef)>1024||(observation.outcome==="succeeded")!==!!observation.receipt)throw new Error("Scenario capability recovery observer returned an invalid assertion");
    const expiresAt=new Date(Math.min(validUntil,issued+this.options.maximumEvidenceAgeMs)).toISOString();
    const payload={format:"traceforge.scenario-capability-recovery.v1" as const,keyId:this.keyId,
      assertion:{claim:structuredClone(claim),outcome:observation.outcome,receipt:observation.receipt,evidenceRef:observation.evidenceRef,issuedAt,expiresAt}};
    return {...payload,signature:sign(null,Buffer.from(scenarioCapabilityRecoverySigningPayload(payload)),this.key).toString("base64")} as SignedScenarioCapabilityRecoveryEvidence;
  }
  private revoked(){return typeof this.options.revoked==="function"?this.options.revoked():this.options.revoked===true;}
}
