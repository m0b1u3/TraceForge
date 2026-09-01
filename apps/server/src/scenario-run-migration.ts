import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { canonicalJson, DurableScenarioRuntime, ScenarioDefinitionRegistry, type ScenarioPackageBinding } from "@traceforge/orchestration-core";
import { assertPreserveRunCompatibility, ScenarioPackageRegistry, type ScenarioPackageInstallation } from "@traceforge/scenario-sdk";
import { validateWorkerCheckpoint, waitForCancellation, type WorkerCheckpointStore } from "@traceforge/worker-runtime";
import type { BlackboardChangeBus } from "@traceforge/cognitive-runtime";
import { SqliteScenarioEventStore } from "./scenario-event-store.js";
import { SqlitePackageContextStore, contextContentDigest, type PackageContextContent } from "./package-context-resources.js";
import { SqliteToolInvocationBindingStore } from "./worker-execution-adapters.js";
import { SqliteScenarioAuthorizationService } from "./scenario-authorization.js";

const text=z.string().trim().min(1).max(256), fingerprint=z.string().regex(/^[a-f0-9]{64}$/);
const binding=z.object({id:text,version:text,schemaRevision:z.number().int().positive()}).strict();
const previewInput=z.object({caseId:text,runId:text,expectedRevision:z.number().int().positive(),target:binding}).strict();
const migrationInput=previewInput.extend({commandId:text,actor:text,reason:z.string().trim().min(1).max(1024),planFingerprint:fingerprint}).strict();
const resourceSchema=z.object({format:z.literal("traceforge.run-migration.v1"),mode:z.literal("preserve_state"),from:binding,to:binding}).strict();
type PreviewInput=z.infer<typeof previewInput>;
type MigrationInput=z.infer<typeof migrationInput>;
const hash=(value:unknown)=>createHash("sha256").update(canonicalJson(value)).digest("hex");
export interface ScenarioRunMigrationOptions {
  resources?: readonly PackageContextContent[];
  /** Installed JS is trusted host code only after an explicit current host decision. No inferred trust from filenames. */
  assertTrusted?(binding:ScenarioPackageBinding,contractFingerprint:string):void;
  authorizer?:{authorize(input:MigrationInput):Promise<{decision:"allowed";authorizationRef:string;expiresAt:string}|{decision:"denied"}>};
}
interface Snapshot {
  caseId:string;runId:string;revision:number;from:ScenarioPackageBinding;to:ScenarioPackageBinding;definitionVersion:number;
  stateFingerprint:string;sourceContract:string;targetContract:string;scopeFingerprint:string;resourceId:string;resourceDigest:string;
  checkpointRefs:string[];
}
interface Audit {commandId:string;caseId:string;runId:string;actor:string;reason:string;authorizationRef:string;planFingerprint:string;
  plan:Snapshot;resultingRevision:number;migrationRef:string;at:string;automaticResume:false}

