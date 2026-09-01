import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { canonicalJson, type ScenarioPackageBinding } from "@traceforge/orchestration-core";
import { ScenarioPackageRegistry, type ScenarioPackageResource } from "@traceforge/scenario-sdk";
import { SqlitePackageContextStore, contextContentDigest } from "./package-context-resources.js";

const MAX_ARCHIVE_BYTES = 1024 * 1024;
const text = z.string().trim().min(1).max(128);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const bindingSchema = z.object({ id: text, version: text, schemaRevision: z.number().int().positive() }).strict();
const requestSchema = z.object({ commandId: text, actor: text, reason: z.string().trim().min(1).max(512),
  action: z.enum(["export", "import", "inspect"]), package: bindingSchema, archive: z.unknown().optional(), targetCommandId:text.optional() }).strict();
const envelopeSchema = z.object({ format: z.literal("traceforge.context-package.v1"), keyId: text,
  package: bindingSchema, manifestDigest: digest, issuedAt: z.string().datetime(),
  entries: z.array(z.object({ id: text, descriptor: z.unknown(), content: z.string().nullable() }).strict()).min(1).max(1024),
  signature: z.string().max(128) }).strict();
export type ContextPackageArchive = z.infer<typeof envelopeSchema>;
export interface ContextPackageAuthority {
  publicKeyPem: string;
  packageIds: readonly string[];
  validFrom: string;
  validUntil: string;
  revoked?: boolean;
}
export interface ContextPackageTransferAuthorization {
  commandId: string; actor: string; reason: string; action: "export" | "import" | "inspect";
  package: ScenarioPackageBinding; archiveDigest: string | null;
}
export interface ContextPackageTransferOptions {
  authorizer?: { authorize(request: ContextPackageTransferAuthorization): Promise<
    { decision: "allowed"; authorizationRef: string; expiresAt: string } | { decision: "denied" }> };
  authority?: (keyId: string) => ContextPackageAuthority | undefined;
  signer?: { keyId: string; privateKeyPem: string };
  /** Reviewed deployment dependency only. Never starts or contacts an MCP server. */
  hasExternalProfile?: (source: string, profileDigest: string) => boolean;
}
export interface ContextPackageTransferResult {
  action: "export" | "import" | "inspect";
  package: ScenarioPackageBinding;
  archiveDigest: string;
  auditRef: string;
  executionAuthorized: false;
  automaticRetryAllowed: false;
  resourceCount?: number;
  replayed?: boolean;
  archive?: ContextPackageArchive;
  audit?: {commandId:string;action:string;actor:string;reason:string;authorizationRef:string;createdAt:string};
}
const bindingKey = (binding: ScenarioPackageBinding) => JSON.stringify([binding.id,binding.version,binding.schemaRevision]);
const fingerprint = (value: unknown) => contextContentDigest(canonicalJson(value));

/** No paths, archives-on-disk, decompression, executable code or host configuration on the wire. */
function descriptor(resource: ScenarioPackageResource) {
  return { id: resource.id, kind: resource.kind, version: resource.version, digest: resource.digest, context: resource.context };
}
function boundedJson(value: unknown): void {
  let nodes=0;
  function visit(item: unknown, depth: number): void {
    if (++nodes>100000 || depth>32) throw new Error("Context archive structure exceeds bound");
    if(item===null || typeof item==="string" || typeof item==="boolean")return;
    if(typeof item==="number" && Number.isFinite(item))return;
    if(typeof item!=="object" || (!Array.isArray(item) && Object.getPrototypeOf(item)!==Object.prototype))throw new Error("Context archive must be JSON");
    for(const child of Object.values(item!))visit(child,depth+1);
  }
  visit(value,0);
  if(Buffer.byteLength(JSON.stringify(value))>MAX_ARCHIVE_BYTES)throw new Error("Context archive exceeds byte bound");
}
export function signContextPackageArchive(payload: Omit<ContextPackageArchive,"signature">, privateKeyPem: string): ContextPackageArchive {
  boundedJson(payload);
  const key=createPrivateKey(privateKeyPem);
  if(key.asymmetricKeyType!=="ed25519")throw new Error("Context signing requires Ed25519");
  const envelope={...payload,signature:sign(null,Buffer.from(canonicalJson(payload)),key).toString("base64")};
  boundedJson(envelope);return envelope;
}

