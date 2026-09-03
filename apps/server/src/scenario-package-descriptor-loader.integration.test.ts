import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson } from "@traceforge/orchestration-core";
import { parseScenarioPackageDescriptor, SCENARIO_PROCESS_PROTOCOL, type ScenarioPackageDescriptorV1 } from "@traceforge/scenario-sdk";
import { definition, database } from "./test-fixtures/execution-recovery.js";
import { foundationHost } from "./test-fixtures/foundation-host.js";
import { SqlitePackageContextStore } from "./package-context-resources.js";
import { loadScenarioPackageDescriptors, readScenarioPackageDescriptorResources } from "./scenario-package-descriptor-loader.js";
import { scenarioMaterialDigest, scenarioPackageContractDigest, ScenarioPackageTrustControl, signScenarioPackageReview,
  type ScenarioMaterialManifest, type ScenarioReviewedInstallation } from "./scenario-package-trust.js";

const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function digest(value:string|Buffer){return `sha256:${createHash("sha256").update(value).digest("hex")}` as const;}
function fixture(configure?:(descriptor:ScenarioPackageDescriptorV1,addResource:(path:string,content:string)=>void)=>void){
  const root=mkdtempSync(join(tmpdir(),"traceforge-descriptor-"));roots.push(root);mkdirSync(join(root,"runtime"));
  const resources=new Map<string,string>();
  const descriptor:ScenarioPackageDescriptorV1={format:"traceforge.scenario-package.v1",package:{id:"neutral",version:"1.0.0",schemaRevision:1},
    definition:structuredClone(definition),authorizationPolicy:{format:"traceforge.scenario-scope-policy.v1",allowedActions:["observe"],deniedActions:[],payload:{maximumBytes:1024,maximumDepth:4},resources:[]},
    outputContracts:[{kind:"decision",version:1,format:"traceforge.scenario-output-contract.v1",maximumSummaryBytes:1024,maximumRefs:8}],
    runtime:{protocol:SCENARIO_PROCESS_PROTOCOL,protocolVersion:1,id:"neutral",version:"1.0.0",source:"scenario:neutral",entrypoint:"package://runtime/main.mjs",providedCapabilities:["observe"],hostCapabilities:[]}};
  configure?.(descriptor,(path,content)=>resources.set(path,content));const descriptorBody=canonicalJson(descriptor),runtimeBody="export const packageRuntime = true;\n";
  writeFileSync(join(root,"scenario.json"),descriptorBody);writeFileSync(join(root,"runtime/main.mjs"),runtimeBody);
  for(const [path,content] of resources){mkdirSync(dirname(join(root,path)),{recursive:true});writeFileSync(join(root,path),content);}
  const manifest:ScenarioMaterialManifest={format:"traceforge.scenario-material.v1",package:descriptor.package,entry:"runtime/main.mjs",files:[
    {path:"scenario.json",role:"data",size:Buffer.byteLength(descriptorBody),digest:digest(descriptorBody)},
    {path:"runtime/main.mjs",role:"entry",size:Buffer.byteLength(runtimeBody),digest:digest(runtimeBody)},
    ...[...resources].map(([path,content])=>({path,role:"data" as const,size:Buffer.byteLength(content),digest:digest(content)}))]};
  const keys=generateKeyPairSync("ed25519"),privateKey=keys.privateKey.export({type:"pkcs8",format:"pem"}).toString();
  const installation={root:realpathSync(root),manifest,review:null as never} satisfies ScenarioReviewedInstallation;
  const pkg=parseScenarioPackageDescriptor(JSON.parse(descriptorBody)),review=signScenarioPackageReview({format:"traceforge.scenario-review.v1",package:manifest.package,
    materialDigest:scenarioMaterialDigest(manifest),contractDigest:scenarioPackageContractDigest(pkg),assemblyRef:"descriptor",keyId:"key",reviewRef:"review",
    issuedAt:"2026-01-02T00:00:00.000Z",expiresAt:"2098-01-01T00:00:00.000Z"},privateKey);
  const reviewed:{root:string;manifest:ScenarioMaterialManifest;review:typeof review}={...installation,review};
  // Reload against the final signed envelope so the origin proof is bound to exactly what Trust receives.
  return {root,descriptor,keys,reviewed,registry:loadScenarioPackageDescriptors([reviewed])};
}

