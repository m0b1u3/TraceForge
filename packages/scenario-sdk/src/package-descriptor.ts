import { ScenarioDefinitionRegistry, type ScenarioDefinition } from "@traceforge/orchestration-core";
import { validateScenarioProcessManifest } from "@traceforge/worker-runtime";
import { assertDeclarativeOutputContract, assertDeclarativeScopePolicy, type ScenarioOutputContractV1,
  type ScenarioScopePolicyV1 } from "./declarative-contracts.js";
import { validateSkillContract } from "./skill-contract.js";
import type { ScenarioPackageInstallation, ScenarioPackageMigrationManifest, ScenarioPackageResourceManifest } from "./index.js";

export interface ScenarioPackageDescriptorV1 {
  format: "traceforge.scenario-package.v1";
  package: { id: string; version: string; schemaRevision: number };
  definition: ScenarioDefinition;
  authorizationPolicy: ScenarioScopePolicyV1;
  outputContracts: readonly ScenarioOutputContractV1[];
  resourceManifest?: ScenarioPackageResourceManifest;
  migrationManifest?: ScenarioPackageMigrationManifest;
  runtime: NonNullable<ScenarioPackageInstallation["runtime"]>;
}

/** Parses data only. It never resolves paths, imports modules, starts a process, or grants trust. */
export function parseScenarioPackageDescriptor(input: unknown): ScenarioPackageInstallation {
  const value = jsonClone(input, 1024 * 1024, 32);
  object(value, "Scenario Package descriptor");
  exact(value, ["format","package","definition","authorizationPolicy","outputContracts","resourceManifest","migrationManifest","runtime"]);
  if (value.format !== "traceforge.scenario-package.v1") throw new Error("Unsupported Scenario Package descriptor format");
  object(value.package, "Scenario Package descriptor binding"); exact(value.package, ["id","version","schemaRevision"]);
  const binding = value.package as ScenarioPackageDescriptorV1["package"];
  boundedText(binding.id, 128, "Scenario Package id"); boundedText(binding.version, 128, "Scenario Package version");
  positive(binding.schemaRevision, 1_000_000, "Scenario Package schema revision");
  validateDefinition(value.definition);
  assertDeclarativeScopePolicy(value.authorizationPolicy as ScenarioScopePolicyV1);
  array(value.outputContracts, 256, "Scenario output contracts");
  for (const contract of value.outputContracts) assertDeclarativeOutputContract(contract as ScenarioOutputContractV1);
  if (value.resourceManifest !== undefined) validateResources(value.resourceManifest);
  if (value.migrationManifest !== undefined) validateMigrations(value.migrationManifest);
  validateRuntime(value.runtime, binding);
  const installation: ScenarioPackageInstallation = {
    id: binding.id, version: binding.version, schemaRevision: binding.schemaRevision,
    definition: value.definition as ScenarioDefinition,
    authorizationPolicy: value.authorizationPolicy as ScenarioScopePolicyV1,
    outputSchemas: value.outputContracts as ScenarioOutputContractV1[],
    ...(value.resourceManifest === undefined ? {} : { resourceManifest: value.resourceManifest as unknown as ScenarioPackageResourceManifest }),
    ...(value.migrationManifest === undefined ? {} : { migrationManifest: value.migrationManifest as unknown as ScenarioPackageMigrationManifest }),
    runtime: value.runtime as NonNullable<ScenarioPackageInstallation["runtime"]>,
  };
  new ScenarioDefinitionRegistry([installation.definition]);
  return deepFreeze(installation);
}

