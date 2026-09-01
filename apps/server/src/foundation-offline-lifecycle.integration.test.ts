import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import Fastify from "fastify";
import { createDb, getSqliteClient } from "./db/client.js";
import { FoundationBackupControl } from "./foundation-backup.js";
import { FoundationOfflineMediaControl, type FoundationOfflineMediaOptions } from "./foundation-offline-media.js";
import { FoundationBackupRetentionControl } from "./foundation-backup-retention.js";
import { FoundationRecoveryReadinessControl, recoveryDependencySchema, type FoundationRecoveryReadinessOptions } from "./foundation-recovery-readiness.js";
import { readFoundationRestoreFence } from "./db/foundation-restore-fence.js";
import { registerSecurityAgentFoundation } from "./security-agent-foundation.js";
import { foundationHostControl } from "./foundation-host-control.js";
import { foundationHost } from "./test-fixtures/foundation-host.js";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const roots:string[]=[],dbs:Database.Database[]=[],apps:ReturnType<typeof Fastify>[]=[];
const allow={async authorize(){return{decision:"allowed" as const,authorizationRef:"independent-host-review",expiresAt:"2099-01-01T00:00:00.000Z"};}};
const sha=(value:Buffer|string)=>createHash("sha256").update(value).digest("hex");
const signing=generateKeyPairSync("ed25519"),privateKeyPem=signing.privateKey.export({type:"pkcs8",format:"pem"}).toString(),
  publicKeyPem=signing.publicKey.export({type:"spki",format:"pem"}).toString(),encryptionKey=randomBytes(32);
