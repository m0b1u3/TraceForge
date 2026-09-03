import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { canonicalJson } from "@traceforge/orchestration-core";

export interface ScenarioProcessArchiveExportAuthority {publicKeyPem:string;validFrom:string;validUntil:string;revoked?:boolean}
export interface ScenarioProcessArchiveExportEnvelope {format:"traceforge.scenario-process-retired-archive.v1";keyId:string;package:{id:string;version:string};
  archiveDigest:string;originalBytes:number;compressedBytes:number;createdAt:string;exportedAt:string;payloadBase64:string;signature:string}
export interface ScenarioProcessArchiveExportSignerOptions {keyId:string;privateKeyPem:string;validFrom:string;validUntil:string;revoked?:boolean|(()=>boolean)}

const payload=(value:Omit<ScenarioProcessArchiveExportEnvelope,"signature">)=>canonicalJson(value);

/** Signs an already-retired compressed archive for transfer; private key material never enters an archive or audit. */
export class ScenarioProcessArchiveExportSigner {
  readonly keyId:string;private readonly key;private readonly publicKeyPem:string;
  constructor(private readonly options:ScenarioProcessArchiveExportSignerOptions,private readonly now=()=>new Date().toISOString()){
    if(!options.keyId.trim()||Buffer.byteLength(options.keyId)>1024||!(Date.parse(options.validUntil)>Date.parse(options.validFrom)))throw new Error("Invalid Scenario Process archive signer");
    this.keyId=options.keyId;this.key=createPrivateKey(options.privateKeyPem);if(this.key.asymmetricKeyType!=="ed25519")throw new Error("Scenario Process archive signer requires Ed25519");
    this.publicKeyPem=createPublicKey(this.key).export({type:"spki",format:"pem"}).toString();
  }
  authority():ScenarioProcessArchiveExportAuthority{return {publicKeyPem:this.publicKeyPem,validFrom:this.options.validFrom,validUntil:this.options.validUntil,revoked:this.revoked()};}
  sign(input:Omit<ScenarioProcessArchiveExportEnvelope,"format"|"keyId"|"signature"|"exportedAt">&{exportedAt?:string}):ScenarioProcessArchiveExportEnvelope{
    const exportedAt=input.exportedAt??this.now(),at=Date.parse(exportedAt);if(this.revoked()||at<Date.parse(this.options.validFrom)||at>=Date.parse(this.options.validUntil))throw new Error("Scenario Process archive signer is unavailable");
    const body={format:"traceforge.scenario-process-retired-archive.v1" as const,keyId:this.keyId,...input,exportedAt};
    return {...body,signature:sign(null,Buffer.from(payload(body)),this.key).toString("base64")};
  }
  private revoked(){return typeof this.options.revoked==="function"?this.options.revoked():this.options.revoked===true;}
}

export function verifyScenarioProcessArchiveExport(value:ScenarioProcessArchiveExportEnvelope,authority:ScenarioProcessArchiveExportAuthority,now=new Date().toISOString()):void{
  const at=Date.parse(now),exported=Date.parse(value.exportedAt),from=Date.parse(authority.validFrom),until=Date.parse(authority.validUntil),bytes=Buffer.from(value.signature,"base64"),key=createPublicKey(authority.publicKeyPem);
  if(authority.revoked||![at,exported,from,until].every(Number.isFinite)||exported<from||exported>=until||at>=until||exported>at)throw new Error("Scenario Process archive export authority is not valid");
  if(key.asymmetricKeyType!=="ed25519"||bytes.length!==64||bytes.toString("base64")!==value.signature)throw new Error("Scenario Process archive export signature encoding is invalid");
  const {signature,...body}=value;if(!verify(null,Buffer.from(payload(body)),key,bytes))throw new Error("Scenario Process archive export signature is invalid");
  const compressed=Buffer.from(value.payloadBase64,"base64");if(compressed.toString("base64")!==value.payloadBase64||compressed.length!==value.compressedBytes)throw new Error("Scenario Process archive export payload encoding is invalid");
  const raw=gunzipSync(compressed,{maxOutputLength:16*1024*1024}).toString("utf8");if(Buffer.byteLength(raw)!==value.originalBytes)throw new Error("Scenario Process archive export length mismatch");
  const decoded=JSON.parse(raw) as any,digest=createHash("sha256").update(canonicalJson(decoded)).digest("hex");
  if(digest!==value.archiveDigest||decoded.format!=="traceforge.scenario-process-retired-receipts.v1"||decoded.package?.id!==value.package.id||decoded.package?.version!==value.package.version)throw new Error("Scenario Process archive export identity or digest mismatch");
}
