import type Database from "better-sqlite3";
import { canonicalJson, DurableScenarioRuntime, ScenarioDefinitionRegistry, type ScenarioCommand } from "@traceforge/orchestration-core";
import { ScenarioPackageRegistry, type ScenarioPackageInstallation } from "@traceforge/scenario-sdk";
import { ToolProviderFairScheduler } from "@traceforge/worker-runtime";
import { at, definition, initialize } from "./execution-recovery.js";
import { SqliteScenarioEventStore } from "../scenario-event-store.js";
import { SqlitePackageContextStore, contextContentDigest } from "../package-context-resources.js";
import { SqliteWorkerCheckpointStore } from "../worker-checkpoint-store.js";
import { SqliteToolInvocationBindingStore } from "../worker-execution-adapters.js";
import { ManagedExecutionCapacity } from "../managed-execution-capacity.js";
import { ProcessExecutionCapacity } from "../process-execution-capacity.js";
import { ScenarioRunMigrationControl, type ScenarioRunMigrationOptions } from "../scenario-run-migration.js";
import { SqliteScenarioAuthorizationService } from "../scenario-authorization.js";

export function migrationPackages(){
  const policy={parseScope:(payload:unknown)=>({payload,allowedActions:["observe"],deniedActions:[]})},createToolSources=()=>[];
  const source:ScenarioPackageInstallation={id:"neutral",version:"1.0.0",schemaRevision:1,definition:structuredClone(definition),
    outputSchemas:[{kind:"decision",version:1,validate(){}}],authorizationPolicy:policy,createToolSources};
  const target:ScenarioPackageInstallation={...source,version:"2.0.0",schemaRevision:2,definition:{...structuredClone(definition),version:2}};
  const from={id:source.id,version:source.version,schemaRevision:1},to={id:target.id,version:target.version,schemaRevision:2};
  const content=canonicalJson({format:"traceforge.run-migration.v1",mode:"preserve_state",from,to});
  target.resourceManifest={revision:1,resources:[{id:"preserve",kind:"migration",version:1,locator:"migration.json",digest:contextContentDigest(content)}]};
  target.migrationManifest={revision:1,steps:[{id:"preserve",fromSchemaRevision:1,toSchemaRevision:2,resourceId:"preserve"}]};
  return {source,target,from,to,content,resources:[{package:to,resourceId:"preserve",content}]};
}
interface MigrationFixture extends ReturnType<typeof migrationPackages> {
  sqlite:Database.Database;packages:ScenarioPackageRegistry;contexts:SqlitePackageContextStore;checkpoints:SqliteWorkerCheckpointStore;
  bindings:SqliteToolInvocationBindingStore;capacity:ProcessExecutionCapacity;scheduler:ToolProviderFairScheduler;
  runtime:DurableScenarioRuntime;command(command:ScenarioCommand):ReturnType<DurableScenarioRuntime["execute"]>;
  control:ScenarioRunMigrationControl;
  input:{caseId:string;runId:string;expectedRevision:number;target:{id:string;version:string;schemaRevision:number}};
  request():Promise<MigrationFixture["input"] & {commandId:string;actor:string;reason:string;planFingerprint:string}>;
}
export function migrationFixture(sqlite:Database.Database,options:Partial<ScenarioRunMigrationOptions>={},configure?:(packages:ReturnType<typeof migrationPackages>)=>void):MigrationFixture{
  const p=migrationPackages();configure?.(p);const packages=new ScenarioPackageRegistry([p.source,p.target]);
  const contexts=new SqlitePackageContextStore(sqlite),checkpoints=new SqliteWorkerCheckpointStore(sqlite),bindings=new SqliteToolInvocationBindingStore(sqlite);
  const scheduler=new ToolProviderFairScheduler();new ManagedExecutionCapacity(sqlite,scheduler,bindings);const capacity=new ProcessExecutionCapacity(sqlite,scheduler);
  const runtime=new DurableScenarioRuntime(new SqliteScenarioEventStore(sqlite),new ScenarioDefinitionRegistry(packages.definitions()),packages);
  const command=(command:ScenarioCommand)=>runtime.execute({runId:"run",commandId:`fixture:${runtime.load("run")?.revision??0}:${command.type}`,
    expectedRevision:runtime.load("run")?.revision??0,command});
  if(!runtime.load("run")){
    initialize(sqlite);command({type:"pause_run",reason:"Prepare upgrade",requestedBy:"operator",at});
    sqlite.prepare("INSERT INTO scenario_authorizations VALUES ('scope','case','neutral','{}','fixture','active','2099-01-01T00:00:00.000Z',?,?)").run(at,at);
    new SqliteScenarioAuthorizationService(sqlite,packages).pin("scope","case",p.from,0);
  }
  const control=new ScenarioRunMigrationControl(sqlite,packages,contexts,checkpoints,{resources:p.resources,assertTrusted(){},
    authorizer:{async authorize(){return {decision:"allowed",authorizationRef:"fixture-reviewed",expiresAt:"2099-01-01T00:00:00.000Z"};}},...options});
  const input={caseId:"case",runId:"run",expectedRevision:4,target:p.to};
  const request=async()=>{const preview=await control.preview(input);if(!preview.eligible)throw new Error(preview.blockers.join(","));
    return {...input,commandId:"upgrade",actor:"operator",reason:"Use reviewed compatible version",planFingerprint:preview.planFingerprint!};};
  return {...p,sqlite,packages,contexts,checkpoints,bindings,capacity,scheduler,runtime,command,control,input,request};
}