function validateDefinition(value: unknown): void {
  object(value, "Scenario Definition");
  exact(value,["kind","version","title","authorizationActions","requiredCapabilities","workKinds","initialPhaseId","agentTopology","phases"]);
  boundedText(value.kind,128,"Scenario kind");positive(value.version,1_000_000,"Scenario Definition version");boundedText(value.title,512,"Scenario title");
  strings(value.authorizationActions,256,128,"Scenario authorization actions");strings(value.requiredCapabilities,256,128,"Scenario required capabilities");
  boundedText(value.initialPhaseId,128,"Scenario initial phase");array(value.workKinds,256,"Scenario Work kinds");
  for(const item of value.workKinds){object(item,"Scenario Work kind");exact(item,["id","defaultWorkerRoles","maximumActiveItems","minimumHypothesisRefs","completion"]);
    boundedText(item.id,128,"Scenario Work kind id");strings(item.defaultWorkerRoles,64,128,"Scenario Worker roles");
    optionalPositive(item.maximumActiveItems,10_000,"maximumActiveItems");optionalNonnegative(item.minimumHypothesisRefs,10_000,"minimumHypothesisRefs");
    if(item.completion!==undefined){object(item.completion,"Scenario Work completion");exact(item.completion,["anyOfOutputKinds"]);strings(item.completion.anyOfOutputKinds,256,128,"completion outputs");}}
  object(value.agentTopology,"Scenario agent topology");exact(value.agentTopology,["planner","observer","workerPools"]);
  validateAgent(value.agentTopology.planner,true);validateAgent(value.agentTopology.observer,false);array(value.agentTopology.workerPools,256,"Scenario Worker pools");
  for(const pool of value.agentTopology.workerPools){object(pool,"Scenario Worker pool");exact(pool,["id","role","workKinds","activation","minimumInstances","maximumInstances","maxConcurrentWork","capabilities"]);
    boundedText(pool.id,128,"Worker pool id");boundedText(pool.role,128,"Worker pool role");strings(pool.workKinds,256,128,"Worker pool Work kinds");
    if(!["resident","on_demand"].includes(String(pool.activation)))throw new Error("Invalid Worker pool activation");
    nonnegative(pool.minimumInstances,1024,"minimumInstances");positive(pool.maximumInstances,1024,"maximumInstances");positive(pool.maxConcurrentWork,1024,"maxConcurrentWork");
    if((pool.minimumInstances as number)>(pool.maximumInstances as number))throw new Error("Worker pool minimum exceeds maximum");strings(pool.capabilities,256,128,"Worker pool capabilities");}
  array(value.phases,256,"Scenario phases");
  for(const phase of value.phases){object(phase,"Scenario phase");exact(phase,["id","title","objective","allowedWorkKinds","maxParallelWork","requiredCapabilities","transitions"]);
    boundedText(phase.id,128,"Phase id");boundedText(phase.title,512,"Phase title");boundedText(phase.objective,4096,"Phase objective");
    strings(phase.allowedWorkKinds,256,128,"Phase Work kinds");positive(phase.maxParallelWork,1024,"Phase parallelism");strings(phase.requiredCapabilities,256,128,"Phase capabilities");array(phase.transitions,256,"Phase transitions");
    for(const transition of phase.transitions){object(transition,"Scenario transition");exact(transition,["to","allOf","anyOf","noneOf","noOutstandingWorkKinds"]);boundedText(transition.to,128,"Transition target");
      for(const key of ["allOf","anyOf","noneOf"] as const)if(transition[key]!==undefined){array(transition[key],256,`Transition ${key}`);for(const predicate of transition[key]){object(predicate,"Output predicate");exact(predicate,["kind","minimum"]);boundedText(predicate.kind,128,"Output predicate kind");optionalPositive(predicate.minimum,10_000,"Output predicate minimum");}}
      if(transition.noOutstandingWorkKinds!==undefined)strings(transition.noOutstandingWorkKinds,256,128,"Transition outstanding Work kinds");}}
}
function validateAgent(value:unknown,planner:boolean):void{object(value,"Scenario agent policy");exact(value,planner?
  ["enabled","pollIntervalMs","maximumGraphNodes","maximumRecentEvents","maximumRunItems","maximumProposalsPerEvaluation"]:
  ["enabled","pollIntervalMs","maximumGraphNodes","maximumRecentEvents","maximumRunItems"]);
  if(typeof value.enabled!=="boolean")throw new Error("Scenario agent enabled must be boolean");
  for(const key of ["pollIntervalMs","maximumGraphNodes","maximumRecentEvents","maximumRunItems",...(planner?["maximumProposalsPerEvaluation"]:[])] as string[])positive(value[key],1_000_000,`Scenario agent ${key}`);}
function validateResources(value:unknown):void{object(value,"Scenario resource manifest");exact(value,["revision","resources"]);positive(value.revision,1_000_000,"Resource manifest revision");array(value.resources,1024,"Scenario resources");
  for(const resource of value.resources){object(resource,"Scenario resource");exact(resource,["id","kind","version","locator","digest","context"]);boundedText(resource.id,128,"Resource id");boundedText(resource.kind,128,"Resource kind");positive(resource.version,1_000_000,"Resource version");boundedText(resource.locator,1024,"Resource locator");sha(resource.digest,"Resource digest");
    if(resource.context!==undefined){const context=resource.context;object(context,"Scenario context resource");exact(context,["type","summary","authorizationAction","requiredCapabilities","phaseIds","references","validFrom","expiresAt","conflictsWith","readerRoles","skill","external"]);
      if(!["skill","knowledge"].includes(String(context.type)))throw new Error("Invalid context resource type");boundedText(context.summary,512,"Context summary");boundedText(context.authorizationAction,128,"Context authorization action");
      strings(context.requiredCapabilities,32,128,"Context capabilities");strings(context.phaseIds,32,128,"Context phases");strings(context.references,32,128,"Context references");if(context.conflictsWith!==undefined)strings(context.conflictsWith,32,128,"Context conflicts");
      if(context.readerRoles!==undefined){strings(context.readerRoles,3,16,"Context reader roles");if(context.readerRoles.some((role:unknown)=>!["worker","planner","observer"].includes(String(role))))throw new Error("Invalid context reader role");}
      for(const key of ["validFrom","expiresAt"] as const)if(context[key]!==undefined&&!Number.isFinite(Date.parse(String(context[key]))))throw new Error(`Invalid context ${key}`);
      if(context.skill!==undefined)validateSkillContract(context.skill as never);
      if(context.external!==undefined){object(context.external,"External context binding");exact(context.external,["source","profileDigest","kind","target","arguments"]);boundedText(context.external.source,128,"External context source");sha(context.external.profileDigest,"External profile digest");if(!["resource","prompt"].includes(String(context.external.kind)))throw new Error("Invalid external context kind");boundedText(context.external.target,1024,"External context target");if(context.external.arguments!==undefined){object(context.external.arguments,"External context arguments");if(Object.keys(context.external.arguments).length>16)throw new Error("Too many external context arguments");for(const [key,item] of Object.entries(context.external.arguments)){if(!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key))throw new Error("Invalid external context argument name");boundedText(item,256,"External context argument");}}}}
    if(!resource.context?.external)packagePath(resource.locator,"Local Scenario resource locator");
  }}