const authority={publicKeyPem,validFrom:"2026-01-01T00:00:00.000Z",validUntil:"2099-01-01T00:00:00.000Z"};
afterEach(async()=>{vi.restoreAllMocks();for(const app of apps.splice(0))await app.close();for(const db of dbs.splice(0))if(db.open)db.close();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(mediaOverrides:Partial<FoundationOfflineMediaOptions>={}){
  const root=mkdtempSync("/private/tmp/traceforge-offline-");roots.push(root);const sqlite=getSqliteClient(createDb(join(root,"control.sqlite")));dbs.push(sqlite);
  sqlite.prepare("INSERT INTO cases(id,name,status,scope_rules_json,created_at) VALUES ('case','Neutral','active','{}','now')").run();
  const backupOptions={backupRoot:join(root,"backups"),restoreRoot:join(root,"restores"),authorizer:allow,minimumFreeBytes:1};
  const backups=new FoundationBackupControl(sqlite,backupOptions),mediaOptions:FoundationOfflineMediaOptions={mediaRoot:join(root,"media"),signingKeyId:"signer",
    signingPrivateKeyPem:privateKeyPem,encryptionKeyId:"cipher",authority:key=>key==="signer"?authority:undefined,encryptionKey:key=>key==="cipher"?encryptionKey:undefined,
    authorizer:allow,chunkBytes:64*1024,minimumFreeBytes:1,...mediaOverrides};
  const media=new FoundationOfflineMediaControl(sqlite,backups,mediaOptions);
  const backupRequest={commandId:"backup1",operation:"backup" as const,actor:"operator",reason:"Offline recovery"};
  const mediaRequest=(manifestDigest:string,commandId="export1")=>({commandId,operation:"export" as const,mediaId:"media1",backupId:"backup1",backupManifestDigest:manifestDigest,actor:"operator",reason:"Move offline"});
  return{root,sqlite,backups,backupOptions,media,mediaOptions,backupRequest,mediaRequest};
}
async function exported(){const f=fixture();const backup=await f.backups.execute(f.backupRequest),saved=await f.media.execute(f.mediaRequest(backup.manifestDigest));return{...f,backup,saved};}
async function restored(){const f=await exported();await f.backups.execute({commandId:"restore1",operation:"restore",backupId:"backup1",manifestDigest:f.backup.manifestDigest,actor:"operator",reason:"Inspect"});
  const path=join(f.backupOptions.restoreRoot,"restore1","database.sqlite"),copy=getSqliteClient(createDb(path));dbs.push(copy);return{...f,path,copy,fence:readFoundationRestoreFence(copy)!};}

describe("Encrypted offline foundation media",()=>{
  it("exports signed AES-GCM parts and imports them on a fresh host without the original control database",async()=>{
    const f=await exported(),verified=f.media.verify("media1",f.saved.mediaDigest);expect(verified).toMatchObject({signatureValid:true,encrypted:true,executionReady:false});
    expect(verified.manifest.parts.length).toBeGreaterThan(2);expect(new Set(verified.manifest.parts.map(part=>part.nonce)).size).toBe(verified.manifest.parts.length);
    f.sqlite.close();const freshRoot=join(f.root,"fresh");mkdirSync(freshRoot,{mode:0o700});
    const sqlite=getSqliteClient(createDb(join(freshRoot,"control.sqlite")));dbs.push(sqlite);
    const backups=new FoundationBackupControl(sqlite,{backupRoot:join(freshRoot,"backups"),restoreRoot:join(freshRoot,"restores"),authorizer:allow,minimumFreeBytes:1});
    const media=new FoundationOfflineMediaControl(sqlite,backups,{...f.mediaOptions,signingPrivateKeyPem:undefined});
    const imported=await media.execute({commandId:"import1",operation:"import",mediaId:"media1",mediaDigest:f.saved.mediaDigest,backupId:"backup1",
      backupManifestDigest:f.backup.manifestDigest,actor:"operator",reason:"Fresh host import"});
    expect(imported).toMatchObject({backupManifestDigest:f.backup.manifestDigest,executionReady:false});expect(backups.verify("backup1",f.backup.manifestDigest).manifest.backupId).toBe("backup1");
    await backups.execute({commandId:"restore2",operation:"restore",backupId:"backup1",manifestDigest:f.backup.manifestDigest,actor:"operator",reason:"Fresh restore"});
    const copy=getSqliteClient(createDb(join(freshRoot,"restores","restore2","database.sqlite")));dbs.push(copy);expect(copy.readonly).toBe(true);
  });
  it("does not persist private signing or encryption keys and does not expose plaintext database bytes",async()=>{
    const f=fixture();f.sqlite.prepare("INSERT INTO cases(id,name,status,scope_rules_json,created_at) VALUES ('secret-marker','PLAINTEXT_MEDIA_MARKER','active','{}','now')").run();
    const backup=await f.backups.execute(f.backupRequest),saved=await f.media.execute(f.mediaRequest(backup.manifestDigest));
    const files=readdirSync(join(f.mediaOptions.mediaRoot,"media1"));expect(files).not.toContain("database.sqlite");
    const combined=Buffer.concat(files.map(name=>readFileSync(join(f.mediaOptions.mediaRoot,"media1",name))));expect(combined.includes(Buffer.from("PLAINTEXT_MEDIA_MARKER"))).toBe(false);
    expect(combined.includes(encryptionKey)).toBe(false);expect(combined.toString().includes(privateKeyPem.slice(30,70))).toBe(false);expect(saved.executionReady).toBe(false);
  });
  it.each(["part","signature","manifest","ready"])("rejects tampered %s without creating an imported backup",async kind=>{
    const f=await exported(),root=join(f.mediaOptions.mediaRoot,"media1"),manifest=f.media.verify("media1",f.saved.mediaDigest).manifest;
    const path=kind==="part"?join(root,manifest.parts[0]!.name):join(root,kind==="signature"?"SIGNATURE":kind==="manifest"?"media-manifest.json":"READY");
    writeFileSync(path,"tampered");expect(()=>f.media.verify("media1",f.saved.mediaDigest)).toThrow();
  });
  it("rejects revoked, expired or wrong signing authorities",async()=>{const f=await exported();
    for(const replacement of [{...authority,revoked:true},{...authority,validUntil:"2026-02-01T00:00:00.000Z"},{...authority,publicKeyPem:generateKeyPairSync("ed25519").publicKey.export({type:"spki",format:"pem"}).toString()}]){
      const control=new FoundationOfflineMediaControl(f.sqlite,f.backups,{...f.mediaOptions,authority:()=>replacement});expect(()=>control.verify("media1",f.saved.mediaDigest)).toThrow();}
  });
  it("requires the decryption key only for import, while public verification remains available",async()=>{const f=await exported();
    const verifier=new FoundationOfflineMediaControl(f.sqlite,f.backups,{...f.mediaOptions,signingPrivateKeyPem:undefined,encryptionKey:()=>undefined});
    expect(verifier.verify("media1",f.saved.mediaDigest).signatureValid).toBe(true);
    await expect(verifier.execute({commandId:"import1",operation:"import",mediaId:"media1",mediaDigest:f.saved.mediaDigest,backupId:"backup1",
      backupManifestDigest:f.backup.manifestDigest,actor:"operator",reason:"No key"})).rejects.toThrow(/key unavailable|capacity/);
  });
  it("quarantines wrong-key plaintext and never publishes it as a backup",async()=>{const f=await exported(),fresh=join(f.root,"wrong-key");mkdirSync(fresh,{mode:0o700});
    const sqlite=getSqliteClient(createDb(join(fresh,"control.sqlite")));dbs.push(sqlite);const backups=new FoundationBackupControl(sqlite,{backupRoot:join(fresh,"backups"),restoreRoot:join(fresh,"restores"),authorizer:allow,minimumFreeBytes:1});
    const media=new FoundationOfflineMediaControl(sqlite,backups,{...f.mediaOptions,signingPrivateKeyPem:undefined,encryptionKey:()=>randomBytes(32)});
    await expect(media.execute({commandId:"import1",operation:"import",mediaId:"media1",mediaDigest:f.saved.mediaDigest,backupId:"backup1",backupManifestDigest:f.backup.manifestDigest,actor:"operator",reason:"Wrong key"})).rejects.toThrow();
    expect(existsSync(join(fresh,"backups","backup1","READY"))).toBe(false);expect(()=>createDb(join(fresh,"backups","backup1","database.sqlite"))).toThrow("not a bootable host");
  });
  it("requires independent authorization, pinned media digest and matching identities",async()=>{const f=await exported();
    const denied=new FoundationOfflineMediaControl(f.sqlite,f.backups,{...f.mediaOptions,authorizer:undefined});
    await expect(denied.execute({...f.mediaRequest(f.backup.manifestDigest,"denied"),mediaId:"media2"})).rejects.toThrow("authorization");
    await expect(f.media.execute({commandId:"import1",operation:"import",mediaId:"media1",mediaDigest:"a".repeat(64),backupId:"backup1",backupManifestDigest:f.backup.manifestDigest,actor:"operator",reason:"Wrong pin"})).rejects.toThrow();
    await expect(f.media.execute({commandId:"import2",operation:"import",mediaId:"media1",mediaDigest:f.saved.mediaDigest,backupId:"other",backupManifestDigest:f.backup.manifestDigest,actor:"operator",reason:"Wrong identity"})).rejects.toThrow("identity");
  });
  it("re-authorizes idempotent replay and rejects command conflicts",async()=>{let allowed=true;const f=fixture({authorizer:{async authorize(){return allowed?allow.authorize():{decision:"denied" as const};}}});
    const backup=await f.backups.execute(f.backupRequest),request=f.mediaRequest(backup.manifestDigest),saved=await f.media.execute(request);expect((await f.media.execute(request)).replayed).toBe(true);
    allowed=false;await expect(f.media.execute(request)).rejects.toThrow("authorization");allowed=true;
    await expect(f.media.execute({...request,reason:"conflict"})).rejects.toThrow("conflict");expect(saved.mediaDigest).toHaveLength(64);
  });
  it("rejects capacity pressure, overlapping roots and duplicate/unexpected media files",async()=>{const f=await exported();
    expect(()=>new FoundationOfflineMediaControl(f.sqlite,f.backups,{...f.mediaOptions,mediaRoot:f.backupOptions.backupRoot})).toThrow("disjoint");
    const tiny=new FoundationOfflineMediaControl(f.sqlite,f.backups,{...f.mediaOptions,mediaRoot:join(f.root,"tiny"),maximumBytes:1});
    await expect(tiny.execute({...f.mediaRequest(f.backup.manifestDigest,"tiny"),mediaId:"tiny"})).rejects.toThrow("capacity");
    writeFileSync(join(f.mediaOptions.mediaRoot,"media1","extra"),"x");expect(()=>f.media.verify("media1",f.saved.mediaDigest)).toThrow("Unexpected");
  });
  it.each(["prepared","published","completed"])("survives real SIGKILL at media %s without publishing unauthenticated data",async phase=>{const f=fixture(),backup=await f.backups.execute(f.backupRequest);
    writeFileSync(join(f.root,"signing.pem"),privateKeyPem);writeFileSync(join(f.root,"public.pem"),publicKeyPem);writeFileSync(join(f.root,"encryption.key"),encryptionKey);
    const child=spawn(process.execPath,["--import","tsx",fileURLToPath(new URL("../test-fixtures/foundation-media-crash-host.mjs",import.meta.url)),f.root,phase,backup.manifestDigest],{stdio:["ignore","pipe","pipe"]});
    const errors:string[]=[];child.stderr.on("data",chunk=>errors.push(String(chunk)));await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{child.kill("SIGKILL");reject(new Error("Media crash fixture deadline exceeded"));},15000);
      child.on("error",error=>{clearTimeout(timer);reject(error);});child.on("exit",(code,signal)=>{clearTimeout(timer);signal==="SIGKILL"?resolve():reject(new Error(`Unexpected media crash exit ${code}: ${errors.join("")}`));});});
    const request={...f.mediaRequest(backup.manifestDigest,"crash_export"),mediaId:"crash_media",reason:"Crash fixture"};
    if(phase==="prepared"){expect(()=>f.media.verify("crash_media","a".repeat(64))).toThrow();await expect(f.media.execute(request)).rejects.toThrow();}
    else{const root=join(f.mediaOptions.mediaRoot,"crash_media"),before=readdirSync(root);const digest=sha(readFileSync(join(root,"media-manifest.json")));
      expect(f.media.verify("crash_media",digest).signatureValid).toBe(true);expect((await f.media.execute(request)).replayed).toBe(true);expect(readdirSync(root)).toEqual(before);}
  });
});

