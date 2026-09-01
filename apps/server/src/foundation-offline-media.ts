import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, randomBytes, sign, verify } from "node:crypto";
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync,
  realpathSync, statfsSync, writeFileSync, writeSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { canonicalJson } from "@traceforge/orchestration-core";
import { waitForCancellation } from "@traceforge/worker-runtime";
import { FoundationBackupControl, foundationBackupDigestSchema as digest, foundationBackupIdSchema as id } from "./foundation-backup.js";

const text = z.string().trim().min(1).max(256), partName = z.string().regex(/^part-[0-9]{6}\.bin$/);
const filePath = z.string().min(1).max(128).refine(value => /^(database\.sqlite|manifest\.json|READY|asset-[a-zA-Z0-9][a-zA-Z0-9_-]{0,79})$/.test(value));
const fileSchema = z.object({ path: filePath, bytes: z.number().int().nonnegative(), sha256: digest }).strict();
const partSchema = z.object({ name: partName, file: filePath, fileOffset: z.number().int().nonnegative(), plainBytes: z.number().int().nonnegative(),
  cipherBytes: z.number().int().nonnegative(), nonce: z.string().max(32), authTag: z.string().max(32), sha256: digest }).strict();
export const offlineMediaManifestSchema = z.object({ format: z.literal("traceforge.foundation-media.v1"), mediaId: id, backupId: id,
  backupManifestDigest: digest, signingKeyId: text, encryptionKeyId: text, issuedAt: z.string().datetime(), chunkBytes: z.number().int().positive(),
  files: z.array(fileSchema).min(2).max(130), parts: z.array(partSchema).min(2).max(16384), plaintextBytes: z.number().int().positive(),
  executionReady: z.literal(false), automaticResume: z.literal(false) }).strict();
export type FoundationOfflineMediaManifest = z.infer<typeof offlineMediaManifestSchema>;
export interface FoundationMediaAuthority { publicKeyPem: string; validFrom: string; validUntil: string; revoked?: boolean }
const requestSchema = z.object({ commandId: id, operation: z.enum(["export", "import"]), mediaId: id, mediaDigest: digest.optional(),
  backupId: id, backupManifestDigest: digest, actor: text, reason: z.string().trim().min(1).max(1024) }).strict()
  .superRefine((value, ctx) => { if ((value.operation === "import") !== !!value.mediaDigest) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Import requires an independently pinned media digest" }); });
export type FoundationMediaRequest = z.infer<typeof requestSchema>;
export interface FoundationOfflineMediaOptions {
  mediaRoot: string; signingKeyId: string; signingPrivateKeyPem?: string; encryptionKeyId: string;
  authority?: (keyId: string) => FoundationMediaAuthority | undefined;
  encryptionKey?: (keyId: string) => Buffer | undefined;
  authorizer?: { authorize(input: FoundationMediaRequest): Promise<{ decision: "allowed"; authorizationRef: string; expiresAt: string } | { decision: "denied" }> };
  chunkBytes?: number; maximumBytes?: number; maximumEntries?: number; minimumFreeBytes?: number; timeoutMs?: number;
}
const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
function sync(path: string) { const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{fsyncSync(fd);}finally{closeSync(fd);} }
function durable(path: string, value: string | Buffer) { writeFileSync(path,value,{flag:"wx",mode:0o600});sync(path); }
function privateDirectory(path: string) {
  const absolute=resolve(path);let current=absolute;
  while(true){try{if(lstatSync(current).isSymbolicLink())throw new Error("Media directories cannot contain symlinks");}
    catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}const parent=resolve(current,"..");if(parent===current)break;current=parent;}
  mkdirSync(absolute,{recursive:true,mode:0o700});const stat=lstatSync(absolute);
  if(!stat.isDirectory() || (process.platform!=="win32" && (stat.mode&0o077)!==0))throw new Error("Media directory must be private (0700)");return realpathSync(absolute);
}
function bounded(path: string, maximum: number) { const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const stat=fstatSync(fd);
  if(!stat.isFile()||stat.size>maximum)throw new Error("Media file type or size invalid");return readFileSync(fd);}finally{closeSync(fd);} }
