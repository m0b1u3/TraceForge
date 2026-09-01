import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ContextPackageArchiveControl, signContextPackageArchive } from "./context-package-archive.js";
import { SqlitePackageContextStore } from "./package-context-resources.js";
import { archiveFixture, archivePackage, archivePrivateKey, transferOptions, transfer } from "./test-fixtures/context-archive.js";
import { contextBinding, contextText } from "./test-fixtures/context-package.js";
import { database } from "./test-fixtures/execution-recovery.js";
import { foundationHost, eventually } from "./test-fixtures/foundation-host.js";
import { ScenarioPackageRegistry } from "@traceforge/scenario-sdk";

const cleanup:Array<()=>unknown|Promise<unknown>>=[];
afterEach(async()=>{vi.restoreAllMocks();for(const close of cleanup.splice(0).reverse())await close();});
function fixture(...args:Parameters<typeof archiveFixture>){const f=archiveFixture(...args);cleanup.push(()=>{if(f.sqlite.open)f.sqlite.close();});return f;}
async function exported(){const source=fixture();const result=await source.control.execute(transfer("export"));return {source,archive:result.archive!};}
function count(f:ReturnType<typeof fixture>,table:string){return (f.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {n:number}).n;}

describe("Signed context package migration",()=>{
  it.each(["archive_uncommitted","content_uncommitted","committed"])("recovers a SIGKILL at %s without a half-published package",async(phase)=>{
    const root=mkdtempSync(join(tmpdir(),"traceforge-resource-crash-"));cleanup.push(()=>rmSync(root,{recursive:true,force:true}));const path=join(root,"state.db");
    const saved=await new Promise<{publicKey:string;archive:unknown}>((resolve,reject)=>{
      const child=spawn(process.execPath,["--import","tsx",fileURLToPath(new URL("../test-fixtures/context-archive-crash-host.mjs",import.meta.url)),path,phase],{stdio:["ignore","pipe","pipe"]});
      let output="",errors="",ready=false,failure:Error|undefined;
      const timer=setTimeout(()=>{failure=new Error("Resource migration crash fixture timed out");child.kill("SIGKILL");},10000);
      child.stdout.on("data",chunk=>{output+=chunk.toString();if(output.includes("\n")){ready=true;child.kill("SIGKILL");}});
      child.stderr.on("data",chunk=>{errors=(errors+chunk.toString()).slice(-4096);});
      child.on("error",error=>{clearTimeout(timer);reject(error);});
      child.on("exit",(_code,signal)=>{clearTimeout(timer);if(failure)reject(failure);else if(!ready||signal!=="SIGKILL")reject(new Error(errors));else resolve(JSON.parse(output.trim()));});
    });
    const options=transferOptions(),authority=options.authority!("fixture")!;options.authority=()=>({...authority,publicKeyPem:saved.publicKey});
    for(let reopen=0;reopen<2;reopen++){
      const restored=fixture(false,database(path),options);
      expect(count(restored,"package_context_content")).toBe(phase==="committed"?2:0);
      expect(count(restored,"context_package_imports")).toBe(phase==="committed"?1:0);
      expect(count(restored,"context_package_transfers")).toBe(phase==="committed"?1:0);restored.sqlite.close();
    }
    const restored=fixture(false,database(path),options);
    expect(await restored.control.execute(transfer("import",saved.archive))).toMatchObject({replayed:phase==="committed"});
    expect(restored.store.read(contextBinding,restored.pkg.resourceManifest!.resources[0]!)).toBe(contextText);
  },15000);
  it("moves a complete Skill/knowledge inventory atomically and replays without adding authority",async()=>{
    const {source,archive}=await exported(),target=fixture(false);
    expect(archive.entries).toHaveLength(2);expect(JSON.stringify(archive)).not.toContain("locator");
    const result=await target.control.execute(transfer("import",archive));
    expect(result).toMatchObject({resourceCount:2,replayed:false,executionAuthorized:false,automaticRetryAllowed:false});
    expect(target.store.read(contextBinding,target.pkg.resourceManifest!.resources[0]!)).toBe(contextText);
    expect(await target.control.execute(transfer("import",archive))).toMatchObject({replayed:true,archiveDigest:result.archiveDigest});
    expect((await source.control.execute(transfer("export"))).archive).toEqual(archive);
    expect(count(target,"context_package_imports")).toBe(1);expect(count(target,"context_package_transfers")).toBe(1);
    expect(count(target,"scenario_event_streams")).toBe(0);
    expect(()=>new SqlitePackageContextStore(target.sqlite).read(contextBinding,target.pkg.resourceManifest!.resources[0]!)).toThrow("trust verifier");
  });
  it.each(["denied","expired-grant","throw","missing"])("rejects %s before persisting any archive or resource",async(mode)=>{
    const {archive}=await exported(),options=transferOptions();
    options.authorizer=mode==="missing"?undefined:{async authorize(){if(mode==="throw")throw new Error("private failure");
      return mode==="denied"?{decision:"denied"}:{decision:"allowed",authorizationRef:"test",expiresAt:"2020-01-01T00:00:00Z"};}};
    const target=fixture(false,undefined,options);
    await expect(target.control.execute(transfer("import",archive))).rejects.toThrow();
    for(const table of ["context_package_archives","context_package_imports","context_package_transfers","package_context_content"])expect(count(target,table)).toBe(0);
  });
  it.each(["tampered","unknown","revoked","wrong-package","future","noncanonical-signature"])("rejects %s signer or envelope",async(mode)=>{
    const {archive}=await exported(),options=transferOptions();
    if(mode==="tampered")archive.entries[0]!.content+="tampered";
    if(mode==="unknown")options.authority=()=>undefined;
    if(mode==="revoked"){const authority=options.authority!("fixture")!;options.authority=()=>({...authority,revoked:true});}
    if(mode==="wrong-package"){const authority=options.authority!("fixture")!;options.authority=()=>({...authority,packageIds:["other"]});}
    if(mode==="future"){const {signature,...payload}=archive;Object.assign(archive,signContextPackageArchive({...payload,issuedAt:"2090-01-01T00:00:00Z"},archivePrivateKey));}
    if(mode==="noncanonical-signature")archive.signature+="\n";
    const target=fixture(false,undefined,options);await expect(target.control.execute(transfer("import",archive))).rejects.toThrow();
    expect(count(target,"package_context_content")).toBe(0);
  });
  it.each(["missing-entry","duplicate-entry","changed-contract","path-field","wrong-content"])("rejects a valid signature over %s",async(mode)=>{
    const {archive}=await exported();const {signature,...payload}=archive;
    if(mode==="missing-entry")payload.entries.pop();
    if(mode==="duplicate-entry")payload.entries[1]=payload.entries[0]!;
    if(mode==="changed-contract")(payload.entries[0]!.descriptor as any).context.authorizationAction="other";
    if(mode==="path-field")(payload.entries[0]!.descriptor as any).locator="/private/host-secret";
    if(mode==="wrong-content")payload.entries[0]!.content="unrelated";
    const target=fixture(false);await expect(target.control.execute(transfer("import",signContextPackageArchive(payload,archivePrivateKey)))).rejects.toThrow();
    expect(count(target,"context_package_archives")).toBe(0);
  });
  it("rejects missing reviewed packages, altered manifest revisions and unsupported assets",async()=>{
    const {archive}=await exported(),target=fixture(false);
    const empty=new ContextPackageArchiveControl(target.sqlite,new ScenarioPackageRegistry(),target.store,transferOptions());
    await expect(empty.execute(transfer("import",archive))).rejects.toThrow("reviewed Package");
    target.pkg.resourceManifest!.revision++;
    await expect(target.control.execute(transfer("import",archive))).rejects.toThrow("manifest mismatch");
    target.pkg.resourceManifest!.revision--;delete target.pkg.resourceManifest!.resources[1]!.context;
    await expect(target.control.execute(transfer("import",archive))).rejects.toThrow("context-only");
  });
  it.each(["revoked","retired","expired"])("never resurrects %s resources through import or replay",async(mode)=>{
    const {archive}=await exported(),target=fixture(false),resource=target.pkg.resourceManifest!.resources[0]!;
    await target.control.execute(transfer("import",archive));
    if(mode==="revoked")target.store.revoke(resource.digest,"withdrawn");
    if(mode==="retired")target.sqlite.prepare("INSERT INTO package_context_retired VALUES (?,?)").run(JSON.stringify(["neutral","1.0.0",1]),resource.id);
    if(mode==="expired")resource.context!.expiresAt="2020-01-01T00:00:00Z";
    await expect(target.control.execute(transfer("import",archive))).rejects.toThrow();
    await expect(target.control.execute(transfer("export"))).rejects.toThrow();
    expect(count(target,"context_package_transfers")).toBe(1);
  });
  it("checks signer trust on reads, replays and disk reopen, while preserving forensic audit metadata",async()=>{
    const {archive}=await exported(),root=mkdtempSync(join(tmpdir(),"traceforge-context-transfer-"));cleanup.push(()=>rmSync(root,{recursive:true,force:true}));
    const path=join(root,"state.db"),target=fixture(false,database(path));await target.control.execute(transfer("import",archive));target.sqlite.close();
    const options=transferOptions(),authority=options.authority!("fixture")!;options.authority=()=>authority;
    const restored=fixture(false,database(path),options);expect(restored.store.read(contextBinding,restored.pkg.resourceManifest!.resources[0]!)).toBe(contextText);
    authority.revoked=true;expect(()=>restored.store.read(contextBinding,restored.pkg.resourceManifest!.resources[0]!)).toThrow("currently trusted");
    await expect(restored.control.execute(transfer("import",archive))).rejects.toThrow();
    restored.sqlite.pragma("query_only=ON");
    const audit=await restored.control.execute({action:"inspect",commandId:"read",targetCommandId:"import",actor:"operator",reason:"Audit",package:contextBinding});
    expect(audit.audit).toMatchObject({commandId:"import",action:"import",authorizationRef:"test-only-transfer"});
    expect(JSON.stringify(audit)).not.toContain(contextText);
  });
  it("rolls back the entire publication if the final audit write fails, then safely retries",async()=>{
    const {archive}=await exported(),target=fixture(false);
    target.sqlite.exec("CREATE TRIGGER refuse_transfer BEFORE INSERT ON context_package_transfers BEGIN SELECT RAISE(ABORT,'injected'); END");
    await expect(target.control.execute(transfer("import",archive))).rejects.toThrow("injected");
    for(const table of ["context_package_archives","context_package_imports","package_context_content"])expect(count(target,table)).toBe(0);
    target.sqlite.exec("DROP TRIGGER refuse_transfer");await target.control.execute(transfer("import",archive));
    expect(()=>target.sqlite.exec("DELETE FROM context_package_imports")).toThrow("permanent");
    expect(()=>target.sqlite.exec("UPDATE context_package_archives SET envelope_json='{}'")).toThrow("immutable");
  });
  it("handles concurrent identical commands, rejects conflicting commands and re-signed versions",async()=>{
    const {archive}=await exported(),target=fixture(false),request=transfer("import",archive);
    const results=await Promise.all([target.control.execute(request),target.control.execute(request)]);
    expect(results.map(r=>r.replayed).sort()).toEqual([false,true]);
    await expect(target.control.execute({...request,reason:"different"})).rejects.toThrow("conflict");
    const {signature,...payload}=archive;
    const other=signContextPackageArchive({...payload,issuedAt:new Date(Date.parse(payload.issuedAt)-1000).toISOString()},archivePrivateKey);
    await expect(target.control.execute(transfer("import",other,"second"))).rejects.toThrow("different signed archive");
  });
  it("migrates external MCP declarations without cached content or launching a server",async()=>{
    const pkg=archivePackage(),resource=pkg.resourceManifest!.resources[1]!;
    resource.context!.external={source:"neutral.remote",profileDigest:`sha256:${"a".repeat(64)}`,kind:"resource",target:"resource:neutral"};
    const options=transferOptions();let checks=0;options.hasExternalProfile=()=>{checks++;return true;};
    const source=fixture(true,undefined,options,pkg),archive=(await source.control.execute(transfer("export"))).archive!;
    expect(archive.entries[1]!.content).toBeNull();
    const target=fixture(false,undefined,options,archivePackage());target.pkg.resourceManifest!.resources[1]!.context!.external=resource.context!.external;
    options.hasExternalProfile=()=>false;await expect(target.control.execute(transfer("import",archive))).rejects.toThrow("dependency missing");
    options.hasExternalProfile=()=>true;await target.control.execute(transfer("import",archive));
    expect(count(target,"package_context_content")).toBe(1);expect(checks).toBeGreaterThan(0);
  });
  it("bounds oversized and deeply nested input before calling authorization",async()=>{
    const options=transferOptions(),authorize=vi.spyOn(options.authorizer!,"authorize"),target=fixture(false,undefined,options);
    await expect(target.control.execute(transfer("import",{text:"a".repeat(1048576)}))).rejects.toThrow("byte bound");
    let nested:unknown={};for(let i=0;i<34;i++)nested={nested};
    await expect(target.control.execute(transfer("import",nested))).rejects.toThrow("structure");expect(authorize).not.toHaveBeenCalled();
  });
  it("bounds non-cooperative authorization and ignores a late grant",async()=>{
    const {archive}=await exported(),options=transferOptions();let release!:(value:any)=>void;
    options.authorizer={authorize:()=>new Promise(resolve=>{release=resolve;})};const target=fixture(false,undefined,options);
    vi.useFakeTimers();
    try{
      const pending=expect(target.control.execute(transfer("import",archive))).rejects.toThrow("deadline");
      await vi.advanceTimersByTimeAsync(10001);await pending;
      release({decision:"allowed",authorizationRef:"late",expiresAt:"2099-01-01T00:00:00Z"});await Promise.resolve();
      expect(count(target,"context_package_transfers")).toBe(0);
    }finally{vi.useRealTimers();}
  });
  it("pins the authorized archive even if the caller mutates its request while awaiting a grant",async()=>{
    const {archive}=await exported(),options=transferOptions();let release!:(value:any)=>void,authorizedDigest:string|null=null;
    options.authorizer={authorize(request){authorizedDigest=request.archiveDigest;return new Promise(resolve=>{release=resolve;});}};
    const target=fixture(false,undefined,options),request=transfer("import",archive),pending=target.control.execute(request);
    archive.entries[0]!.content="changed during authorization";request.reason="changed reason";
    release({decision:"allowed",authorizationRef:"pinned grant",expiresAt:"2099-01-01T00:00:00Z"});
    const result=await pending;expect(result.archiveDigest).toBe(authorizedDigest);
    expect(target.store.read(contextBinding,target.pkg.resourceManifest!.resources[0]!)).toBe(contextText);
    expect(target.sqlite.prepare("SELECT reason FROM context_package_transfers").get()).toEqual({reason:"Move reviewed context"});
  });
  it.each(["authority","grant"])("rolls back if %s expires during publication",async(mode)=>{
    const {archive}=await exported(),options=transferOptions(),authority=options.authority!("fixture")!;
    options.authority=()=>authority;const grant={decision:"allowed" as const,authorizationRef:"test",expiresAt:"2099-01-01T00:00:00Z"};options.authorizer={async authorize(){return grant;}};
    const target=fixture(false,undefined,options);target.sqlite.function("expire_transfer",()=>{if(mode==="authority")authority.revoked=true;else grant.expiresAt="2020-01-01T00:00:00Z";return 1;});
    target.sqlite.exec("CREATE TEMP TRIGGER expire_transfer AFTER INSERT ON context_package_transfers BEGIN SELECT expire_transfer(); END");
    await expect(target.control.execute(transfer("import",archive))).rejects.toThrow();
    expect(count(target,"package_context_content")).toBe(0);expect(count(target,"context_package_imports")).toBe(0);
  });
  it("refuses storage pressure without publishing a partial package",async()=>{
    const {archive}=await exported(),root=mkdtempSync(join(tmpdir(),"traceforge-resource-pressure-"));cleanup.push(()=>rmSync(root,{recursive:true,force:true}));
    const target=fixture(false,database(join(root,"state.db")));
    target.sqlite.prepare("UPDATE execution_physical_policy SET maximum_database_bytes=1 WHERE id=1").run();
    await expect(target.control.execute(transfer("import",archive))).rejects.toThrow();
    expect(count(target,"package_context_content")).toBe(0);expect(count(target,"context_package_archives")).toBe(0);
  });
  it("does not conceal deleted content on command replay",async()=>{
    const {archive}=await exported(),target=fixture(false);await target.control.execute(transfer("import",archive));
    target.sqlite.exec("DELETE FROM package_context_content WHERE resource_id='second'");
    await expect(target.control.execute(transfer("import",archive))).rejects.toThrow("unavailable or corrupt");
  });
  it("keeps production transfer disabled by default and rejects oversized HTTP payloads",async()=>{
    const {archive}=await exported();const h=await foundationHost({empty:true,ready:()=>false});cleanup.push(()=>h.close());
    const denied=await h.app.inject({method:"POST",url:"/api/scenarios/context-packages/transfer",headers:h.management.headers(),payload:transfer("import",archive)});
    expect(denied.statusCode).toBe(409);expect(denied.body).not.toContain(contextText);
    const large=await h.app.inject({method:"POST",url:"/api/scenarios/context-packages/transfer",headers:h.management.headers(),payload:transfer("import",{text:"a".repeat(1048576)})});
    expect(large.statusCode).toBe(413);expect((h.sqlite.prepare("SELECT count(*) AS n FROM context_package_archives").get() as any).n).toBe(0);
  });
  it("imports through the production HTTP host and reads the text through the Worker without changing its Package",async()=>{
    const {archive}=await exported();let turns=0;
    const h=await foundationHost({foundation:{scenarioPackageRegistry:new ScenarioPackageRegistry([archivePackage()]),toolDiscoverySources:[],contextPackageTransfer:transferOptions()},
      model:async(args)=>{turns++;if(turns===1)return {type:"invoke_tool",invocation:{id:"read",tool:"context.read",input:{id:"first",digest:(archive.entries[0]!.descriptor as any).digest},rationale:"Read imported Skill"}};
        expect(args.user).toContain(contextText);return {type:"complete",summary:"Imported context read",outputs:[]};}});cleanup.push(()=>h.close());
    await h.request("/api/scenarios/context-packages/transfer",transfer("import",archive));await h.start();
    await eventually(async()=>(await h.state()).workItems[0]?.status==="completed");
    expect((await h.state()).scenarioPackage).toEqual(contextBinding);expect(turns).toBe(2);expect(h.calls()).toBe(0);
  });
  it("withdraws imported text from the next model input after its signer is revoked, retaining the original receipt",async()=>{
    const {archive}=await exported(),options=transferOptions(),authority=options.authority!("fixture")!;options.authority=()=>authority;
    let turns=0;
    const h=await foundationHost({foundation:{scenarioPackageRegistry:new ScenarioPackageRegistry([archivePackage()]),toolDiscoverySources:[],contextPackageTransfer:options},
      model:async(args)=>{turns++;if(turns===1)return {type:"invoke_tool",invocation:{id:"read",tool:"context.read",input:{id:"first",digest:(archive.entries[0]!.descriptor as any).digest},rationale:"Read"}};
        expect(args.user).not.toContain(contextText);return {type:"complete",summary:"Withdrawn context omitted",outputs:[]};}});cleanup.push(()=>h.close());
    await h.request("/api/scenarios/context-packages/transfer",transfer("import",archive));
    h.sqlite.function("revoke_import_signer",()=>{authority.revoked=true;return 1;});
    h.sqlite.exec("CREATE TEMP TRIGGER revoke_import_signer AFTER INSERT ON worker_tool_receipts BEGIN SELECT revoke_import_signer(); END");
    await h.start();await eventually(async()=>(await h.state()).workItems[0]?.status==="completed");
    expect(turns).toBe(2);
    expect(JSON.stringify(h.sqlite.prepare("SELECT result_json FROM worker_tool_receipts").all())).toContain(contextText);
  });
});
