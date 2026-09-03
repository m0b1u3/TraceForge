import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson } from "@traceforge/orchestration-core";
import { parseScenarioPackageDescriptor } from "@traceforge/scenario-sdk";
import { buildServer } from "./main.js";
import { foundationHostControl } from "./foundation-host-control.js";
import { scenarioMaterialDigest, scenarioPackageContractDigest, signScenarioPackageReview, type ScenarioMaterialManifest } from "./scenario-package-trust.js";

const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const digest=(bytes:Buffer)=>`sha256:${createHash("sha256").update(bytes).digest("hex")}` as const;

describe("application Scenario package assembly",()=>{
  it("loads the reviewed Web package from deployment configuration without a compiled package import",async()=>{
    const root=realpathSync(mkdtempSync(join(tmpdir(),"traceforge-main-scenario-")));roots.push(root);
    const packageRoot=join(root,"package"),configRoot=join(root,"config");mkdirSync(join(packageRoot,"runtime"),{recursive:true});
    mkdirSync(join(packageRoot,"skills"));mkdirSync(join(packageRoot,"knowledge"));mkdirSync(configRoot);
    const sourceRoot=join(process.cwd(),"scenarios/web-blackbox");
    const paths=["scenario.json","runtime/main.mjs","skills/http-observation.md","knowledge/verification-criteria.md"];
    for(const path of paths)writeFileSync(join(packageRoot,path),readFileSync(join(sourceRoot,path)));
    const descriptorBody=readFileSync(join(packageRoot,"scenario.json")),descriptor=parseScenarioPackageDescriptor(JSON.parse(descriptorBody.toString("utf8")));
    const manifest:ScenarioMaterialManifest={format:"traceforge.scenario-material.v1",package:{id:descriptor.id,version:descriptor.version,schemaRevision:descriptor.schemaRevision},
      entry:"runtime/main.mjs",files:paths.map(path=>{const bytes=readFileSync(join(packageRoot,path));return {path,role:path==="runtime/main.mjs"?"entry" as const:"data" as const,size:bytes.length,digest:digest(bytes)};})};
    const keys=generateKeyPairSync("ed25519"),privateKey=keys.privateKey.export({type:"pkcs8",format:"pem"}).toString(),publicKey=keys.publicKey.export({type:"spki",format:"pem"}).toString();
    const review=signScenarioPackageReview({format:"traceforge.scenario-review.v1",package:manifest.package,materialDigest:scenarioMaterialDigest(manifest),
      contractDigest:scenarioPackageContractDigest(descriptor),assemblyRef:"integration",keyId:"integration-reviewer",reviewRef:"integration-review",
      issuedAt:"2026-01-01T00:00:00.000Z",expiresAt:"2098-01-01T00:00:00.000Z"},privateKey);
    const platform=process.platform==="win32"?"windows":process.platform==="darwin"?"darwin":"linux";
    writeFileSync(join(configRoot,"scenarios.json"),canonicalJson({format:"traceforge.scenario-host.v1",
      installations:[{root:"../package",manifest,review}],authorities:[{keyId:"integration-reviewer",publicKeyPem:publicKey,
        packageIds:[descriptor.id],validFrom:"2025-01-01T00:00:00.000Z",validUntil:"2099-01-01T00:00:00.000Z"}],
      launches:[{source:descriptor.runtime!.source,executable:"@host/node",arguments:["@config/../package/runtime/main.mjs"],workingDirectory:"../package",
        attribution:{caseId:"foundation",runId:"scenario-services",workId:descriptor.id,workerId:"scenario-host",scopeRef:"host-scope",leaseId:"host-lease",
          leaseExpiresAt:"2098-01-01T00:00:00.000Z",actionId:"scenario.start",idempotencyKey:`scenario:${descriptor.id}`},
        permissions:{version:1,platform,filesystem:{read:[{path:packageRoot,scope:"tree"}],write:[],deny:[]},network:"deny",
          process:{access:"sandboxed",interactive:false,background:false},secrets:"deny",sources:[descriptor.runtime!.source]},
        resources:{cpuTimeMs:60000,memoryBytes:268435456,maximumProcesses:2,writeBytes:1048576}}]}));
    const app=await buildServer(":memory:",join(root,"missing-mcp.json"),join(root,"missing-llm.json"),root);
    try{const headers=foundationHostControl(app).management().headers();
      expect((await app.inject({url:"/api/scenarios/definitions",headers})).json()).toEqual(expect.arrayContaining([expect.objectContaining({kind:"web_blackbox",version:1})]));
      expect((await app.inject({url:"/api/scenarios/package-trust",headers})).json()).toMatchObject({dataDescriptorLoading:true,
        packages:[{package:{id:"traceforge.web-blackbox",version:"0.3.0"},status:"reviewed_available"}]});
      expect((await app.inject({url:"/api/execution/identities?caseId=missing",headers})).json()).toEqual([]);
    }finally{await app.close();}
  });
});
