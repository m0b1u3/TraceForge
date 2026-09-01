import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { canonicalJson, type ScenarioPackageBinding } from "@traceforge/orchestration-core";
import { ScenarioPackageRegistry, type ScenarioPackageInstallation } from "@traceforge/scenario-sdk";
import { waitForCancellation } from "@traceforge/worker-runtime";

const text=z.string().trim().min(1).max(256),digest=z.string().regex(/^sha256:[a-f0-9]{64}$/);
const binding=z.object({id:text,version:text,schemaRevision:z.number().int().positive()}).strict();
const relative=z.string().min(1).max(512).refine(p=>p.split("/").every(s=>/^[a-zA-Z0-9_.-]+$/.test(s) && s!=="." && s!==".."),"Invalid material path");
const manifestSchema=z.object({format:z.literal("traceforge.scenario-material.v1"),package:binding,entry:relative,
  files:z.array(z.object({path:relative,role:z.enum(["entry","dependency","data"]),size:z.number().int().min(0).max(1024*1024),digest}).strict()).min(1).max(128)}).strict();
const reviewSchema=z.object({format:z.literal("traceforge.scenario-review.v1"),package:binding,materialDigest:digest,contractDigest:digest,
  assemblyRef:text,keyId:text,reviewRef:text,issuedAt:z.string().datetime(),expiresAt:z.string().datetime(),signature:z.string().max(128)}).strict();
