import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadScenarioHostConfiguration } from "./scenario-host-configuration.js";

const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function root(){const value=mkdtempSync(join(tmpdir(),"traceforge-scenario-host-"));roots.push(value);return value;}
function config(overrides:Record<string,unknown>={}){
  return {format:"traceforge.scenario-host.v1",installations:[{root:"../package",manifest:{marker:"manifest"},review:{marker:"review"}}],
    authorities:[{keyId:"reviewer",publicKeyPem:"public-key",packageIds:["neutral"],validFrom:"2026-01-01T00:00:00.000Z",validUntil:"2099-01-01T00:00:00.000Z"}],
    launches:[{source:"scenario:neutral",executable:"@host/node",arguments:["@config/../package/runtime/main.mjs"],workingDirectory:"../package",
      attribution:{caseId:"foundation",runId:"scenario-services",workId:"neutral",workerId:"scenario-host",scopeRef:"host-scope",leaseId:"host-lease",
        leaseExpiresAt:"2099-01-01T00:00:00.000Z",actionId:"scenario.start",idempotencyKey:"scenario:neutral"},
      permissions:{version:1,platform:process.platform==="win32"?"windows":process.platform==="darwin"?"darwin":"linux",
        filesystem:{read:[],write:[],deny:[]},network:"deny",process:{access:"sandboxed",interactive:false,background:false},secrets:"deny",sources:["scenario:neutral"]},
      resources:{cpuTimeMs:60000,memoryBytes:268435456,maximumProcesses:2,writeBytes:1048576}}],...overrides};
}

describe("Scenario Host deployment configuration",()=>{
  it("defaults to no installed scenarios when the deployment file is absent",()=>{
    expect(loadScenarioHostConfiguration(join(root(),"config/scenarios.json"))).toEqual({trust:{installations:[]},launches:{}});
  });
  it("resolves reviewed package and launch paths without importing package code",()=>{
    const base=root(),directory=join(base,"config");mkdirSync(directory);const path=join(directory,"scenarios.json");writeFileSync(path,JSON.stringify(config()));
    const loaded=loadScenarioHostConfiguration(path);
    expect(loaded.trust.installations?.[0]).toMatchObject({root:resolve(base,"package"),manifest:{marker:"manifest"},review:{marker:"review"}});
    expect(loaded.trust.authority?.("reviewer")).toMatchObject({packageIds:["neutral"]});
    expect(loaded.launches["scenario:neutral"]).toMatchObject({executable:process.execPath,workingDirectory:resolve(base,"package"),
      arguments:[resolve(base,"package/runtime/main.mjs")]});
  });
  it("rejects duplicate authorities, duplicate launches, and unknown fields",()=>{
    const base=root(),path=join(base,"scenarios.json"),write=(value:unknown)=>writeFileSync(path,JSON.stringify(value));
    const authority=(config().authorities as unknown[])[0];write(config({authorities:[authority,authority]}));
    expect(()=>loadScenarioHostConfiguration(path)).toThrow(/Duplicate Scenario review authority/);
    const launch=(config().launches as unknown[])[0];write(config({launches:[launch,launch]}));
    expect(()=>loadScenarioHostConfiguration(path)).toThrow(/Duplicate Scenario Process launch profile/);
    write({...config(),unexpected:true});expect(()=>loadScenarioHostConfiguration(path)).toThrow();
  });
});
