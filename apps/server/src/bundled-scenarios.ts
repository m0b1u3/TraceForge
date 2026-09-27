import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {parseScenarioPackageDescriptor,ScenarioPackageRegistry} from "@traceforge/scenario-sdk";
import type {ScenarioPackageBinding} from "@traceforge/orchestration-core";
import type {ScenarioProcessLaunch} from "@traceforge/worker-runtime";
import type {PackageContextContent} from "./package-context-resources.js";

export interface BundledScenarioConfiguration {
  registry:ScenarioPackageRegistry;
  binding:ScenarioPackageBinding;
  context:readonly PackageContextContent[];
  launches:Readonly<Record<string,ScenarioProcessLaunch>>;
}

/** The path is fixed by the desktop application, never chosen by a model or web page. */
export function loadBundledScenarios(directory:string,helperPath:string):BundledScenarioConfiguration {
  const packageRoot=join(directory,"web-blackbox");
  const descriptor=parseScenarioPackageDescriptor(JSON.parse(readFileSync(join(packageRoot,"scenario.json"),"utf8")));
  const registry=new ScenarioPackageRegistry([descriptor]),binding=registry.bindingFor(descriptor);
  const context:PackageContextContent[]=[];
  for(const resource of descriptor.resourceManifest?.resources??[]){
    if(!resource.context||resource.context.external)continue;
    context.push({package:binding,resourceId:resource.id,
      content:readFileSync(join(packageRoot,resource.locator.slice("package://".length)),"utf8")});
  }
  const executable=join(directory,process.platform==="win32"?"node.exe":"node");
  const measurement=createHash("sha256").update(readFileSync(helperPath)).digest("hex");
  const runtime=descriptor.runtime!;
  const launch:ScenarioProcessLaunch={executable,arguments:[join(packageRoot,runtime.entrypoint.slice("package://".length))],workingDirectory:packageRoot,
    attribution:{caseId:"foundation",runId:"scenario-services",workId:descriptor.id,workerId:"scenario-host",scopeRef:"host-scope",leaseId:"host-lease",leaseExpiresAt:"2098-01-01T00:00:00.000Z",actionId:"scenario.start",idempotencyKey:`scenario:${descriptor.id}:${descriptor.version}`},
    permissions:{version:1,platform:"darwin",filesystem:{read:[{path:packageRoot,scope:"tree"},{path:executable,scope:"exact"}],write:[],deny:[]},network:"deny",process:{access:"sandboxed",interactive:false,background:false},secrets:"deny",sources:[runtime.source]},
    expectedSandboxBackend:"traceforge-macos-native",expectedBackendMeasurement:measurement,acceptedResourcePolicy:"sampled_terminate",
    resources:{cpuTimeMs:60000,memoryBytes:268435456,maximumProcesses:2,writeBytes:1048576}};
  return {registry,binding,context,launches:{[runtime.source]:launch}};
}