describe("reviewed data-only Scenario Package loading",()=>{
  it("constructs and trusts an immutable Package without a host-written assembly callback",()=>{
    const f=fixture(),sqlite=database();
    try{const control=new ScenarioPackageTrustControl(sqlite,f.registry,{installations:[f.reviewed],authority:key=>key==="key"?{
      publicKeyPem:f.keys.publicKey.export({type:"spki",format:"pem"}).toString(),packageIds:["neutral"],validFrom:"2026-01-01T00:00:00.000Z",validUntil:"2099-01-01T00:00:00.000Z"}:undefined});
      expect(control.snapshot()).toMatchObject({dataDescriptorLoading:true,packages:[{status:"reviewed_available"}]});
      const pkg=control.registry.requireForScenario("neutral");expect(pkg).toMatchObject({id:"neutral"});expect(Object.hasOwn(pkg,"createToolSources")).toBe(false);
    }finally{sqlite.close();}
  });
  it("rejects descriptor replacement before trust or process assembly",()=>{
    const f=fixture();writeFileSync(join(f.root,"scenario.json"),readFileSync(join(f.root,"scenario.json"),"utf8").replace("Neutral","Changed"));
    expect(()=>loadScenarioPackageDescriptors([f.reviewed])).toThrow(/does not match|digest/);
  });
  it("rejects a descriptor symlink before parsing",()=>{
    const f=fixture(),body=readFileSync(join(f.root,"scenario.json"));writeFileSync(join(f.root,"other.json"),body);
    unlinkSync(join(f.root,"scenario.json"));symlinkSync(join(f.root,"other.json"),join(f.root,"scenario.json"));
    expect(()=>loadScenarioPackageDescriptors([f.reviewed])).toThrow(/does not match/);
  });
  it("rejects signed descriptor bytes that are not strict UTF-8",()=>{
    const f=fixture(),body=readFileSync(join(f.root,"scenario.json")),offset=body.indexOf(Buffer.from("Neutral"));
    body[offset]=0xff;writeFileSync(join(f.root,"scenario.json"),body);
    const entry=f.reviewed.manifest.files.find(file=>file.path==="scenario.json")!;entry.digest=digest(body);
    const {signature,...payload}=f.reviewed.review;void signature;
    f.reviewed.review=signScenarioPackageReview({...payload,materialDigest:scenarioMaterialDigest(f.reviewed.manifest)},
      f.keys.privateKey.export({type:"pkcs8",format:"pem"}).toString());
    expect(()=>loadScenarioPackageDescriptors([f.reviewed])).toThrow(/UTF-8/);
  });
  it("rejects runtime paths that are not the single reviewed entry",()=>{
    expect(()=>fixture(value=>{value.runtime.entrypoint="package://runtime/other.mjs";})).toThrow(/reviewed entry/);
  });
  it("rejects descriptor and reviewed Package identity mismatch",()=>{
    const f=fixture();f.reviewed.manifest.package={...f.reviewed.manifest.package,version:"2.0.0"};
    expect(()=>loadScenarioPackageDescriptors([f.reviewed])).toThrow(/identity/);
  });
  it("does not let a local Skill or Knowledge reference undeclared material",()=>{
    expect(()=>fixture(value=>{value.resourceManifest={revision:1,resources:[{id:"fixture.notes",kind:"knowledge",version:1,
      locator:"package://knowledge/notes.json",digest:`sha256:${"1".repeat(64)}`,context:{type:"knowledge",summary:"Notes",
        authorizationAction:"observe",requiredCapabilities:[],phaseIds:[],references:[]}}]};})).toThrow(/reviewed data material/);
  });
  it("loads reviewed local context text into the existing store without duplicate host content configuration",()=>{
    const content="Neutral reviewed knowledge";
    const f=fixture((value,add)=>{add("knowledge/notes.txt",content);value.resourceManifest={revision:1,resources:[{id:"fixture.notes",kind:"knowledge",version:1,
      locator:"package://knowledge/notes.txt",digest:digest(content),context:{type:"knowledge",summary:"Notes",authorizationAction:"observe",
        requiredCapabilities:[],phaseIds:[],references:[]}}]};});
    const sqlite=database();try{const resources=readScenarioPackageDescriptorResources(f.registry),store=new SqlitePackageContextStore(sqlite);
      expect(resources.context).toHaveLength(1);store.install(f.registry,resources.context);
      expect(sqlite.prepare("SELECT content FROM package_context_content WHERE resource_id='fixture.notes'").get()).toEqual({content});
    }finally{sqlite.close();}
  });
  it("loads a reviewed migration declaration without duplicate host content configuration",()=>{
    const from={id:"neutral",version:"0.9.0",schemaRevision:1},to={id:"neutral",version:"1.0.0",schemaRevision:2};
    const content=canonicalJson({format:"traceforge.run-migration.v1",mode:"preserve_state",from,to});
    const f=fixture((value,add)=>{value.package.schemaRevision=2;add("migrations/preserve.json",content);
      value.resourceManifest={revision:1,resources:[{id:"preserve",kind:"migration",version:1,
        locator:"package://migrations/preserve.json",digest:digest(content)}]};
      value.migrationManifest={revision:1,steps:[{id:"preserve",fromSchemaRevision:1,toSchemaRevision:2,resourceId:"preserve"}]};});
    expect(readScenarioPackageDescriptorResources(f.registry).migrations).toEqual([{package:to,resourceId:"preserve",content}]);
  });
  it("rejects a reviewed local resource changed after descriptor loading",()=>{
    const content="first reviewed text";
    const f=fixture((value,add)=>{add("knowledge/notes.txt",content);value.resourceManifest={revision:1,resources:[{id:"fixture.notes",kind:"knowledge",version:1,
      locator:"package://knowledge/notes.txt",digest:digest(content),context:{type:"knowledge",summary:"Notes",authorizationAction:"observe",
        requiredCapabilities:[],phaseIds:[],references:[]}}]};});
    writeFileSync(join(f.root,"knowledge/notes.txt"),"other reviewed text");
    expect(()=>readScenarioPackageDescriptorResources(f.registry)).toThrow(/digest mismatch/);
  });
  it("rejects unsafe material paths before descriptor parsing",()=>{
    const f=fixture();f.reviewed.manifest.files[0]!.path="../scenario.json";
    expect(()=>loadScenarioPackageDescriptors([f.reviewed])).toThrow(/material manifest is invalid/);
  });
  it("wires descriptor loading into Foundation while keeping unavailable material quarantined",async()=>{
    const f=fixture(),host=await foundationHost({empty:true,foundation:{scenarioPackageRegistry:undefined,loadScenarioPackageDescriptors:true,
      allowLegacyScenarioContractDevelopment:false,allowInProcessScenarioDevelopment:false,toolDiscoverySources:[],scenarioPackageTrust:{installations:[f.reviewed],
        authority:key=>key==="key"?{publicKeyPem:f.keys.publicKey.export({type:"spki",format:"pem"}).toString(),packageIds:["neutral"],
          validFrom:"2026-01-01T00:00:00.000Z",validUntil:"2099-01-01T00:00:00.000Z",revoked:true}:undefined}}});
    try{expect(await host.request("/api/scenarios/package-trust")).toMatchObject({dataDescriptorLoading:true,
      packages:[{status:"recovery_required"}]});}finally{await host.close();}
  });
});
