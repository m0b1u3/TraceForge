import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { canonicalJson } from "@traceforge/orchestration-core";
import { verifyScenarioProcessArchiveExport, type ScenarioProcessArchiveExportAuthority, type ScenarioProcessArchiveExportEnvelope } from "./scenario-process-archive-export.js";

const text=z.string().trim().min(1).max(1024),digest=z.string().regex(/^[a-f0-9]{64}$/),binding=z.object({id:text,version:text}).strict();
const envelopeSchema=z.object({format:z.literal("traceforge.scenario-process-retired-archive.v1"),keyId:text,package:binding,archiveDigest:digest,
  originalBytes:z.number().int().positive().max(16*1024*1024),compressedBytes:z.number().int().positive().max(16*1024*1024),createdAt:z.string().datetime(),
  exportedAt:z.string().datetime(),payloadBase64:z.string().max(24*1024*1024),signature:z.string().max(128)}).strict();
const command=z.object({commandId:text,actor:text,reason:text}).strict();
const receiveRequest=command.extend({archive:envelopeSchema}).strict(),retentionRequest=command.extend({archiveDigest:digest,expectedRevision:z.number().int().nonnegative()}).strict();
const query=z.object({after:digest.optional(),limit:z.coerce.number().int().min(1).max(100).default(50)}).strict();
const hash=(value:unknown)=>createHash("sha256").update(canonicalJson(value)).digest("hex");

export interface ScenarioProcessColdArchiveAuthorizer {authorize(input:{operation:"receive"|"release"|"purge";commandId:string;actor:string;reason:string;
  archiveDigest:string;package?:{id:string;version:string}}):Promise<{decision:"allowed";authorizationRef:string;expiresAt:string}|{decision:"denied"}>}
export interface ScenarioProcessColdArchiveOptions {root:string;authority:(keyId:string)=>ScenarioProcessArchiveExportAuthority|undefined;
  authorizer?:ScenarioProcessColdArchiveAuthorizer;maximumArchives?:number}
export interface ScenarioProcessColdArchiveCheckpoint {reached(phase:"receive_staged"|"receive_published"|"release_published"|"purge_prepared"|"purge_removed"):void|Promise<void>}
interface StoredReceipt {format:"traceforge.scenario-process-cold-receipt.v1";archiveDigest:string;package:{id:string;version:string};keyId:string;
  envelopeFingerprint:string;authority:ScenarioProcessArchiveExportAuthority;authorityFingerprint:string;authorizationRef:string;receivedAt:string}
interface RetentionRecord {format:"traceforge.scenario-process-cold-retention.v1";archiveDigest:string;revision:number;state:"destroyable"|"purge_prepared"|"destroyed";
  commandId:string;requestFingerprint:string;authorizationRef:string;actor:string;reason:string;at:string;secureErase:false}