describe("Default-hold backup and media retention",()=>{
  const preview=(control:FoundationBackupRetentionControl,input:{kind:"backup"|"media";id:string;digest:string;operation:"hold"|"release"|"purge";expectedRevision:number})=>control.preview(input);
  const command=(control:FoundationBackupRetentionControl,input:Parameters<typeof preview>[1],commandId:string)=>({ ...input,commandId,actor:"operator",reason:"Reviewed retention decision",planFingerprint:preview(control,input).planFingerprint });
  it("requires release and a second authorization before exact purge, without claiming secure erase",async()=>{const f=await exported(),retention=new FoundationBackupRetentionControl(f.sqlite,f.backups,f.media,allow);
    expect(retention.inspect({kind:"backup",id:"backup1",digest:f.backup.manifestDigest})).toMatchObject({status:"forensic_hold",automaticDeletion:false});
    const scope={kind:"backup" as const,id:"backup1",digest:f.backup.manifestDigest};await expect(retention.execute({...scope,operation:"purge",expectedRevision:0,commandId:"bad",actor:"operator",reason:"bad",planFingerprint:"a".repeat(64)})).rejects.toThrow("released");
    await retention.execute(command(retention,{...scope,operation:"release",expectedRevision:0},"release"));expect(retention.inspect(scope).status).toBe("destroyable");
    const result=await retention.execute(command(retention,{...scope,operation:"purge",expectedRevision:1},"purge"));expect(result.audit).toMatchObject({resultingStatus:"purged",secureEraseCertified:false});
    expect(existsSync(join(f.backupOptions.backupRoot,"backup1"))).toBe(false);expect(retention.inspect(scope).status).toBe("purged");
  });
  it("can put a released target back on hold and keeps immutable audits",async()=>{const f=await exported(),retention=new FoundationBackupRetentionControl(f.sqlite,f.backups,f.media,allow),scope={kind:"media" as const,id:"media1",digest:f.saved.mediaDigest};
    await retention.execute(command(retention,{...scope,operation:"release",expectedRevision:0},"release"));await retention.execute(command(retention,{...scope,operation:"hold",expectedRevision:1},"hold"));
    expect(retention.inspect(scope).status).toBe("forensic_hold");expect(()=>f.sqlite.exec("DELETE FROM foundation_retention_events")).toThrow("immutable");
  });
  it("purges signed media by its exact verified file list and replays without deleting neighbours",async()=>{const f=await exported(),retention=new FoundationBackupRetentionControl(f.sqlite,f.backups,f.media,allow),scope={kind:"media" as const,id:"media1",digest:f.saved.mediaDigest};
    writeFileSync(join(f.mediaOptions.mediaRoot,"neighbour"),"keep");await retention.execute(command(retention,{...scope,operation:"release",expectedRevision:0},"release"));
    const purge=command(retention,{...scope,operation:"purge",expectedRevision:1},"purge");expect((await retention.execute(purge)).replayed).toBe(false);expect((await retention.execute(purge)).replayed).toBe(true);
    expect(readFileSync(join(f.mediaOptions.mediaRoot,"neighbour"),"utf8")).toBe("keep");expect(existsSync(join(f.mediaOptions.mediaRoot,"media1"))).toBe(false);
  });
  it("fails closed on unreviewed residue instead of recursively deleting it",async()=>{const f=await exported(),retention=new FoundationBackupRetentionControl(f.sqlite,f.backups,f.media,allow),scope={kind:"backup" as const,id:"backup1",digest:f.backup.manifestDigest};
    await retention.execute(command(retention,{...scope,operation:"release",expectedRevision:0},"release"));const purge=command(retention,{...scope,operation:"purge",expectedRevision:1},"purge");
    writeFileSync(join(f.backupOptions.backupRoot,"backup1","unexpected"),"evidence");await expect(retention.execute(purge)).rejects.toThrow();
    expect(readFileSync(join(f.backupOptions.backupRoot,"backup1","unexpected"),"utf8")).toBe("evidence");expect(retention.audit("purge").event).toBeNull();
    await expect(retention.execute(purge)).rejects.toThrow();
  });
  it("reconciles files removed before the final retention audit without deleting twice",async()=>{const f=await exported(),retention=new FoundationBackupRetentionControl(f.sqlite,f.backups,f.media,allow),scope={kind:"backup" as const,id:"backup1",digest:f.backup.manifestDigest};
    await retention.execute(command(retention,{...scope,operation:"release",expectedRevision:0},"release"));const purge=command(retention,{...scope,operation:"purge",expectedRevision:1},"purge");
    f.sqlite.exec("CREATE TRIGGER fail_retention_event BEFORE INSERT ON foundation_retention_events WHEN NEW.command_id='purge' BEGIN SELECT RAISE(ABORT,'injected retention audit failure');END");
    await expect(retention.execute(purge)).rejects.toThrow("injected");expect(existsSync(join(f.backupOptions.backupRoot,"backup1"))).toBe(false);expect(retention.audit("purge").event).toBeNull();
    f.sqlite.exec("DROP TRIGGER fail_retention_event");expect((await retention.execute(purge)).replayed).toBe(true);expect(retention.inspect(scope).status).toBe("purged");
  });
  it("defaults to deny and lists quarantine without automatically deleting it",async()=>{const f=await exported(),retention=new FoundationBackupRetentionControl(f.sqlite,f.backups,f.media);
    writeFileSync(join(f.backupOptions.backupRoot,"quarantine"),"residue");expect(retention.inventory()).toEqual(expect.arrayContaining([expect.objectContaining({kind:"backup",id:"backup1",publication:"published_unverified"})]));
    const scope={kind:"backup" as const,id:"backup1",digest:f.backup.manifestDigest};await expect(retention.execute(command(retention,{...scope,operation:"release",expectedRevision:0},"release"))).rejects.toThrow("authorization");
    expect(existsSync(join(f.backupOptions.backupRoot,"quarantine"))).toBe(true);
  });
  it("exposes media and retention only through the production management channel",async()=>{const root=mkdtempSync("/private/tmp/traceforge-offline-host-");roots.push(root);
    const backup={backupRoot:join(root,"backups"),restoreRoot:join(root,"restores"),authorizer:allow,minimumFreeBytes:1},offlineMedia={mediaRoot:join(root,"media"),signingKeyId:"signer",
      signingPrivateKeyPem:privateKeyPem,encryptionKeyId:"cipher",authority:()=>authority,encryptionKey:()=>encryptionKey,authorizer:allow,minimumFreeBytes:1};
    const host=await foundationHost({root,empty:true,ready:()=>false,foundation:{backup,offlineMedia,retentionAuthorizer:allow}});
    try{expect((await host.app.inject({url:"/api/foundation/media"})).statusCode).toBe(401);expect((await host.app.inject({url:"/api/foundation/retention/inventory"})).statusCode).toBe(401);
      const worker=foundationHostControl(host.app).worker({id:"worker",roles:["observe"],capabilities:["observe"],maxConcurrentWork:1,status:"online",heartbeatAt:new Date().toISOString()},"neutral",1);
      expect((await host.app.inject({url:"/api/foundation/media",headers:worker.headers()})).statusCode).toBe(403);
      const saved=await host.request("/api/foundation/backups/execute",{commandId:"backup1",operation:"backup",actor:"operator",reason:"Offline"});
      const exported=await host.request("/api/foundation/media/execute",{commandId:"export1",operation:"export",mediaId:"media1",backupId:"backup1",backupManifestDigest:saved.manifestDigest,actor:"operator",reason:"Offline"});
      expect(await host.request("/api/foundation/media/verify",{mediaId:"media1",mediaDigest:exported.mediaDigest})).toMatchObject({signatureValid:true,executionReady:false});
    }finally{await host.close(false);}
  });
});