/** Bounded in-memory quarantine followed by one SQLite publication transaction. */
export class ContextPackageArchiveControl {
  constructor(private readonly sqlite: Database.Database, private readonly packages: ScenarioPackageRegistry,
    private readonly store: SqlitePackageContextStore, private readonly options: ContextPackageTransferOptions = {},
    private readonly now=()=>new Date().toISOString()) {
    sqlite.exec(`CREATE TABLE IF NOT EXISTS context_package_archives (
      digest TEXT PRIMARY KEY, envelope_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS context_package_imports (
        binding TEXT PRIMARY KEY, archive_digest TEXT NOT NULL REFERENCES context_package_archives(digest), created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS context_package_transfers (
        command_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, action TEXT NOT NULL, binding TEXT NOT NULL,
        archive_digest TEXT NOT NULL REFERENCES context_package_archives(digest), actor TEXT NOT NULL, reason TEXT NOT NULL,
        grant_ref TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS context_archive_bound BEFORE INSERT ON context_package_archives
      WHEN NOT EXISTS(SELECT 1 FROM context_package_archives WHERE digest=NEW.digest) BEGIN
        SELECT CASE WHEN (SELECT count(*) FROM context_package_archives)>=128 OR length(CAST(NEW.envelope_json AS BLOB))>1048576
          OR (SELECT coalesce(sum(length(CAST(envelope_json AS BLOB))),0) FROM context_package_archives)+length(CAST(NEW.envelope_json AS BLOB))>16777216
          THEN RAISE(ABORT,'Context archive storage budget exceeded') END;
        SELECT execution_physical_admit(execution_floor,maximum_database_bytes,maximum_wal_bytes,length(CAST(NEW.envelope_json AS BLOB))+4096,'execution')
          FROM execution_physical_policy WHERE id=1;
      END;
      CREATE TRIGGER IF NOT EXISTS context_transfer_bound BEFORE INSERT ON context_package_transfers BEGIN
        SELECT CASE WHEN (SELECT count(*) FROM context_package_transfers)>=2048 OR length(CAST(NEW.reason AS BLOB))>2048
          OR length(CAST(NEW.grant_ref AS BLOB))>4096 THEN RAISE(ABORT,'Context transfer audit budget exceeded') END;
        SELECT execution_physical_admit(execution_floor,maximum_database_bytes,maximum_wal_bytes,8192,'execution') FROM execution_physical_policy WHERE id=1;
      END;`);
    for(const table of ["context_package_archives","context_package_imports","context_package_transfers"])sqlite.exec(`
      CREATE TRIGGER IF NOT EXISTS ${table}_immutable BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'Context transfer records are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS ${table}_keep BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'Context transfer records are permanent'); END;`);
  }

  private resources(binding: ScenarioPackageBinding): readonly ScenarioPackageResource[] {
    const pkg=this.packages.definitions().map(d=>{
      try{return this.packages.requireBinding(binding,d.kind,d.version);}catch{return null;}
    }).find(Boolean);
    if(!pkg?.resourceManifest?.resources.length)throw new Error("Exact reviewed Package manifest is required");
    // Executable assets and schema migrations need a different installer, never partial export.
    if(pkg.resourceManifest.resources.some(r=>!r.context))throw new Error("This archive supports complete context-only resource manifests");
    // Registry objects are host-owned, but may have been mutated since construction.
    new ScenarioPackageRegistry([pkg]);
    return [...pkg.resourceManifest.resources].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  }

  private manifestDigest(binding: ScenarioPackageBinding): string {
    const resources=this.resources(binding);
    const pkg=this.packages.definitions().map(d=>{try{return this.packages.requireBinding(binding,d.kind,d.version);}catch{return null;}}).find(Boolean)!;
    return fingerprint({package:binding,revision:pkg.resourceManifest!.revision,resources:resources.map(descriptor)});
  }

