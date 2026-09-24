import {createHash} from "node:crypto";
import {readFileSync,realpathSync} from "node:fs";
import {join,relative,isAbsolute} from "node:path";
import {parseScenarioPackageDescriptor} from "@traceforge/scenario-sdk";
import {type ScenarioHostConfiguration} from "./scenario-host-configuration.js";
import {verifyMaterialFiles,type ScenarioReviewedInstallation,type ScenarioReviewAuthority} from "./scenario-package-trust.js";

/** Called only with the application's fixed resource directory. No renderer or
 * model can nominate a directory to be trusted as a built-in. */
export function loadBundledScenarios(directory:string,helperPath:string):ScenarioHostConfiguration {
  const root=realpathSync(directory),hash=(bytes:Buffer)=>createHash("sha256").update(bytes).digest("hex");
  const inside=(path:string)=>{const full=realpathSync(join(root,path)),rel=relative(root,full);if(!rel||rel.startsWith("..")||isAbsolute(rel))throw new Error("Bundled material escapes application resources");return full;};
  const catalog=JSON.parse(readFileSync(join(root,"catalog.json"),"utf8"));
  if(catalog.version!==1||!Array.isArray(catalog.installations)||!catalog.installations.length)throw new Error("Invalid built-in Scenario catalog");
  const executable=inside(catalog.node.file);
  if(hash(readFileSync(executable))!==catalog.node.sha256)throw new Error("Bundled Node runtime changed");
  const measurement=hash(readFileSync(helperPath)),installations:ScenarioReviewedInstallation[]=[],authorities=new Map<string,ScenarioReviewAuthority>();
  const launches:Record<string,import("@traceforge/worker-runtime").ScenarioProcessLaunch>={};
  for(const item of catalog.installations){
    const packageRoot=inside(item.directory);verifyMaterialFiles(packageRoot,item.manifest);
    const descriptor=parseScenarioPackageDescriptor(JSON.parse(readFileSync(join(packageRoot,"scenario.json"),"utf8")));
    if(!descriptor.runtime||launches[descriptor.runtime.source])throw new Error("Invalid or duplicate built-in runtime");
    installations.push({root:packageRoot,manifest:item.manifest,review:item.review});authorities.set(item.review.keyId,item.authority);
    launches[descriptor.runtime.source]={executable,arguments:[join(packageRoot,item.manifest.entry)],workingDirectory:packageRoot,
      attribution:{caseId:"foundation",runId:"scenario-services",workId:descriptor.id,workerId:"scenario-host",scopeRef:"host-scope",leaseId:"host-lease",leaseExpiresAt:"2098-01-01T00:00:00.000Z",actionId:"scenario.start",idempotencyKey:`scenario:${descriptor.id}:${descriptor.version}`},
      permissions:{version:1,platform:"darwin",filesystem:{read:[{path:packageRoot,scope:"tree"},{path:executable,scope:"exact"}],write:[],deny:[]},network:"deny",process:{access:"sandboxed",interactive:false,background:false},secrets:"deny",sources:[descriptor.runtime.source]},
      expectedSandboxBackend:"traceforge-macos-native",expectedBackendMeasurement:measurement,acceptedResourcePolicy:"sampled_terminate",
      resources:{cpuTimeMs:60000,memoryBytes:268435456,maximumProcesses:2,writeBytes:1048576}};
  }
  return {trust:{installations,authority:key=>authorities.get(key)},launches};
}