/** One preserved-state migration; no scripts, implicit package installation, or rewriting old facts. */
export class ScenarioRunMigrationControl {
  private readonly runtime:DurableScenarioRuntime;
  private readonly events:SqliteScenarioEventStore;
  private readonly bindings:SqliteToolInvocationBindingStore;
  constructor(private readonly sqlite:Database.Database,private readonly packages:ScenarioPackageRegistry,
    private readonly contexts:SqlitePackageContextStore,private readonly checkpoints:WorkerCheckpointStore,
    private readonly options:ScenarioRunMigrationOptions={},private readonly changes?:BlackboardChangeBus,
    private readonly now=()=>new Date().toISOString()) {
    this.events=new SqliteScenarioEventStore(sqlite);
    this.runtime=new DurableScenarioRuntime(this.events,new ScenarioDefinitionRegistry(packages.definitions()),packages);
    this.bindings=new SqliteToolInvocationBindingStore(sqlite,now);
    sqlite.exec(`CREATE TABLE IF NOT EXISTS scenario_migration_resources (
      binding TEXT NOT NULL,resource_id TEXT NOT NULL,manifest_hash TEXT NOT NULL,content TEXT NOT NULL,PRIMARY KEY(binding,resource_id));
      CREATE TABLE IF NOT EXISTS scenario_run_migrations (
      command_id TEXT PRIMARY KEY,request_fingerprint TEXT NOT NULL,audit_hash TEXT NOT NULL,audit_json TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS scenario_migration_resource_bound BEFORE INSERT ON scenario_migration_resources BEGIN
        SELECT CASE WHEN length(CAST(NEW.content AS BLOB))>65536 OR (SELECT count(*) FROM scenario_migration_resources)>=1024
          OR (SELECT coalesce(sum(length(CAST(content AS BLOB))),0) FROM scenario_migration_resources)+length(CAST(NEW.content AS BLOB))>8388608
          THEN RAISE(ABORT,'Migration resource capacity exceeded') END;
        SELECT execution_physical_admit(execution_floor,maximum_database_bytes,maximum_wal_bytes,73728,'execution') FROM execution_physical_policy WHERE id=1;
      END;
      CREATE TRIGGER IF NOT EXISTS scenario_run_migration_bound BEFORE INSERT ON scenario_run_migrations BEGIN
        SELECT CASE WHEN length(CAST(NEW.audit_json AS BLOB))>65536 OR (SELECT count(*) FROM scenario_run_migrations)>=50000
          THEN RAISE(ABORT,'Migration audit capacity exceeded') END;
        SELECT execution_physical_admit(recovery_floor,maximum_database_bytes,maximum_wal_bytes,77824,'recovery') FROM execution_physical_policy WHERE id=1;
      END;`);
    for(const table of ["scenario_migration_resources","scenario_run_migrations"])for(const operation of ["UPDATE","DELETE"]){
      sqlite.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_${operation.toLowerCase()}_fence BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT,'Migration history is immutable'); END;`);
    }
    sqlite.transaction(()=>{for(const item of options.resources??[]){
      const pkg=this.installed(item.package),resource=pkg.resourceManifest?.resources.find(r=>r.id===item.resourceId);
      if(!resource || resource.kind!=="migration" || resource.context || typeof item.content!=="string"
        || Buffer.byteLength(item.content)>65536 || contextContentDigest(item.content)!==resource.digest)throw new Error("Invalid host-installed migration resource");
      resourceSchema.parse(JSON.parse(item.content));
      const key=canonicalJson(item.package),previous=sqlite.prepare("SELECT * FROM scenario_migration_resources WHERE binding=? AND resource_id=?").get(key,item.resourceId) as {manifest_hash:string;content:string}|undefined;
      if(previous){if(previous.manifest_hash!==hash(resource) || previous.content!==item.content)throw new Error("Migration resource is immutable");}
      else sqlite.prepare("INSERT INTO scenario_migration_resources VALUES (?,?,?,?)").run(key,item.resourceId,hash(resource),item.content);
    }})();
  }

  async preview(value:unknown){
    const input=previewInput.parse(structuredClone(value));
    try {const plan=await this.prepare(input);return {eligible:true as const,blockers:[],...plan};}
    catch(error){return {eligible:false as const,blockers:[message(error)],plan:null,planFingerprint:null};}
  }

  async migrate(value:unknown){
    const input=migrationInput.parse(structuredClone(value)),requestFingerprint=hash(input);
    const previous=this.saved(input.commandId,requestFingerprint);
    const prepared=previous ? undefined : await this.prepare(input);
    if(prepared && prepared.planFingerprint!==input.planFingerprint)throw new Error("Migration preview is stale or mismatched");
    const grant=structuredClone(await waitForCancellation(()=>this.options.authorizer?.authorize(structuredClone(input)) ?? Promise.resolve({decision:"denied" as const}),AbortSignal.timeout(10000)));
    if(grant.decision!=="allowed" || !grant.authorizationRef?.trim() || !(Date.parse(grant.expiresAt)>Date.parse(this.now())))throw new Error("Migration authorization denied or expired");
    const raced=this.saved(input.commandId,requestFingerprint);
    if(raced){this.assertReplayTrust(raced);if(!(Date.parse(grant.expiresAt)>Date.parse(this.now())))throw new Error("Migration authorization expired before replay");return {audit:raced,replayed:true};}
    const checked=await this.prepare(input);
    if(checked.planFingerprint!==input.planFingerprint)throw new Error("Migration changed during authorization");
    const result=this.sqlite.transaction(()=>{
      if(!(Date.parse(grant.expiresAt)>Date.parse(this.now())))throw new Error("Migration authorization expired before commit");
      const replay=this.saved(input.commandId,requestFingerprint);
      if(replay){this.assertReplayTrust(replay);return {audit:replay,replayed:true};}
      if(canonicalJson(this.snapshot(input))!==canonicalJson(checked.plan))throw new Error("Migration inputs changed before commit");
      if(!(Date.parse(grant.expiresAt)>Date.parse(this.now())))throw new Error("Migration authorization expired before commit");
      const at=this.now(),migrationRef=`run-migration:${input.commandId}`;
      const command=this.runtime.execute({runId:input.runId,commandId:migrationRef,expectedRevision:input.expectedRevision,
        command:{type:"migrate_run_package",target:input.target,definitionVersion:checked.plan.definitionVersion,
          migrationRef,authorizationRef:grant.authorizationRef,reason:input.reason,at}});
      const audit:Audit={commandId:input.commandId,caseId:input.caseId,runId:input.runId,actor:input.actor,reason:input.reason,
        authorizationRef:grant.authorizationRef,planFingerprint:input.planFingerprint,plan:checked.plan,resultingRevision:command.state.revision,migrationRef,at,automaticResume:false};
      this.sqlite.prepare("INSERT INTO scenario_run_migrations VALUES (?,?,?,?)").run(input.commandId,requestFingerprint,hash(audit),canonicalJson(audit));
      return {audit,replayed:false};
    })();
    if(!result.replayed)this.changes?.publish({kind:"run",caseId:input.caseId,runId:input.runId,revision:result.audit.resultingRevision,eventTypes:["run_package_migrated"],at:result.audit.at});
    return result;
  }

  inspect(value:unknown){
    const input=z.object({caseId:text,runId:text,commandId:text}).strict().parse(value),audit=this.saved(input.commandId);
    if(!audit || audit.caseId!==input.caseId || audit.runId!==input.runId)throw new Error("Migration audit not found in this Run");return audit;
  }

  private async prepare(input:PreviewInput){
    return waitForCancellation(async()=>{
      const plan=this.snapshot(input),state=this.runtime.load(input.runId)!;let bytes=0;
      const checkpointHashes:string[]=[];
      for(const work of state.workItems){
        if(!work.latestCheckpoint)continue;
        const checkpoint=validateWorkerCheckpoint(await this.checkpoints.load(work.latestCheckpoint.payloadRef));
        bytes+=Buffer.byteLength(canonicalJson(checkpoint));if(bytes>16*1024*1024)throw new Error("Migration checkpoint budget exceeded");
        if(checkpoint.version!==2 || checkpoint.caseId!==state.caseId || checkpoint.runId!==state.id || checkpoint.workId!==work.id
          || checkpoint.workKey!==work.idempotencyKey || checkpoint.pendingInvocation)throw new Error("Migration requires an intact v2 checkpoint without a pending invocation");
        this.bindings.validateCheckpoint({runId:state.id,leaseId:checkpoint.leaseId,leaseExpiresAt:this.now(),runRevision:state.revision,work,
          runContext:{caseId:state.caseId,goal:state.goal,scopeRef:state.scopeRef,activePhaseId:state.activePhaseId,directives:state.directives}},checkpoint);
        checkpointHashes.push(hash(checkpoint));
      }
      if(canonicalJson(this.snapshot(input))!==canonicalJson(plan))throw new Error("Migration inputs changed during preview");
      return {plan,planFingerprint:hash({plan,checkpointHashes})};
    },AbortSignal.timeout(10000));
  }

  private snapshot(input:PreviewInput):Snapshot {
    const state=this.runtime.load(input.runId);
    if(!state || state.caseId!==input.caseId)throw new Error("Migration Run not found in this Case");
    if(state.revision!==input.expectedRevision)throw new Error("Migration revision conflict");
    if(state.status!=="paused" || !state.scenarioPackage)throw new Error("Migration requires a paused, bound Run");
    if(state.workItems.length>256 || Buffer.byteLength(canonicalJson(state))>2*1024*1024)throw new Error("Migration state budget exceeded");
    if(state.workItems.some(w=>(w.status==="queued" && w.leaseId) || w.pendingApproval || ["running","waiting_approval"].includes(w.status)))throw new Error("Migration requires settled Work and approvals");
    this.fences(state.id);
    const source=this.installed(state.scenarioPackage),target=this.installed(input.target);
    assertPreserveRunCompatibility(source,target,state);
    const sourceContract=this.trusted(source),targetContract=this.trusted(target);
    const steps=target.migrationManifest?.steps.filter(s=>s.fromSchemaRevision===source.schemaRevision && s.toSchemaRevision===target.schemaRevision)??[];
    if(steps.length!==1)throw new Error("Migration requires one explicit direct manifest step");
    const resource=target.resourceManifest!.resources.find(r=>r.id===steps[0]!.resourceId)!;
    const declaration=this.readMigration(target,resource.id);
    if(canonicalJson(declaration.from)!==canonicalJson(state.scenarioPackage) || canonicalJson(declaration.to)!==canonicalJson(input.target))throw new Error("Migration resource does not cover this exact version pair");
    const scope=new SqliteScenarioAuthorizationService(this.sqlite,this.packages,()=>Date.parse(this.now())).requireRun(state);
    const parsed=scope.scope;
    if(!source.definition.authorizationActions.every(a=>parsed.allowedActions.includes(a) && !parsed.deniedActions.includes(a)))throw new Error("Migration scope no longer permits the definition");
    return {caseId:state.caseId,runId:state.id,revision:state.revision,from:state.scenarioPackage,to:this.packages.bindingFor(target),
      definitionVersion:target.definition.version,stateFingerprint:hash(state),sourceContract,targetContract,scopeFingerprint:hash({row:scope.row,binding:scope.binding}),
      resourceId:resource.id,resourceDigest:resource.digest,checkpointRefs:state.workItems.flatMap(w=>w.latestCheckpoint?[w.latestCheckpoint.payloadRef]:[])};
  }

  private installed(value:ScenarioPackageBinding):ScenarioPackageInstallation {
    const pkg=this.packages.list().find(p=>p.id===value.id && p.version===value.version && p.schemaRevision===value.schemaRevision);
    if(!pkg)throw new Error("Migration Package binding is not installed");this.packages.assertAvailable(pkg);return pkg;
  }

  private trusted(pkg:ScenarioPackageInstallation):string {
    const contract=hash({binding:this.packages.bindingFor(pkg),definition:pkg.definition,outputs:pkg.outputSchemas.map(s=>({kind:s.kind,version:s.version})),
      resources:pkg.resourceManifest??null,migrations:pkg.migrationManifest??null});
    if(!this.options.assertTrusted)throw new Error("Migration Package trust verifier is not configured");
    const result:unknown=this.options.assertTrusted(this.packages.bindingFor(pkg),contract);
    if(result!==undefined){void Promise.resolve(result).catch(()=>{});throw new Error("Migration trust verifier must be synchronous");}
    const resources=pkg.resourceManifest?.resources??[];
    if(resources.length>128)throw new Error("Migration resource verification budget exceeded");
    for(const resource of resources){
      this.contexts.assertAvailable(this.packages.bindingFor(pkg),resource);
      if(resource.context){if(resource.context.external)throw new Error("External context resources require a separate migration verifier");this.contexts.read(this.packages.bindingFor(pkg),resource);}
      else if(resource.kind==="migration")this.readMigration(pkg,resource.id);
      else throw new Error("Executable or binary assets require a separate migration verifier");
    }
    return contract;
  }

  private readMigration(pkg:ScenarioPackageInstallation,id:string){
    const resource=pkg.resourceManifest?.resources.find(r=>r.id===id);
    if(!resource || resource.kind!=="migration" || resource.context)throw new Error("Migration resource manifest is missing");
    this.contexts.assertAvailable(this.packages.bindingFor(pkg),resource);
    const row=this.sqlite.prepare("SELECT manifest_hash,content FROM scenario_migration_resources WHERE binding=? AND resource_id=?")
      .get(canonicalJson(this.packages.bindingFor(pkg)),id) as {manifest_hash:string;content:string}|undefined;
    if(!row || row.manifest_hash!==hash(resource) || contextContentDigest(row.content)!==resource.digest || Buffer.byteLength(row.content)>65536)throw new Error("Migration resource is missing or corrupt");
    return resourceSchema.parse(JSON.parse(row.content));
  }

  private fences(runId:string){assertRunExecutionSettled(this.sqlite,runId);}

  private saved(commandId:string,requestFingerprint?:string):Audit|undefined {
    const row=this.sqlite.prepare("SELECT * FROM scenario_run_migrations WHERE command_id=?").get(commandId) as {request_fingerprint:string;audit_hash:string;audit_json:string}|undefined;
    if(!row)return;
    if(requestFingerprint && row.request_fingerprint!==requestFingerprint)throw new Error("Migration command conflicts with its recorded request");
    const audit=JSON.parse(row.audit_json) as Audit;
    if(hash(audit)!==row.audit_hash || audit.commandId!==commandId)throw new Error("Migration audit integrity mismatch");
    const command=this.events.findCommand(audit.runId,audit.migrationRef),event=command?.events[0];
    if(command?.resultingRevision!==audit.resultingRevision || command.events.length!==1 || event?.type!=="run_package_migrated"
      || canonicalJson(event.from)!==canonicalJson(audit.plan.from) || canonicalJson(event.to)!==canonicalJson(audit.plan.to)
      || event.toDefinitionVersion!==audit.plan.definitionVersion || event.reason!==audit.reason || event.at!==audit.at
      || event.authorizationRef!==audit.authorizationRef || event.migrationRef!==audit.migrationRef)throw new Error("Migration audit/event mismatch");
    return audit;
  }
  private assertReplayTrust(audit:Audit){
    if(this.trusted(this.installed(audit.plan.from))!==audit.plan.sourceContract || this.trusted(this.installed(audit.plan.to))!==audit.plan.targetContract)throw new Error("Migration replay trust changed");
  }
}
export function assertRunExecutionSettled(sqlite:Database.Database,runId:string){
    if(sqlite.prepare("SELECT 1 FROM scenario_work_leases WHERE run_id=? LIMIT 1").get(runId))throw new Error("Active lease prevents migration");
    if(sqlite.prepare(`SELECT 1 FROM tool_invocation_bindings b LEFT JOIN tool_invocation_executions e USING(idempotency_key)
      WHERE b.run_id=? AND (b.status='prepared' OR e.status IN ('executing','uncertain') OR (e.idempotency_key IS NULL AND b.status!='completed')) LIMIT 1`).get(runId))throw new Error("Open invocation prevents migration");
    for(const [table,path] of [["process_execution_occupancy","$.attribution.runId"],["managed_execution_occupancy","$.scheduling.runId"]]){
      if(!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(table))throw new Error("Execution occupancy recovery must be initialized before migration");
      if(sqlite.prepare(`SELECT 1 FROM ${table} WHERE state!='released' AND json_extract(identity_json,?)=? LIMIT 1`).get(path,runId))throw new Error("Unconfirmed execution occupancy prevents migration");
    }
    if(sqlite.prepare("SELECT 1 FROM scenario_work_approvals WHERE run_id=? AND status='pending' LIMIT 1").get(runId))throw new Error("Pending approval prevents migration");
  }
function message(error:unknown){return (error instanceof Error?error.message:"Migration failed").slice(0,1024);}
export function registerScenarioRunMigrationRoutes(app:FastifyInstance,control:ScenarioRunMigrationControl){
  app.post("/api/scenarios/runs/:runId/package-migration/preview",async(request,reply)=>{try{return await control.preview({...request.body as object,...request.params as object});}catch(error){return reply.code(400).send({error:message(error)});}});
  app.post("/api/scenarios/runs/:runId/package-migration",async(request,reply)=>{try{return await control.migrate({...request.body as object,...request.params as object});}catch(error){return reply.code(error instanceof z.ZodError?400:409).send({error:message(error)});}});
  app.get("/api/scenarios/runs/:runId/package-migration",async(request,reply)=>{try{return control.inspect({...request.query as object,...request.params as object});}catch(error){return reply.code(409).send({error:message(error)});}});
}