  private verify(value: unknown): ContextPackageArchive {
    boundedJson(value);const archive=envelopeSchema.parse(value);
    const authority=this.options.authority?.(archive.keyId),now=Date.parse(this.now()),issued=Date.parse(archive.issuedAt);
    if(!authority || authority.revoked || !authority.packageIds.includes(archive.package.id)
      || !(Date.parse(authority.validFrom)<=issued && issued<=now && now<Date.parse(authority.validUntil)))throw new Error("Context archive signer is not currently trusted");
    const key=createPublicKey(authority.publicKeyPem),signature=Buffer.from(archive.signature,"base64");
    const {signature:_signature,...payload}=archive;
    if(key.asymmetricKeyType!=="ed25519" || signature.length!==64 || signature.toString("base64")!==archive.signature
      || !verify(null,Buffer.from(canonicalJson(payload)),key,signature))throw new Error("Invalid context archive signature");
    const resources=this.resources(archive.package);
    if(archive.manifestDigest!==this.manifestDigest(archive.package) || archive.entries.length!==resources.length)throw new Error("Context archive manifest mismatch");
    resources.forEach((resource,index)=>{
      const entry=archive.entries[index]!;
      if(entry.id!==resource.id || canonicalJson(entry.descriptor)!==canonicalJson(descriptor(resource)))throw new Error("Context archive inventory mismatch");
      if(resource.context!.external ? entry.content!==null : typeof entry.content!=="string" || Buffer.byteLength(entry.content)>65536 || contextContentDigest(entry.content)!==resource.digest)
        throw new Error("Context archive content mismatch");
    });
    return archive;
  }

  private current(binding: ScenarioPackageBinding): void {
    for(const resource of this.resources(binding)) {
      this.store.assertAvailable(binding,resource);
      const context=resource.context!,now=Date.parse(this.now());
      if((context.validFrom!==undefined && !(Date.parse(context.validFrom)<=now))
        || (context.expiresAt!==undefined && !(now<Date.parse(context.expiresAt))))throw new Error("Context resource is outside its validity window");
      if(context.external && !this.options.hasExternalProfile?.(context.external.source,context.external.profileDigest))throw new Error("Reviewed external context dependency missing");
    }
  }

  /** Invoked on current context reads/selection; no export, writes or network access. */
  assertImportedTrust(binding: ScenarioPackageBinding): void {
    const imported=this.sqlite.prepare("SELECT archive_digest FROM context_package_imports WHERE binding=?").get(bindingKey(binding)) as {archive_digest:string}|undefined;
    if(imported)this.verify(this.archive(imported.archive_digest));
  }