export type ScenarioMaterialManifest=z.infer<typeof manifestSchema>;
export type ScenarioPackageReview=z.infer<typeof reviewSchema>;
export interface ScenarioReviewAuthority {publicKeyPem:string;packageIds:readonly string[];validFrom:string;validUntil:string;revoked?:boolean}
export interface ScenarioReviewedInstallation {root:string;manifest:ScenarioMaterialManifest;review:ScenarioPackageReview}
const revokeSchema=z.object({commandId:text,package:binding,actor:text,reason:z.string().trim().min(1).max(1024)}).strict();
type RevocationRequest=z.infer<typeof revokeSchema>;
export interface ScenarioPackageTrustOptions {
  installations?:readonly ScenarioReviewedInstallation[];
  authority?:(keyId:string)=>ScenarioReviewAuthority|undefined;
  /** Trusted host associates the already-loaded object with independently reviewed material. This is not a module loader or sandbox. */
  assertAssembly?:(installation:ScenarioPackageInstallation,review:ScenarioPackageReview)=>void;
  revokeAuthorizer?:{authorize(request:RevocationRequest):Promise<{decision:"allowed";authorizationRef:string;expiresAt:string}|{decision:"denied"}>};
  allowUnreviewedDevelopmentPackages?:boolean;
}
export const scenarioMaterialDigest=(value:unknown)=>`sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
const bytesDigest=(value:Buffer)=>`sha256:${createHash("sha256").update(value).digest("hex")}`;
export function scenarioPackageContractDigest(pkg:ScenarioPackageInstallation):string {
  return scenarioMaterialDigest({id:pkg.id,version:pkg.version,schemaRevision:pkg.schemaRevision,definition:pkg.definition,
    outputs:pkg.outputSchemas.map(s=>({kind:s.kind,version:s.version})),resources:pkg.resourceManifest??null,migrations:pkg.migrationManifest??null});
}
export function signScenarioPackageReview(payload:Omit<ScenarioPackageReview,"signature">,privateKeyPem:string):ScenarioPackageReview {
  const key=createPrivateKey(privateKeyPem);if(key.asymmetricKeyType!=="ed25519")throw new Error("Review signing requires Ed25519");
  return reviewSchema.parse({...payload,signature:sign(null,Buffer.from(canonicalJson(payload)),key).toString("base64")});
}
const versionKey=(pkg:ScenarioPackageBinding)=>canonicalJson([pkg.id,pkg.version]);
const functions=(pkg:ScenarioPackageInstallation)=>[pkg.createToolSources,pkg.authorizationPolicy.parseScope,pkg.authorizationPolicy.authorizeResource,
  ...pkg.outputSchemas.flatMap(s=>[s.validate,s.mapToEvidence])];
interface Registration {root:string;manifest:ScenarioMaterialManifest;review:ScenarioPackageReview;contract:string;functions:unknown[]}

/** Reads explicitly configured local material; never imports code, writes files, or fetches dependencies. */
export class ScenarioPackageTrustControl {
  readonly registry:ScenarioPackageRegistry;
  private readonly configured=new Map<string,Registration>();
  private readonly rejected=new Map<string,string>();
  constructor(private readonly sqlite:Database.Database,private readonly source:ScenarioPackageRegistry,
    private readonly options:ScenarioPackageTrustOptions={},private readonly now=()=>new Date().toISOString()) {
    sqlite.exec(`CREATE TABLE IF NOT EXISTS scenario_package_materials (
      version_key TEXT PRIMARY KEY,binding_json TEXT NOT NULL,material_digest TEXT NOT NULL,contract_digest TEXT NOT NULL,manifest_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS scenario_package_reviews (digest TEXT PRIMARY KEY,review_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS scenario_package_revocations (
      material_digest TEXT PRIMARY KEY,command_id TEXT NOT NULL UNIQUE,request_hash TEXT NOT NULL,audit_hash TEXT NOT NULL,audit_json TEXT NOT NULL);`);
    for(const [table,limit,field,bytes] of [["scenario_package_materials",256,"manifest_json",65536],["scenario_package_reviews",1024,"review_json",16384],["scenario_package_revocations",10000,"audit_json",4096]] as const){
      for(const operation of ["UPDATE","DELETE"])sqlite.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_${operation} BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT,'Package trust history is immutable'); END;`);
      sqlite.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_capacity BEFORE INSERT ON ${table} BEGIN
        SELECT CASE WHEN (SELECT count(*) FROM ${table})>=${limit} OR length(CAST(NEW.${field} AS BLOB))>${bytes} THEN RAISE(ABORT,'Package trust capacity exceeded') END;
        SELECT execution_physical_admit(recovery_floor,maximum_database_bytes,maximum_wal_bytes,${bytes+12288},'recovery') FROM execution_physical_policy WHERE id=1; END;`);
    }
    if((options.installations?.length??0)>256)throw new Error("Too many configured Package materials");
    for(const item of options.installations??[]){
      const key=versionKey(item.manifest.package);
      if(this.configured.has(key) || this.rejected.has(key))throw new Error("Duplicate reviewed Package configuration");
      try {
        const manifest=manifestSchema.parse(structuredClone(item.manifest)),review=reviewSchema.parse(structuredClone(item.review));
        const pkg=source.list().find(p=>versionKey(p)===key);if(!pkg)throw new Error("Reviewed Package is not installed");
        const registration={root:resolve(item.root),manifest,review,contract:scenarioPackageContractDigest(pkg),functions:functions(pkg)};
        this.verify(pkg,registration,false);
        sqlite.transaction(()=>{
          const existing=this.material(pkg);
          if(existing){if(existing.material_digest!==review.materialDigest || existing.contract_digest!==review.contractDigest || existing.binding_json!==canonicalJson(manifest.package)
            || existing.manifest_json!==canonicalJson(manifest))throw new Error("An installed Package version cannot change its reviewed material");}
          else sqlite.prepare("INSERT INTO scenario_package_materials VALUES (?,?,?,?,?)").run(key,canonicalJson(manifest.package),review.materialDigest,review.contractDigest,canonicalJson(manifest));
          const reviewDigest=scenarioMaterialDigest(review),saved=sqlite.prepare("SELECT review_json FROM scenario_package_reviews WHERE digest=?").get(reviewDigest) as {review_json:string}|undefined;
          if(saved){if(saved.review_json!==canonicalJson(review))throw new Error("Stored Package review is corrupt");}
          else sqlite.prepare("INSERT INTO scenario_package_reviews VALUES (?,?)").run(reviewDigest,canonicalJson(review));
        })();
        this.configured.set(key,registration);
      }catch(error){this.rejected.set(key,message(error));}
    }
    this.registry=new ScenarioPackageRegistry(source.list(),pkg=>{
      source.assertAvailable(pkg);const key=versionKey(pkg),registration=this.configured.get(key);
      if(this.rejected.has(key))throw new Error(this.rejected.get(key));
      if(!registration){if(options.allowUnreviewedDevelopmentPackages && !this.material(pkg))return;throw new Error("Package review material missing; explicit host review required");}
      this.verify(pkg,registration,true);
    });
  }
  private material(pkg:ScenarioPackageBinding){return this.sqlite.prepare("SELECT * FROM scenario_package_materials WHERE version_key=?").get(versionKey(pkg)) as
    {binding_json:string;material_digest:string;contract_digest:string;manifest_json:string}|undefined;}
  private verify(pkg:ScenarioPackageInstallation,registration:Registration,persisted:boolean){
    const {manifest,review}=registration,at=Date.parse(this.now()),authority=this.options.authority?.(review.keyId);
    if(!authority || authority.revoked || !authority.packageIds.includes(pkg.id) || !(Date.parse(authority.validFrom)<=at && Date.parse(authority.validUntil)>at)
      || !(Date.parse(review.issuedAt)<=at && Date.parse(review.expiresAt)>at) || Date.parse(review.issuedAt)<Date.parse(authority.validFrom)
      || Date.parse(review.expiresAt)>Date.parse(authority.validUntil))throw new Error("Package review authority or validity is unavailable");
    const {signature,...payload}=review,key=createPublicKey(authority.publicKeyPem),signatureBytes=Buffer.from(signature,"base64");
    if(key.asymmetricKeyType!=="ed25519" || signatureBytes.length!==64 || signatureBytes.toString("base64")!==signature
      || !verify(null,Buffer.from(canonicalJson(payload)),key,signatureBytes))throw new Error("Invalid Package review signature");
    const pkgBinding=this.source.bindingFor(pkg);
    if(canonicalJson(manifest.package)!==canonicalJson(pkgBinding) || canonicalJson(review.package)!==canonicalJson(pkgBinding)
      || scenarioMaterialDigest(manifest)!==review.materialDigest || scenarioPackageContractDigest(pkg)!==review.contractDigest
      || registration.contract!==review.contractDigest || functions(pkg).some((f,i)=>f!==registration.functions[i]))throw new Error("Package object or material contract changed");
    if(this.sqlite.prepare("SELECT 1 FROM scenario_package_revocations WHERE material_digest=?").get(review.materialDigest))throw new Error("Package material is revoked");
    if(persisted){const saved=this.material(pkg),endorsement=this.sqlite.prepare("SELECT review_json FROM scenario_package_reviews WHERE digest=?").get(scenarioMaterialDigest(review)) as {review_json:string}|undefined;
      if(!saved || saved.material_digest!==review.materialDigest || saved.contract_digest!==review.contractDigest || saved.binding_json!==canonicalJson(pkgBinding)
        || saved.manifest_json!==canonicalJson(manifest) || endorsement?.review_json!==canonicalJson(review))throw new Error("Package trust record integrity mismatch");}
    verifyMaterialFiles(registration.root,manifest);
    if(!this.options.assertAssembly)throw new Error("Trusted host assembly attestation is missing");
    const result:unknown=this.options.assertAssembly(pkg,structuredClone(review));
    if(result!==undefined){void Promise.resolve(result).catch(()=>{});throw new Error("Host assembly attestation must be synchronous");}
    if(scenarioPackageContractDigest(pkg)!==registration.contract || functions(pkg).some((f,i)=>f!==registration.functions[i]))throw new Error("Package changed during assembly attestation");
  }
  snapshot(){return {mode:this.options.allowUnreviewedDevelopmentPackages?"development_opt_in":"review_required",automaticCodeLoading:false,arbitraryJavaScriptIsolation:false,
    packages:this.source.list().map(pkg=>{const registration=this.configured.get(versionKey(pkg));let status="reviewed_available",reason:string|null=null;
      try{this.registry.assertAvailable(pkg);if(!registration)status="development_unreviewed";}catch(error){status="recovery_required";reason=message(error);}
      return {package:this.source.bindingFor(pkg),status,reason,materialDigest:registration?.review.materialDigest??null,reviewRef:registration?.review.reviewRef??null};})};}
  inspect(commandId:string){
    const row=this.sqlite.prepare("SELECT audit_hash,audit_json FROM scenario_package_revocations WHERE command_id=?").get(text.parse(commandId)) as {audit_hash:string;audit_json:string}|undefined;
    if(!row)throw new Error("Package revocation audit not found");const audit=JSON.parse(row.audit_json);
    if(scenarioMaterialDigest(audit)!==row.audit_hash || audit.commandId!==commandId)throw new Error("Package revocation audit is corrupt");return audit;
  }
  async revoke(value:unknown){
    const input=revokeSchema.parse(structuredClone(value)),requestHash=scenarioMaterialDigest(input),material=this.material(input.package);
    if(!material || material.binding_json!==canonicalJson(input.package))throw new Error("Reviewed Package binding not found");
    const grant=structuredClone(await waitForCancellation(()=>this.options.revokeAuthorizer?.authorize(structuredClone(input))??Promise.resolve({decision:"denied" as const}),AbortSignal.timeout(10000)));
    if(grant.decision!=="allowed" || !grant.authorizationRef.trim() || !(Date.parse(grant.expiresAt)>Date.parse(this.now())))throw new Error("Package revocation authorization denied or expired");
    return this.sqlite.transaction(()=>{
      if(!(Date.parse(grant.expiresAt)>Date.parse(this.now())))throw new Error("Package revocation authorization expired");
      const saved=this.sqlite.prepare("SELECT * FROM scenario_package_revocations WHERE command_id=?").get(input.commandId) as {request_hash:string;audit_hash:string;audit_json:string}|undefined;
      if(saved){if(saved.request_hash!==requestHash)throw new Error("Package trust command conflicts");const audit=JSON.parse(saved.audit_json);if(scenarioMaterialDigest(audit)!==saved.audit_hash)throw new Error("Package revocation audit is corrupt");return {audit,replayed:true};}
      const audit={...input,materialDigest:material.material_digest,authorizationRef:grant.authorizationRef,at:this.now(),automaticResume:false};
      this.sqlite.prepare("INSERT INTO scenario_package_revocations VALUES (?,?,?,?,?)").run(material.material_digest,input.commandId,requestHash,scenarioMaterialDigest(audit),canonicalJson(audit));
      return {audit,replayed:false};
    })();
  }
}
function verifyMaterialFiles(root:string,manifest:ScenarioMaterialManifest):void {
  try {
    if(realpathSync(root)!==root || !lstatSync(root).isDirectory())throw new Error("Material root must be a real directory");
    const declared=new Map(manifest.files.map(f=>[f.path,f]));
    if(declared.size!==manifest.files.length || manifest.files.filter(f=>f.role==="entry").length!==1 || declared.get(manifest.entry)?.role!=="entry")throw new Error("Invalid material entry or duplicate path");
    let total=0,visited=0;const found=new Set<string>();
    function walk(path:string,depth:number){
      if(depth>16)throw new Error("Material directory depth exceeded");
      const directory=opendirSync(join(root,path));
      try{for(let entry=directory.readSync();entry;entry=directory.readSync()){
        const name=entry.name;
        if(++visited>256)throw new Error("Material file budget exceeded");
        const relativePath=path?`${path}/${name}`:name,absolute=join(root,relativePath),stat=lstatSync(absolute);
        if(stat.isSymbolicLink())throw new Error("Material links are not allowed");
        if(stat.isDirectory()){walk(relativePath,depth+1);continue;}
        const file=declared.get(relativePath);if(!file || !stat.isFile() || stat.size!==file.size)throw new Error("Material file list mismatch");
        total+=file.size;if(total>4*1024*1024)throw new Error("Material aggregate byte budget exceeded");
        const fd=openSync(absolute,constants.O_RDONLY|constants.O_NOFOLLOW);
        try{const before=fstatSync(fd),buffer=Buffer.alloc(file.size+1);let length=0,read=0;
          do {read=readSync(fd,buffer,length,buffer.length-length,null);length+=read;}while(read>0 && length<buffer.length);
          const after=fstatSync(fd);
          if(length!==file.size || before.size!==file.size || before.ino!==stat.ino || before.mtimeMs!==after.mtimeMs || before.size!==after.size
            || bytesDigest(buffer.subarray(0,length))!==file.digest)throw new Error("Material file changed or digest mismatched");
        }finally{closeSync(fd);}found.add(relativePath);
      }}finally{directory.closeSync();}
    }
    walk("",0);if(found.size!==declared.size)throw new Error("Material dependency is missing");
  }catch(error){if(error instanceof Error && "code" in error)throw new Error("Material files unavailable; restore reviewed local files");throw error;}
}
function message(error:unknown){return (error instanceof Error?error.message:"Package trust unavailable").slice(0,1024);}
export function registerScenarioPackageTrustRoutes(app:FastifyInstance,control:ScenarioPackageTrustControl){
  app.get("/api/scenarios/package-trust",async()=>control.snapshot());
  app.get("/api/scenarios/package-trust/revocations",async(request,reply)=>{try{return control.inspect(z.object({commandId:text}).parse(request.query).commandId);}catch(error){return reply.code(409).send({error:message(error)});}});
  app.post("/api/scenarios/package-trust/revoke",async(request,reply)=>{try{return await control.revoke(request.body);}catch(error){return reply.code(error instanceof z.ZodError?400:409).send({error:message(error)});}});
}