/** Filesystem-only receiver. It intentionally has no active-database dependency. */
export class ScenarioProcessColdArchive {
  private readonly root:string;private readonly maximumArchives:number;
  constructor(private readonly options:ScenarioProcessColdArchiveOptions,private readonly now=()=>new Date().toISOString(),private readonly checkpoint?:ScenarioProcessColdArchiveCheckpoint){
    if(!options.root.trim())throw new Error("Scenario Process cold archive root is required");this.maximumArchives=options.maximumArchives??10000;
    if(!Number.isSafeInteger(this.maximumArchives)||this.maximumArchives<1||this.maximumArchives>100000)throw new Error("Invalid Scenario Process cold archive capacity");
    mkdirSync(resolve(options.root),{recursive:true,mode:0o700});this.root=realpathSync(resolve(options.root));for(const name of ["archives","commands","retention","staging"])this.ensureDirectory(join(this.root,name));
  }
  async receive(value:unknown){const input=receiveRequest.parse(structuredClone(value)),archive=input.archive,requestFingerprint=hash(input),grant=await this.authorize({operation:"receive",...input,archiveDigest:archive.archiveDigest,package:archive.package});
    if(grant.decision!=="allowed")return {outcome:"denied" as const,replayed:false};const prior=this.readCommand(input.commandId);if(prior)return this.replay(prior,requestFingerprint);
    const authority=this.options.authority(archive.keyId);if(!authority)throw new Error("Scenario Process cold archive authority is unavailable");verifyScenarioProcessArchiveExport(archive,authority,this.now());
    this.cleanStaging(archive.archiveDigest,input.commandId);const final=this.archivePath(archive.archiveDigest),receivedAt=this.now(),receipt:StoredReceipt={format:"traceforge.scenario-process-cold-receipt.v1",archiveDigest:archive.archiveDigest,
      package:archive.package,keyId:archive.keyId,envelopeFingerprint:hash(archive),authority:structuredClone(authority),authorityFingerprint:hash(authority),authorizationRef:grant.authorizationRef,receivedAt};
    if(existsSync(final)){this.verifyStored(final,archive);}
    else {if(this.archiveNames().length>=this.maximumArchives)throw new Error("Scenario Process cold archive capacity exceeded");const staging=join(this.root,"staging",`${archive.archiveDigest}.${hash(input.commandId)}.${randomUUID()}`);
      this.ensureDirectory(staging);try{this.writeNew(join(staging,"envelope.json"),canonicalJson(archive));this.writeNew(join(staging,"payload.gz"),Buffer.from(archive.payloadBase64,"base64"));
        this.writeNew(join(staging,"receipt.json"),canonicalJson(receipt));this.writeNew(join(staging,"READY"),archive.archiveDigest);this.syncDirectory(staging);await this.checkpoint?.reached("receive_staged");
        try{renameSync(staging,final);}catch(error){if(!existsSync(final))throw error;this.removeStaging(staging);this.verifyStored(final,archive);}this.syncDirectory(dirname(final));await this.checkpoint?.reached("receive_published");
      }catch(error){if(existsSync(staging))this.removeStaging(staging);throw error;}}
    const result={operation:"receive",outcome:"received",commandId:input.commandId,archiveDigest:archive.archiveDigest,package:archive.package,authorizationRef:grant.authorizationRef,at:this.now(),replayed:false};
    this.writeCommand(input.commandId,requestFingerprint,result);return result;
  }
  inventory(value:unknown){const input=query.parse(value),names=this.archiveNames().filter(name=>name>(input.after??"")),page=names.slice(0,input.limit),records=page.map(name=>this.inspect(name));
    return {records,nextCursor:names.length>input.limit?page.at(-1):null};}
  inspect(value:string){const archiveDigest=digest.parse(value),path=this.archivePath(archiveDigest),stored=this.verifyStored(path),retention=this.retention(archiveDigest);
    return {archiveDigest,package:stored.archive.package,keyId:stored.archive.keyId,originalBytes:stored.archive.originalBytes,compressedBytes:stored.archive.compressedBytes,
      receivedAt:stored.receipt.receivedAt,retentionState:retention?.state??"forensic_hold",retentionRevision:retention?.revision??0,secureErase:false};}
  async release(value:unknown){const input=retentionRequest.parse(structuredClone(value)),requestFingerprint=hash(input),grant=await this.authorize({operation:"release",...input});
    if(grant.decision!=="allowed")return {outcome:"denied" as const,replayed:false};const prior=this.readCommand(input.commandId);if(prior)return this.replay(prior,requestFingerprint);this.verifyStored(this.archivePath(input.archiveDigest));
    const current=this.retention(input.archiveDigest);if(current){if(current.commandId!==input.commandId||current.requestFingerprint!==requestFingerprint||current.state!=="destroyable")throw new Error("Scenario Process cold archive retention revision conflicts");}
    else {if(input.expectedRevision!==0)throw new Error("Scenario Process cold archive retention revision conflicts");const record=this.retentionRecord(input,requestFingerprint,grant.authorizationRef,1,"destroyable");this.writeRetention(record);await this.checkpoint?.reached("release_published");}
    const result={operation:"release",outcome:"destroyable",commandId:input.commandId,archiveDigest:input.archiveDigest,revision:1,authorizationRef:grant.authorizationRef,secureErase:false,at:this.now(),replayed:false};this.writeCommand(input.commandId,requestFingerprint,result);return result;
  }
  async purge(value:unknown){const input=retentionRequest.parse(structuredClone(value)),requestFingerprint=hash(input),grant=await this.authorize({operation:"purge",...input});
    if(grant.decision!=="allowed")return {outcome:"denied" as const,replayed:false};const prior=this.readCommand(input.commandId);if(prior)return this.replay(prior,requestFingerprint);let current=this.retention(input.archiveDigest);
    if(current?.state==="destroyed"){if(current.commandId!==input.commandId||current.requestFingerprint!==requestFingerprint)throw new Error("Scenario Process cold archive retention revision conflicts");}
    else {if(current?.state==="destroyable"){if(input.expectedRevision!==current.revision)throw new Error("Scenario Process cold archive retention revision conflicts");current=this.retentionRecord(input,requestFingerprint,grant.authorizationRef,current.revision+1,"purge_prepared");this.writeRetention(current);await this.checkpoint?.reached("purge_prepared");}
      if(current?.state!=="purge_prepared"||current.commandId!==input.commandId||current.requestFingerprint!==requestFingerprint)throw new Error("Scenario Process cold archive is under forensic hold or purge conflicts");
      const archivePath=this.archivePath(input.archiveDigest);if(existsSync(archivePath)){this.verifyStored(archivePath);this.removeArchive(archivePath);this.syncDirectory(dirname(archivePath));}await this.checkpoint?.reached("purge_removed");
      current=this.retentionRecord(input,requestFingerprint,current.authorizationRef,current.revision+1,"destroyed");this.writeRetention(current);}
    const result={operation:"purge",outcome:"destroyed",commandId:input.commandId,archiveDigest:input.archiveDigest,revision:current.revision,authorizationRef:current.authorizationRef,secureErase:false,at:this.now(),replayed:false};this.writeCommand(input.commandId,requestFingerprint,result);return result;
  }
  private retentionRecord(input:z.infer<typeof retentionRequest>,requestFingerprint:string,authorizationRef:string,revision:number,state:RetentionRecord["state"]):RetentionRecord{return {format:"traceforge.scenario-process-cold-retention.v1",archiveDigest:input.archiveDigest,revision,state,commandId:input.commandId,requestFingerprint,authorizationRef,actor:input.actor,reason:input.reason,at:this.now(),secureErase:false};}
  private retention(archiveDigest:string){const dir=join(this.root,"retention",archiveDigest);if(!existsSync(dir))return undefined;this.assertDirectory(dir);const entries=readdirSync(dir);if(entries.some(name=>!/^\d{10}\.json$/.test(name)))throw new Error("Scenario Process cold archive retention log contains an unexpected entry");const names=entries.sort();if(!names.length)return undefined;
    const records=names.map((name,index)=>{const record=this.readJson<RetentionRecord>(join(dir,name),65536);if(record.format!=="traceforge.scenario-process-cold-retention.v1"||record.archiveDigest!==archiveDigest||record.revision!==index+1||name!==`${String(record.revision).padStart(10,"0")}.json`)throw new Error("Scenario Process cold archive retention log is corrupt");return record;});return records.at(-1);}
  private writeRetention(record:RetentionRecord){const dir=join(this.root,"retention",record.archiveDigest);this.ensureDirectory(dir);this.writeNew(join(dir,`${String(record.revision).padStart(10,"0")}.json`),canonicalJson(record));this.syncDirectory(dir);}
  private verifyStored(path:string,expected?:ScenarioProcessArchiveExportEnvelope){this.assertDirectory(path);const allowed=["READY","envelope.json","payload.gz","receipt.json"],names=readdirSync(path).sort();if(canonicalJson(names)!==canonicalJson([...allowed].sort()))throw new Error("Scenario Process cold archive contains unexpected entries");
    const archive=envelopeSchema.parse(this.readJson<unknown>(join(path,"envelope.json"),24*1024*1024)),receipt=this.readJson<StoredReceipt>(join(path,"receipt.json"),1024*1024),payload=readFileSync(this.assertRegular(join(path,"payload.gz")));
    if(payload.length!==archive.compressedBytes||payload.toString("base64")!==archive.payloadBase64||readFileSync(this.assertRegular(join(path,"READY")),"utf8")!==archive.archiveDigest
      ||receipt.format!=="traceforge.scenario-process-cold-receipt.v1"||receipt.archiveDigest!==archive.archiveDigest||receipt.envelopeFingerprint!==hash(archive)||receipt.authorityFingerprint!==hash(receipt.authority))throw new Error("Scenario Process cold archive is corrupt");
    verifyScenarioProcessArchiveExport(archive,receipt.authority,receipt.receivedAt);if(expected&&canonicalJson(expected)!==canonicalJson(archive))throw new Error("Scenario Process cold archive digest collision");return {archive,receipt};}
  private archiveNames(){const dir=join(this.root,"archives");this.assertDirectory(dir);const names=readdirSync(dir);if(names.some(name=>!/^[a-f0-9]{64}$/.test(name)))throw new Error("Scenario Process cold archive inventory contains an unexpected entry");return names.sort();}
  private archivePath(value:string){return join(this.root,"archives",digest.parse(value));}
  private commandPath(id:string){return join(this.root,"commands",hash(id)+".json");}
  private readCommand(id:string){const path=this.commandPath(id);return existsSync(path)?this.readJson<any>(path,65536):undefined;}
  private writeCommand(id:string,requestFingerprint:string,result:unknown){this.writeNew(this.commandPath(id),canonicalJson({format:"traceforge.scenario-process-cold-command.v1",commandId:id,requestFingerprint,result}));this.syncDirectory(join(this.root,"commands"));}
  private replay(prior:any,fingerprint:string){if(prior?.format!=="traceforge.scenario-process-cold-command.v1"||prior.requestFingerprint!==fingerprint)throw new Error("Scenario Process cold archive command conflicts");return {...prior.result,replayed:true};}
  private async authorize(input:any){let timer:ReturnType<typeof setTimeout>|undefined;const grant=await Promise.race([this.options.authorizer?.authorize(structuredClone(input))??Promise.resolve({decision:"denied" as const}),
    new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("Scenario Process cold archive authorization deadline")),10000);})]).finally(()=>{if(timer)clearTimeout(timer);});if(grant.decision==="allowed"&&(!grant.authorizationRef.trim()||!(Date.parse(grant.expiresAt)>Date.parse(this.now()))))throw new Error("Scenario Process cold archive authorization is invalid");return grant;}
  private ensureDirectory(path:string){if(existsSync(path)){this.assertDirectory(path);return;}mkdirSync(path,{mode:0o700});this.syncDirectory(dirname(path));}
  private assertDirectory(path:string){const stat=lstatSync(path);if(!stat.isDirectory()||stat.isSymbolicLink()||realpathSync(path)!==resolve(path))throw new Error("Scenario Process cold archive path is unsafe");return path;}
  private assertRegular(path:string){const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink())throw new Error("Scenario Process cold archive file is unsafe");return path;}
  private readJson<T>(path:string,limit:number):T{const file=this.assertRegular(path),stat=lstatSync(file);if(stat.size>limit)throw new Error("Scenario Process cold archive record exceeds capacity");return JSON.parse(readFileSync(file,"utf8")) as T;}
  private writeNew(path:string,value:string|Buffer){const fd=openSync(path,"wx",0o600);try{writeFileSync(fd,value);fsyncSync(fd);}finally{closeSync(fd);}}
  private syncDirectory(path:string){const fd=openSync(path,"r");try{fsyncSync(fd);}finally{closeSync(fd);}}
  private removeStaging(path:string){if(!existsSync(path))return;this.assertDirectory(path);for(const name of readdirSync(path)){if(!["READY","envelope.json","payload.gz","receipt.json"].includes(name))throw new Error("Scenario Process cold staging contains unexpected entries");unlinkSync(this.assertRegular(join(path,name)));}rmdirSync(path);}
  private cleanStaging(archiveDigest:string,commandId:string){const dir=join(this.root,"staging"),prefix=`${archiveDigest}.${hash(commandId)}.`;this.assertDirectory(dir);for(const name of readdirSync(dir))if(name.startsWith(prefix))this.removeStaging(join(dir,name));}
  private removeArchive(path:string){this.assertDirectory(path);const names=readdirSync(path);for(const expected of ["READY","envelope.json","payload.gz","receipt.json"])if(!names.includes(expected))throw new Error("Scenario Process cold archive is incomplete");if(names.some(name=>!["READY","envelope.json","payload.gz","receipt.json"].includes(name)))throw new Error("Scenario Process cold archive contains unexpected entries");for(const name of names)unlinkSync(this.assertRegular(join(path,name)));rmdirSync(path);}
}

export function registerScenarioProcessColdArchiveRoutes(app:FastifyInstance,control:ScenarioProcessColdArchive){
  app.get("/api/security-tools/scenario-process-cold-archives",async(request,reply)=>route(reply,()=>control.inventory(request.query)));
  app.get("/api/security-tools/scenario-process-cold-archives/:archiveDigest",async(request,reply)=>route(reply,()=>control.inspect((request.params as any).archiveDigest)));
  app.post("/api/security-tools/scenario-process-cold-archives/receive",{bodyLimit:24*1024*1024},async(request,reply)=>route(reply,()=>control.receive(request.body)));
  app.post("/api/security-tools/scenario-process-cold-archives/release",async(request,reply)=>route(reply,()=>control.release(request.body)));
  app.post("/api/security-tools/scenario-process-cold-archives/purge",async(request,reply)=>route(reply,()=>control.purge(request.body)));
}
async function route(reply:FastifyReply,fn:()=>unknown){try{const result:any=await fn();return result?.outcome==="denied"?reply.code(403).send(result):result;}catch(error){return reply.code(error instanceof z.ZodError?400:409).send({error:error instanceof Error?error.message:"Scenario Process cold archive failed"});}}