describe("Recovery activation prerequisite checklist",()=>{
  function controlFixture(){return restored().then(f=>{const audit=new Database(join(f.root,"readiness.sqlite"));dbs.push(audit);const fingerprints=new Map(recoveryDependencySchema.options.map(dep=>[dep,sha(dep)]));
    const options:FoundationRecoveryReadinessOptions={auditDb:audit,authorizer:allow,currentFingerprint:dependency=>fingerprints.get(dependency),verifier:{async verify({dependency}){
      return{decision:"satisfied" as const,evidenceRef:`evidence:${dependency}`,materialFingerprint:fingerprints.get(dependency)!,expiresAt:"2099-01-01T00:00:00.000Z"};}}};
    return{...f,audit,fingerprints,options,control:new FoundationRecoveryReadinessControl(f.copy,f.fence,options)};});}
  it("records all dependency proofs outside the restored DB but never exposes activation",async()=>{const f=await controlFixture(),before=readFileSync(f.path);
    for(const dependency of recoveryDependencySchema.options){const state=f.control.inspect().dependencies.find(item=>item.dependency===dependency)!;
      await f.control.execute({commandId:`attest_${dependency}`,dependency,operation:"attest",expectedRevision:state.revision,actor:"operator",reason:"Fresh-host verification"});}
    expect(f.control.inspect()).toMatchObject({assessmentStatus:"review_complete_but_locked",activationSupported:false,fenceRemains:true,executionReady:false});
    expect(readFileSync(f.path)).toEqual(before);expect(()=>f.audit.exec("DELETE FROM foundation_recovery_readiness_events")).toThrow("immutable");
  });
  it("keeps external effects blocked while any old lease or occupancy remains",async()=>{const f=await fixture(),backup=await f.backups.execute(f.backupRequest);
    f.sqlite.exec("CREATE TABLE process_execution_occupancy(id TEXT PRIMARY KEY,process_key TEXT,identity_json TEXT,state TEXT,request_id TEXT,proof_ref TEXT,created_at TEXT)");
    f.sqlite.prepare("INSERT INTO process_execution_occupancy VALUES (?,?,?,'unknown',NULL,NULL,?)").run("old","old-effect",JSON.stringify({attribution:{caseId:"case",runId:"run"}}),"now");
    // Make a second snapshot containing the occupancy.
    const second=await f.backups.execute({...f.backupRequest,commandId:"backup2"});await f.backups.execute({commandId:"restore2",operation:"restore",backupId:"backup2",manifestDigest:second.manifestDigest,actor:"operator",reason:"Inspect"});
    const copy=getSqliteClient(createDb(join(f.backupOptions.restoreRoot,"restore2","database.sqlite")));dbs.push(copy);const fence=readFoundationRestoreFence(copy)!,audit=new Database(join(f.root,"ready2.sqlite"));dbs.push(audit);
    const control=new FoundationRecoveryReadinessControl(copy,fence,{auditDb:audit,authorizer:allow,verifier:{async verify(){return{decision:"satisfied",evidenceRef:"reviewed",materialFingerprint:"a".repeat(64),expiresAt:"2099-01-01T00:00:00.000Z"};}}});
    await control.execute({commandId:"external",dependency:"external_effects",operation:"attest",expectedRevision:0,actor:"operator",reason:"Review"});
    expect(control.inspect()).toMatchObject({assessmentStatus:"blocked",externalBlockers:[expect.objectContaining({kind:"process_occupancy",count:1})]});expect(backup.executionReady).toBe(false);
  });
  it("marks expired, changed and revoked evidence without editing the restored fence",async()=>{const f=await controlFixture();
    await f.control.execute({commandId:"vault",dependency:"vault_key",operation:"attest",expectedRevision:0,actor:"operator",reason:"Review"});f.fingerprints.set("vault_key","b".repeat(64));
    expect(f.control.inspect().dependencies.find(item=>item.dependency==="vault_key")?.status).toBe("stale");
    await f.control.execute({commandId:"revoke",dependency:"vault_key",operation:"revoke",expectedRevision:1,actor:"operator",reason:"Key removed"});expect(f.control.inspect().dependencies.find(item=>item.dependency==="vault_key")?.status).toBe("revoked");
    expect(readFoundationRestoreFence(f.copy)?.mode).toBe("inspection_only");
  });
  it("defaults to deny, re-authorizes replay, rejects conflicts and invalid verifier evidence",async()=>{let allowed=true;const f=await controlFixture();f.options.authorizer={async authorize(){return allowed?allow.authorize():{decision:"denied" as const};}};
    const control=new FoundationRecoveryReadinessControl(f.copy,f.fence,f.options),request={commandId:"vault",dependency:"vault_key" as const,operation:"attest" as const,expectedRevision:0,actor:"operator",reason:"Review"};
    expect((await control.execute(request)).replayed).toBe(false);expect((await control.execute(request)).replayed).toBe(true);allowed=false;await expect(control.execute(request)).rejects.toThrow("authorization");allowed=true;
    await expect(control.execute({...request,reason:"conflict"})).rejects.toThrow("conflict");
    const deniedAudit=new Database(join(f.root,"denied.sqlite"));dbs.push(deniedAudit);const denied=new FoundationRecoveryReadinessControl(f.copy,f.fence,{auditDb:deniedAudit});
    await expect(denied.execute({...request,commandId:"denied"})).rejects.toThrow("authorization");
  });
  it("rejects malformed or expired dependency proofs without advancing revision",async()=>{const f=await controlFixture();const audit=new Database(join(f.root,"invalid-proof.sqlite"));dbs.push(audit);
    for(const result of [{decision:"satisfied" as const,evidenceRef:"e",materialFingerprint:"bad",expiresAt:"2099-01-01T00:00:00.000Z"},
      {decision:"satisfied" as const,evidenceRef:"e",materialFingerprint:"a".repeat(64),expiresAt:"2000-01-01T00:00:00.000Z"}]){
      const control=new FoundationRecoveryReadinessControl(f.copy,f.fence,{auditDb:audit,authorizer:allow,verifier:{async verify(){return result;}}});
      await expect(control.execute({commandId:`invalid_${result.expiresAt.slice(0,4)}`,dependency:"vault_key",operation:"attest",expectedRevision:0,actor:"operator",reason:"Invalid"})).rejects.toThrow();
      expect(control.inspect().dependencies.find(item=>item.dependency==="vault_key")?.revision).toBe(0);}
  });
  it("records a trusted verifier blocker as a revisioned state instead of losing the failed review",async()=>{const f=await controlFixture(),audit=new Database(join(f.root,"blocked.sqlite"));dbs.push(audit);
    const control=new FoundationRecoveryReadinessControl(f.copy,f.fence,{auditDb:audit,authorizer:allow,verifier:{async verify(){return{decision:"blocked",reason:"Current package material is unavailable"};}}});
    const result=await control.execute({commandId:"blocked",dependency:"scenario_materials",operation:"attest",expectedRevision:0,actor:"operator",reason:"Review"});
    expect(result.dependencies.find(item=>item.dependency==="scenario_materials")).toMatchObject({revision:1,status:"blocked"});expect(control.audit("blocked")).toMatchObject({verificationBlocker:"Current package material is unavailable"});
  });
  it("keeps readiness command and event atomic when the audit write fails",async()=>{const f=await controlFixture();f.audit.exec("CREATE TRIGGER fail_readiness BEFORE INSERT ON foundation_recovery_readiness_events BEGIN SELECT RAISE(ABORT,'injected readiness failure');END");
    const request={commandId:"vault",dependency:"vault_key" as const,operation:"attest" as const,expectedRevision:0,actor:"operator",reason:"Review"};await expect(f.control.execute(request)).rejects.toThrow("injected");
    expect((f.audit.prepare("SELECT count(*) count FROM foundation_recovery_readiness_operations").get() as {count:number}).count).toBe(0);f.audit.exec("DROP TRIGGER fail_readiness");expect((await f.control.execute(request)).replayed).toBe(false);
  });
  it("exposes only guarded checklist routes and has no fence-removal endpoint",async()=>{const f=await controlFixture(),app=Fastify();apps.push(app);
    registerSecurityAgentFoundation(app,f.copy,{} as never,f.root,()=>false,{recoveryReadiness:f.options});const headers=foundationHostControl(app).management().headers();
    expect((await app.inject({url:"/api/foundation/recovery/readiness"})).statusCode).toBe(401);
    expect((await app.inject({url:"/api/foundation/recovery/readiness",headers})).json()).toMatchObject({activationSupported:false,fenceRemains:true});
    for(const url of ["/api/foundation/recovery/activate","/api/foundation/recovery/unfence"])
      expect((await app.inject({method:"POST",url,headers,payload:{}})).statusCode).toBe(404);
  });
});