function aad(mediaId:string,index:number,file:string,offset:number,keyId:string){return canonicalJson({format:"traceforge.foundation-media.part.v1",mediaId,index,file,offset,keyId});}
function signatureBody(manifest:FoundationOfflineMediaManifest){return Buffer.from(canonicalJson(manifest));}
function writeAll(fd:number,value:Buffer){for(let offset=0;offset<value.length;)offset+=writeSync(fd,value,offset,value.length-offset);}

/** Signed encrypted split-media transport. No key material is persisted in the package or audit database. */
export class FoundationOfflineMediaControl {
  private readonly root:string;private readonly chunk:number;private readonly maximum:number;private readonly entries:number;private readonly floor:number;private readonly timeout:number;
  private busy=false;private readonly options:FoundationOfflineMediaOptions;
  constructor(private readonly sqlite:Database.Database,private readonly backups:FoundationBackupControl,options:FoundationOfflineMediaOptions){
    this.options={...options};this.root=privateDirectory(options.mediaRoot);this.chunk=options.chunkBytes??4*1024*1024;this.maximum=options.maximumBytes??16*1024**3;
    this.entries=options.maximumEntries??32;this.floor=options.minimumFreeBytes??64*1024**2;this.timeout=options.timeoutMs??120000;
    for(const value of [this.chunk,this.maximum,this.entries,this.floor,this.timeout])if(!Number.isSafeInteger(value)||value<1)throw new Error("Invalid media limit");
    if(this.chunk>16*1024*1024||this.maximum>64*1024**3||this.entries>1024||this.timeout>300000)throw new Error("Media limits exceeded");
    if(this.root===backups.trustedBackupRoot()||this.root.startsWith(backups.trustedBackupRoot()+sep)||backups.trustedBackupRoot().startsWith(this.root+sep))throw new Error("Media and backup roots must be disjoint");
    text.parse(options.signingKeyId);text.parse(options.encryptionKeyId);
    sqlite.exec(`CREATE TABLE IF NOT EXISTS foundation_media_operations(command_id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,request_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS foundation_media_audits(sequence INTEGER PRIMARY KEY,command_id TEXT NOT NULL,phase TEXT NOT NULL,body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS foundation_media_audit_command ON foundation_media_audits(command_id,sequence);
      CREATE TRIGGER IF NOT EXISTS foundation_media_operation_capacity BEFORE INSERT ON foundation_media_operations BEGIN
        SELECT CASE WHEN (SELECT count(*) FROM foundation_media_operations)>=10000 THEN RAISE(ABORT,'Media command capacity exceeded') END;
        SELECT execution_physical_admit(recovery_floor,maximum_database_bytes,maximum_wal_bytes,32768,'recovery') FROM execution_physical_policy WHERE id=1;END;
      CREATE TRIGGER IF NOT EXISTS foundation_media_audit_capacity BEFORE INSERT ON foundation_media_audits BEGIN
        SELECT CASE WHEN (SELECT count(*) FROM foundation_media_audits)>=50000 OR length(CAST(NEW.body AS BLOB))>8192 THEN RAISE(ABORT,'Media audit capacity exceeded') END;END;`);
    for(const table of ["foundation_media_operations","foundation_media_audits"])for(const operation of ["UPDATE","DELETE"])
      sqlite.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_${operation} BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT,'Media audit is immutable');END;`);
  }
  inspect(){return{enabled:true,entries:readdirSync(this.root).length,executionReady:false,automaticResume:false,
    limits:{chunkBytes:this.chunk,maximumBytes:this.maximum,maximumEntries:this.entries,minimumFreeBytes:this.floor,timeoutMs:this.timeout},privateKeysPersisted:false};}
  audit(commandId:string){id.parse(commandId);return this.sqlite.prepare("SELECT sequence,phase,body FROM foundation_media_audits WHERE command_id=? ORDER BY sequence LIMIT 8").all(commandId);}
  retentionTarget(mediaId:string,expectedDigest:string){const verified=this.verify(mediaId,expectedDigest);return{kind:"media" as const,id:mediaId,digest:expectedDigest,
    root:this.entry(mediaId),files:["READY","SIGNATURE","media-manifest.json",...verified.manifest.parts.map(part=>part.name)].sort()};}
  trustedMediaRoot(){return this.root;}
  verify(mediaId:string,expectedDigest:string){
    id.parse(mediaId);digest.parse(expectedDigest);const root=this.entry(mediaId),manifestBytes=bounded(join(root,"media-manifest.json"),2*1024*1024),actual=sha(manifestBytes);
    if(actual!==expectedDigest||bounded(join(root,"READY"),64).toString()!==actual)throw new Error("Media manifest digest mismatch");
    const manifest=offlineMediaManifestSchema.parse(JSON.parse(manifestBytes.toString()));if(manifest.mediaId!==mediaId)throw new Error("Media identity mismatch");
    if(new Set(manifest.files.map(file=>file.path)).size!==manifest.files.length)throw new Error("Duplicate media file identity");
    const authority=this.options.authority?.(manifest.signingKeyId),at=Date.parse(manifest.issuedAt);
    if(!authority||authority.revoked||!(Date.parse(authority.validFrom)<=at&&Date.parse(authority.validUntil)>at)||at>Date.now()||Date.now()>=Date.parse(authority.validUntil))throw new Error("Media signing authority unavailable or expired");
    const key=createPublicKey(authority.publicKeyPem);if(key.asymmetricKeyType!=="ed25519"||!verify(null,signatureBody(manifest),key,Buffer.from(bounded(join(root,"SIGNATURE"),128).toString(),"base64")))throw new Error("Media signature invalid");
    const expected=["READY","SIGNATURE","media-manifest.json",...manifest.parts.map(part=>part.name)].sort();
    if(new Set(manifest.parts.map(part=>part.name)).size!==manifest.parts.length||canonicalJson(readdirSync(root).sort())!==canonicalJson(expected))throw new Error("Unexpected or duplicate media parts");
    if(manifest.plaintextBytes!==manifest.files.reduce((sum,file)=>sum+file.bytes,0)||manifest.plaintextBytes>this.maximum||manifest.chunkBytes>16*1024*1024)throw new Error("Media capacity contract mismatch");
    let partBytes=0;for(const part of manifest.parts){const bytes=bounded(join(root,part.name),manifest.chunkBytes+32);partBytes+=bytes.length;
      if(bytes.length!==part.cipherBytes||sha(bytes)!==part.sha256||part.plainBytes>manifest.chunkBytes)throw new Error("Media part digest or size mismatch");}
    if(partBytes>this.maximum+manifest.parts.length*32)throw new Error("Media ciphertext capacity exceeded");
    this.assertPartLayout(manifest);return{manifest,mediaDigest:actual,signatureValid:true,encrypted:true,executionReady:false as const};
  }
  async execute(value:unknown){
    const input=requestSchema.parse(structuredClone(value)),grant=structuredClone(await waitForCancellation(()=>this.options.authorizer?.authorize(structuredClone(input))
      ??Promise.resolve({decision:"denied" as const}),AbortSignal.timeout(10000)));
    const authorized=()=>{if(grant.decision!=="allowed"||!grant.authorizationRef?.trim()||grant.authorizationRef.length>1024||!(Date.parse(grant.expiresAt)>Date.now()))throw new Error("Media authorization denied or expired");};
    authorized();if(this.busy)throw new Error("Media control busy");this.busy=true;let started=false;
    const requestHash=sha(canonicalJson(input));
    try{
      const old=this.sqlite.prepare("SELECT request_hash FROM foundation_media_operations WHERE command_id=?").get(input.commandId) as {request_hash:string}|undefined;
      if(old){if(old.request_hash!==requestHash)throw new Error("Media command conflict");const row=this.sqlite.prepare("SELECT body FROM foundation_media_audits WHERE command_id=? AND phase='prepared'").get(input.commandId) as {body:string}|undefined;
        if(!row)throw new Error("Interrupted media operation is quarantined");const result=JSON.parse(row.body) as {mediaDigest:string;backupManifestDigest:string};
        if(input.operation==="export")this.verify(input.mediaId,result.mediaDigest);else this.backups.completeOfflineImport(input.backupId,result.backupManifestDigest);
        if(!this.sqlite.prepare("SELECT 1 FROM foundation_media_audits WHERE command_id=? AND phase='completed'").get(input.commandId))this.record(input.commandId,"completed",result);
        return{...result,replayed:true,executionReady:false};}
      if(input.operation==="export")this.backups.mediaSource(input.backupId,input.backupManifestDigest);else this.verify(input.mediaId,input.mediaDigest!);
      this.sqlite.transaction(()=>{this.sqlite.prepare("INSERT INTO foundation_media_operations VALUES (?,?,?)").run(input.commandId,requestHash,canonicalJson(input));
        this.record(input.commandId,"started",{operation:input.operation,authorizationRef:grant.decision==="allowed"?grant.authorizationRef:"",at:new Date().toISOString()});})();started=true;
      const result=input.operation==="export"?this.export(input,authorized):this.import(input,authorized);
      this.record(input.commandId,"prepared",result);const publication=input.operation==="export"?this.entry(input.mediaId):join(this.backups.trustedBackupRoot(),input.backupId);
      durable(join(publication,"READY"),input.operation==="export"?result.mediaDigest:result.backupManifestDigest);sync(publication);
      if(input.operation==="export")this.verify(input.mediaId,result.mediaDigest);else this.backups.completeOfflineImport(input.backupId,result.backupManifestDigest);
      this.record(input.commandId,"completed",result);return{...result,replayed:false,executionReady:false};
    }catch(error){if(started)try{this.record(input.commandId,"interrupted",{at:new Date().toISOString(),disposition:"quarantined"});}catch{}throw error;}finally{this.busy=false;}
  }
  private export(input:FoundationMediaRequest,authorized:()=>void){
    if(!this.options.signingPrivateKeyPem)throw new Error("Media signing key unavailable");const privateKey=createPrivateKey(this.options.signingPrivateKeyPem);
    if(privateKey.asymmetricKeyType!=="ed25519")throw new Error("Media signing requires Ed25519");const encryption=this.key(this.options.encryptionKeyId);
    const source=this.backups.mediaSource(input.backupId,input.backupManifestDigest),bytes=source.files.reduce((sum,file)=>sum+file.bytes,0);
    this.capacity(bytes);const root=join(this.root,input.mediaId);mkdirSync(root,{mode:0o700});sync(this.root);const deadline=Date.now()+this.timeout;
    const files=source.files.map(file=>({path:file.path,bytes:file.bytes,sha256:file.sha256})),parts:FoundationOfflineMediaManifest["parts"]=[];let index=0;
    for(const file of files){const fd=openSync(join(source.root,file.path),constants.O_RDONLY|constants.O_NOFOLLOW);try{const stat=fstatSync(fd);if(!stat.isFile()||stat.size!==file.bytes)throw new Error("Media source changed");
      let offset=0;do{authorized();if(Date.now()>=deadline)throw new Error("Media export deadline exceeded");const length=Math.min(this.chunk,file.bytes-offset),plain=Buffer.alloc(length);
        let read=0;while(read<length){const count=readSync(fd,plain,read,length-read,null);if(!count)throw new Error("Media source truncated");read+=count;}
        if(index>=16384)throw new Error("Media part capacity exceeded");const nonce=randomBytes(12),cipher=createCipheriv("aes-256-gcm",encryption,nonce);cipher.setAAD(Buffer.from(aad(input.mediaId,index,file.path,offset,this.options.encryptionKeyId)));
        const encrypted=Buffer.concat([cipher.update(plain),cipher.final()]),name=`part-${String(index).padStart(6,"0")}.bin`;durable(join(root,name),encrypted);
        parts.push({name,file:file.path,fileOffset:offset,plainBytes:length,cipherBytes:encrypted.length,nonce:nonce.toString("base64"),authTag:cipher.getAuthTag().toString("base64"),sha256:sha(encrypted)});
        offset+=length;index++;}while(offset<file.bytes);
    }finally{closeSync(fd);}}
    const manifest=offlineMediaManifestSchema.parse({format:"traceforge.foundation-media.v1",mediaId:input.mediaId,backupId:input.backupId,
      backupManifestDigest:input.backupManifestDigest,signingKeyId:this.options.signingKeyId,encryptionKeyId:this.options.encryptionKeyId,
      issuedAt:new Date().toISOString(),chunkBytes:this.chunk,files,parts,plaintextBytes:bytes,executionReady:false,automaticResume:false});
    const body=canonicalJson(manifest),mediaDigest=sha(body);durable(join(root,"media-manifest.json"),body);
    durable(join(root,"SIGNATURE"),sign(null,signatureBody(manifest),privateKey).toString("base64"));sync(root);return{mediaDigest,backupManifestDigest:input.backupManifestDigest};
  }
  private import(input:FoundationMediaRequest,authorized:()=>void){
    const verified=this.verify(input.mediaId,input.mediaDigest!),manifest=verified.manifest;if(manifest.backupId!==input.backupId||manifest.backupManifestDigest!==input.backupManifestDigest)throw new Error("Media import identity mismatch");
    const key=this.key(manifest.encryptionKeyId),destination=this.backups.beginOfflineImport(input.backupId,manifest.plaintextBytes),deadline=Date.now()+this.timeout;
    let partIndex=0;
    for(const file of manifest.files){const fd=openSync(join(destination,file.path),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600),hasher=createHash("sha256");let bytes=0;
      try{for(const part of manifest.parts.filter(part=>part.file===file.path)){authorized();if(Date.now()>=deadline)throw new Error("Media import deadline exceeded");
        const cipher=bounded(join(this.entry(input.mediaId),part.name),manifest.chunkBytes+32);if(sha(cipher)!==part.sha256)throw new Error("Media part changed during import");
        const decipher=createDecipheriv("aes-256-gcm",key,Buffer.from(part.nonce,"base64"));decipher.setAAD(Buffer.from(aad(input.mediaId,partIndex,file.path,part.fileOffset,manifest.encryptionKeyId)));
        decipher.setAuthTag(Buffer.from(part.authTag,"base64"));const plain=Buffer.concat([decipher.update(cipher),decipher.final()]);
        if(plain.length!==part.plainBytes||part.fileOffset!==bytes)throw new Error("Media plaintext layout mismatch");writeAll(fd,plain);hasher.update(plain);bytes+=plain.length;partIndex++;}
        fsyncSync(fd);if(bytes!==file.bytes||hasher.digest("hex")!==file.sha256)throw new Error("Media plaintext digest mismatch");
      }finally{closeSync(fd);}}
    sync(destination);return{mediaDigest:input.mediaDigest!,backupManifestDigest:manifest.backupManifestDigest};
  }
  private assertPartLayout(manifest:FoundationOfflineMediaManifest){let index=0;for(const file of manifest.files){let offset=0,count=0;
    for(const part of manifest.parts.filter(part=>part.file===file.path)){if(part.name!==`part-${String(index).padStart(6,"0")}.bin`||part.fileOffset!==offset)throw new Error("Media part layout mismatch");offset+=part.plainBytes;index++;count++;}
    if(!count||offset!==file.bytes)throw new Error("Media file coverage mismatch");}if(index!==manifest.parts.length)throw new Error("Media contains unassigned parts");}
  private key(keyId:string){const key=this.options.encryptionKey?.(keyId);if(!key||key.byteLength!==32)throw new Error("Media encryption key unavailable");return Buffer.from(key);}
  private entry(mediaId:string){const path=join(this.root,id.parse(mediaId));if(lstatSync(path).isSymbolicLink()||!lstatSync(path).isDirectory()||realpathSync(path)!==path)throw new Error("Unsafe media entry");return path;}
  private capacity(bytes:number){if(bytes>this.maximum||readdirSync(this.root).length>=this.entries)throw new Error("Media destination capacity exceeded");const stat=statfsSync(this.root,{bigint:true});
    if(stat.bavail*stat.bsize<BigInt(this.floor)+BigInt(bytes)+1024n*1024n)throw new Error("Media destination free-space floor exceeded");}
  private record(commandId:string,phase:string,body:unknown){this.sqlite.prepare("INSERT INTO foundation_media_audits(command_id,phase,body) VALUES (?,?,?)").run(commandId,phase,canonicalJson(body));}
}

export function registerFoundationOfflineMediaRoutes(app:FastifyInstance,control:FoundationOfflineMediaControl){
  const route=(suffix:string,method:"GET"|"POST",handler:(value:unknown)=>unknown)=>app.route({method,url:`/api/foundation/media${suffix}`,handler:async(req,reply)=>{
    try{return await handler(method==="GET"?req.query:req.body);}catch(error){return reply.code(error instanceof z.ZodError?400:409).send({error:error instanceof Error?error.message.slice(0,512):"Media unavailable"});}}});
  route("","GET",()=>control.inspect());route("/audit","GET",value=>control.audit(z.object({commandId:id}).strict().parse(value).commandId));
  route("/verify","POST",value=>{const parsed=z.object({mediaId:id,mediaDigest:digest}).strict().parse(value);return control.verify(parsed.mediaId,parsed.mediaDigest);});
  route("/execute","POST",value=>control.execute(value));
}