  async execute(value: unknown): Promise<ContextPackageTransferResult> {
    // Routes also enforce a transport byte limit before parsing; injected callers get the same bounded contract.
    boundedJson(value);
    // Pin the bytes covered by the grant before any asynchronous authorization.
    const snapshot=structuredClone(value),request=requestSchema.parse(snapshot);
    if(request.action==="import" ? request.archive===undefined : request.archive!==undefined)throw new Error("Invalid context transfer payload");
    if(request.action==="inspect" ? request.targetCommandId===undefined : request.targetCommandId!==undefined)throw new Error("Invalid context audit target");
    const target=request.action==="inspect"?this.sqlite.prepare("SELECT * FROM context_package_transfers WHERE command_id=? AND binding=?")
      .get(request.targetCommandId,bindingKey(request.package)) as {command_id:string;action:string;archive_digest:string;actor:string;reason:string;grant_ref:string;created_at:string}|undefined:undefined;
    if(request.action==="inspect" && !target)throw new Error("Context transfer audit unavailable");
    const requestFingerprint=fingerprint(snapshot),inputDigest=request.action==="import"?fingerprint(request.archive):target?.archive_digest??null;
    let timer:ReturnType<typeof setTimeout>|undefined;
    const grant=await Promise.race([this.options.authorizer?.authorize({commandId:request.commandId,actor:request.actor,reason:request.reason,
      action:request.action,package:request.package,archiveDigest:inputDigest}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("Context transfer authorization deadline exceeded")),10000);})])
      .finally(()=>{if(timer)clearTimeout(timer);});
    if(grant?.decision!=="allowed" || !grant.authorizationRef.trim() || grant.authorizationRef.length>1024 || !(Date.parse(grant.expiresAt)>Date.parse(this.now())))throw new Error("Context transfer authorization denied");
    return this.sqlite.transaction(()=>{
      if(!(Date.parse(grant.expiresAt)>Date.parse(this.now())))throw new Error("Context transfer grant expired");
      if(target)return {action:"inspect" as const,package:request.package,archiveDigest:target.archive_digest,auditRef:`context-transfer:${target.command_id}`,
        executionAuthorized:false as const,automaticRetryAllowed:false as const,audit:{commandId:target.command_id,action:target.action,actor:target.actor,
          reason:target.reason,authorizationRef:target.grant_ref,createdAt:target.created_at}};
      const previous=this.sqlite.prepare("SELECT fingerprint,archive_digest FROM context_package_transfers WHERE command_id=?").get(request.commandId) as {fingerprint:string;archive_digest:string}|undefined;
      if(previous && previous.fingerprint!==requestFingerprint)throw new Error("Context transfer command conflict");
      this.current(request.package);
      let archive:ContextPackageArchive;
      if(previous)archive=this.verify(this.archive(previous.archive_digest));
      else if(request.action==="import")archive=this.verify(request.archive);
      else {
        const signer=this.options.signer;if(!signer)throw new Error("Context archive signing is disabled");
        archive=signContextPackageArchive({format:"traceforge.context-package.v1",keyId:signer.keyId,package:request.package,
          manifestDigest:this.manifestDigest(request.package),issuedAt:this.now(),entries:this.resources(request.package).map(resource=>({
            id:resource.id,descriptor:descriptor(resource),content:resource.context!.external?null:this.store.read(request.package,resource)}))},signer.privateKeyPem);
        archive=this.verify(archive);
      }
      if(bindingKey(archive.package)!==bindingKey(request.package))throw new Error("Context transfer Package identity mismatch");
      const archiveDigest=fingerprint(archive);
      if(request.action==="export" || previous)for(const resource of this.resources(request.package))if(!resource.context!.external)this.store.read(request.package,resource);
      if(!previous){
        this.sqlite.prepare("INSERT OR IGNORE INTO context_package_archives VALUES (?,?)").run(archiveDigest,canonicalJson(archive));
        // Re-read after INSERT OR IGNORE: a corrupted pre-existing artifact cannot be silently reused.
        this.archive(archiveDigest);
        if(request.action==="import"){
          const old=this.sqlite.prepare("SELECT archive_digest FROM context_package_imports WHERE binding=?").get(bindingKey(request.package)) as {archive_digest:string}|undefined;
          if(old && old.archive_digest!==archiveDigest)throw new Error("Context Package version already has a different signed archive");
          this.store.install(this.packages,archive.entries.filter(e=>e.content!==null).map(e=>({package:request.package,resourceId:e.id,content:e.content!})));
          this.sqlite.prepare("INSERT OR IGNORE INTO context_package_imports VALUES (?,?,?)").run(bindingKey(request.package),archiveDigest,this.now());
        }
        this.sqlite.prepare("INSERT INTO context_package_transfers VALUES (?,?,?,?,?,?,?,?,?)").run(request.commandId,requestFingerprint,request.action,
          bindingKey(request.package),archiveDigest,request.actor,request.reason,grant.authorizationRef,this.now());
      }
      if(!(Date.parse(grant.expiresAt)>Date.parse(this.now())))throw new Error("Context transfer grant expired before commit");
      this.verify(archive);this.current(request.package);
      return {action:request.action,package:request.package,archiveDigest,auditRef:`context-transfer:${request.commandId}`,
        resourceCount:archive.entries.length,replayed:!!previous,executionAuthorized:false as const,automaticRetryAllowed:false as const,
        ...(request.action==="export"?{archive}:{})};
    })();
  }

  private archive(digest: string): ContextPackageArchive {
    const row=this.sqlite.prepare("SELECT envelope_json FROM context_package_archives WHERE digest=?").get(digest) as {envelope_json:string}|undefined;
    if(!row || Buffer.byteLength(row.envelope_json)>MAX_ARCHIVE_BYTES)throw new Error("Context archive unavailable");
    const value=JSON.parse(row.envelope_json);boundedJson(value);
    if(fingerprint(value)!==digest)throw new Error("Context archive integrity mismatch");return value;
  }
}

export function registerContextPackageArchiveRoutes(app: FastifyInstance, control: ContextPackageArchiveControl): void {
  app.post("/api/scenarios/context-packages/transfer",{bodyLimit:MAX_ARCHIVE_BYTES},async(request,reply)=>{
    try{return await control.execute(request.body);}catch{return reply.code(409).send({error:"Context package transfer rejected: authorization, signature, identity, lifecycle or capacity check failed"});}
  });
}