function validateMigrations(value:unknown):void{object(value,"Scenario migration manifest");exact(value,["revision","steps"]);positive(value.revision,1_000_000,"Migration manifest revision");array(value.steps,256,"Scenario migration steps");for(const step of value.steps){object(step,"Scenario migration step");exact(step,["id","fromSchemaRevision","toSchemaRevision","resourceId"]);boundedText(step.id,128,"Migration step id");positive(step.fromSchemaRevision,1_000_000,"Migration source revision");positive(step.toSchemaRevision,1_000_000,"Migration target revision");boundedText(step.resourceId,128,"Migration resource id");}}
function validateRuntime(value:unknown,binding:ScenarioPackageDescriptorV1["package"]):void{object(value,"Scenario Process manifest");exact(value,["protocol","protocolVersion","id","version","source","entrypoint","providedCapabilities","hostCapabilities"]);validateScenarioProcessManifest(value as never);if(value.id!==binding.id||value.version!==binding.version)throw new Error("Scenario Process identity does not match descriptor Package");strings(value.providedCapabilities,256,128,"Scenario Process provided capabilities");strings(value.hostCapabilities,64,128,"Scenario Process host capabilities");packagePath(value.entrypoint,"Scenario Process entrypoint");}

function jsonClone(value:unknown,maximumBytes:number,maximumDepth:number):unknown{let encoded:string;try{encoded=JSON.stringify(value);}catch{throw new Error("Scenario Package descriptor must be JSON");}if(encoded===undefined||Buffer.byteLength(encoded)>maximumBytes)throw new Error("Scenario Package descriptor exceeds byte limit");const parsed:unknown=JSON.parse(encoded);const visit=(item:unknown,depth:number):void=>{if(depth>maximumDepth)throw new Error("Scenario Package descriptor exceeds depth limit");if(item&&typeof item==="object")for(const child of Object.values(item))visit(child,depth+1);};visit(parsed,0);return parsed;}
function object(value:unknown,label:string):asserts value is Record<string,any>{if(!value||typeof value!=="object"||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype)throw new Error(`${label} must be an object`);}
function exact(value:Record<string,unknown>,keys:readonly string[]):void{const allowed=new Set(keys);if(Object.keys(value).some(key=>!allowed.has(key)))throw new Error("Unknown Scenario Package descriptor field");}
function array(value:unknown,maximum:number,label:string):asserts value is any[]{if(!Array.isArray(value)||value.length>maximum)throw new Error(`${label} must be a bounded array`);}
function boundedText(value:unknown,maximum:number,label:string):asserts value is string{if(typeof value!=="string"||!value.trim()||value!==value.trim()||Buffer.byteLength(value)>maximum)throw new Error(`${label} is invalid`);}
function strings(value:unknown,maximumItems:number,maximumBytes:number,label:string):asserts value is string[]{array(value,maximumItems,label);for(const item of value)boundedText(item,maximumBytes,label);if(new Set(value).size!==value.length)throw new Error(`${label} contains duplicates`);}
function positive(value:unknown,maximum:number,label:string):asserts value is number{if(!Number.isSafeInteger(value)||Number(value)<1||Number(value)>maximum)throw new Error(`${label} must be a bounded positive integer`);}
function nonnegative(value:unknown,maximum:number,label:string):asserts value is number{if(!Number.isSafeInteger(value)||Number(value)<0||Number(value)>maximum)throw new Error(`${label} must be a bounded nonnegative integer`);}
function optionalPositive(value:unknown,maximum:number,label:string):void{if(value!==undefined)positive(value,maximum,label);}
function optionalNonnegative(value:unknown,maximum:number,label:string):void{if(value!==undefined)nonnegative(value,maximum,label);}
function sha(value:unknown,label:string):asserts value is `sha256:${string}`{if(typeof value!=="string"||!/^sha256:[a-f0-9]{64}$/.test(value))throw new Error(`${label} is invalid`);}
function packagePath(value:unknown,label:string):string{boundedText(value,512,label);if(!value.startsWith("package://"))throw new Error(`${label} must use package://`);const path=value.slice(10);if(!path||path.split("/").some(part=>!part||part==="."||part===".."||!/^[a-zA-Z0-9_.-]+$/.test(part)))throw new Error(`${label} is unsafe`);return path;}
function deepFreeze<T>(value:T):T{if(value&&typeof value==="object"&&!Object.isFrozen(value)){for(const child of Object.values(value))deepFreeze(child);Object.freeze(value);}return value;}
