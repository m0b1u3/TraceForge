import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { canonicalJson, type ScenarioPackageBinding } from "@traceforge/orchestration-core";
import { ScenarioPackageRegistry } from "@traceforge/scenario-sdk";
import { waitForCancellation } from "@traceforge/worker-runtime";
import { SqliteScenarioEventStore } from "./scenario-event-store.js";
import { assertRunExecutionSettled } from "./scenario-run-migration.js";
import { SqliteScenarioAuthorizationService, authorizationHash as hash, sameAuthorizationPolicy, type AuthorizationBinding } from "./scenario-authorization.js";

const text=z.string().trim().min(1).max(256),binding=z.object({id:text,version:text,schemaRevision:z.number().int().positive()}).strict();
const inputSchema=z.object({scopeRef:text,caseId:text,expectedRevision:z.number().int().nonnegative(),target:binding}).strict();
const requestSchema=inputSchema.extend({commandId:text,actor:text,reason:z.string().trim().min(1).max(1024),planFingerprint:z.string().regex(/^[a-f0-9]{64}$/)});
type Input=z.infer<typeof inputSchema>;type Request=z.infer<typeof requestSchema>;
interface UpgradeAudit {
  commandId:string;scopeRef:string;caseId:string;actor:string;reason:string;authorizationRef:string;
  plan:NonNullable<ReturnType<ScenarioAuthorizationUpgradeControl["preview"]>["plan"]>;
  result:AuthorizationBinding;at:string;automaticResume:boolean;
}
export interface AuthorizationUpgradeOptions {
  assertTrusted?(binding:ScenarioPackageBinding,contractFingerprint:string):void;
  authorizer?:{authorize(request:Request):Promise<{decision:"allowed";authorizationRef:string;expiresAt:string}|{decision:"denied"}>};
}
export class ScenarioAuthorizationUpgradeControl {
  private readonly authorization:SqliteScenarioAuthorizationService;
  constructor(private readonly sqlite:Database.Database,private readonly packages:ScenarioPackageRegistry,
    private readonly options:AuthorizationUpgradeOptions={},private readonly now=()=>new Date().toISOString()) {
    this.authorization=new SqliteScenarioAuthorizationService(sqlite,packages,()=>Date.parse(now()));
  }
  preview(value:unknown){
    const input=inputSchema.parse(structuredClone(value));
    try {const plan=this.prepare(input);return {eligible:true,blockers:[],plan,planFingerprint:hash(plan)};}
    catch(error){return {eligible:false,blockers:[message(error)],plan:null,planFingerprint:null};}
  }
  private trusted(target:ScenarioPackageBinding){
    const pkg=this.authorization.installed(target),contract=this.authorization.contract(pkg);
    if(!this.options.assertTrusted)throw new Error("Authorization upgrade trust verifier not configured");
    const result:unknown=this.options.assertTrusted(structuredClone(target),contract);
    if(result!==undefined){void Promise.resolve(result).catch(()=>{});throw new Error("Authorization trust verifier must be synchronous");}
    return contract;
  }
  private prepare(input:Input){
    const row=this.authorization.row(input.scopeRef,input.caseId),previous=this.authorization.binding(input.scopeRef),target=this.authorization.installed(input.target);
    if((previous?.revision??0)!==input.expectedRevision)throw new Error("Authorization revision conflict");
    const contract=this.trusted(input.target),scope=this.authorization.parse(row,target);
    if(previous){
      const source=this.authorization.requireScope(input.scopeRef,input.caseId);
      this.trusted(JSON.parse(previous.package_json));
      if(!sameAuthorizationPolicy(source.package,target) || target.schemaRevision<=source.package.schemaRevision || target.definition.version<=source.package.definition.version
        || canonicalJson(source.scope)!==canonicalJson(scope))throw new Error("Only a compatible forward policy upgrade can preserve existing authorization");
    }
    // Read bounded owning Runs from their immutable start facts, not an assumed latest package.
    const ids=this.sqlite.prepare("SELECT run_id FROM scenario_events WHERE event_type='run_started' AND json_extract(payload_json,'$.state.scopeRef')=? LIMIT 257").all(input.scopeRef) as {run_id:string}[];
    if(ids.length>256)throw new Error("Authorization upgrade Run budget exceeded");
    const events=new SqliteScenarioEventStore(this.sqlite),runs=[];
    for(const {run_id} of ids){
      const state=events.loadState(run_id)!;
      if(Buffer.byteLength(canonicalJson(state))>2*1024*1024)throw new Error("Authorization upgrade Run state budget exceeded");
      if(state.caseId!==input.caseId)throw new Error("Authorization Run Case mismatch");
      if(["completed","cancelled"].includes(state.status))continue;
      if(state.status!=="paused" || state.workItems.some(w=>w.pendingApproval || ["running","waiting_approval"].includes(w.status)))throw new Error("All affected Runs must be paused with settled approvals");
      assertRunExecutionSettled(this.sqlite,state.id);
      if(!state.scenarioPackage)throw new Error("Affected Run Package is unbound");
      const pkg=this.packages.requireBinding(state.scenarioPackage,state.definitionKind,state.definitionVersion);
      if(!sameAuthorizationPolicy(pkg,target))throw new Error("Target policy is incompatible with an affected Run");
      runs.push({id:state.id,revision:state.revision,stateFingerprint:hash(state)});
    }
    return {scopeRef:row.id,caseId:row.case_id,from:previous??null,to:input.target,targetContract:contract,scopeFingerprint:hash(row),runs,
      mode:previous?"compatible_upgrade":"explicit_legacy_binding",automaticResume:false};
  }
  async upgrade(value:unknown){
    const input=requestSchema.parse(structuredClone(value)),requestHash=hash(input),saved=this.saved(input.commandId,requestHash);
    if(!saved && hash(this.prepare(input))!==input.planFingerprint)throw new Error("Authorization upgrade preview is stale");
    const grant=structuredClone(await waitForCancellation(()=>this.options.authorizer?.authorize(structuredClone(input))??Promise.resolve({decision:"denied" as const}),AbortSignal.timeout(10000)));
    if(grant.decision!=="allowed" || !grant.authorizationRef.trim() || !(Date.parse(grant.expiresAt)>Date.parse(this.now())))throw new Error("Authorization upgrade denied or expired");
    return this.sqlite.transaction(()=>{
      const replay=this.saved(input.commandId,requestHash);
      if(replay){this.trusted(input.target);this.authorization.requireScope(input.scopeRef,input.caseId);if(!(Date.parse(grant.expiresAt)>Date.parse(this.now())))throw new Error("Authorization expired");return {audit:replay,replayed:true};}
      const plan=this.prepare(input);
      if(hash(plan)!==input.planFingerprint)throw new Error("Authorization upgrade changed during approval");
      if(!(Date.parse(grant.expiresAt)>Date.parse(this.now())))throw new Error("Authorization expired before commit");
      const result=this.authorization.pin(input.scopeRef,input.caseId,input.target,input.expectedRevision);
      const audit={commandId:input.commandId,scopeRef:input.scopeRef,caseId:input.caseId,actor:input.actor,reason:input.reason,
        authorizationRef:grant.authorizationRef,plan,result,at:this.now(),automaticResume:false};
      this.sqlite.prepare("INSERT INTO scenario_authorization_upgrades VALUES (?,?,?,?)").run(input.commandId,requestHash,hash(audit),canonicalJson(audit));
      return {audit,replayed:false};
    })();
  }
  private saved(commandId:string,requestHash?:string):UpgradeAudit|undefined {
    const row=this.sqlite.prepare("SELECT * FROM scenario_authorization_upgrades WHERE command_id=?").get(commandId) as {request_hash:string;audit_hash:string;audit_json:string}|undefined;
    if(!row)return;
    if(requestHash && row.request_hash!==requestHash)throw new Error("Authorization command conflicts with original request");
    const audit=JSON.parse(row.audit_json) as UpgradeAudit;
    if(hash(audit)!==row.audit_hash || audit.commandId!==commandId)throw new Error("Authorization upgrade audit integrity mismatch");return audit;
  }
  inspect(scopeRef:string,caseId:string,commandId:string){const audit=this.saved(commandId);if(!audit || audit.scopeRef!==scopeRef || audit.caseId!==caseId)throw new Error("Authorization audit not found in Case/scope");return audit;}
}
function message(error:unknown){return (error instanceof Error?error.message:"Authorization upgrade failed").slice(0,1024);}
export function registerAuthorizationUpgradeRoutes(app:FastifyInstance,control:ScenarioAuthorizationUpgradeControl){
  app.post("/api/scenarios/authorizations/:scopeRef/policy-upgrade/preview",async(request,reply)=>{try{return control.preview({...request.body as object,...request.params as object});}catch(error){return reply.code(400).send({error:message(error)});}});
  app.post("/api/scenarios/authorizations/:scopeRef/policy-upgrade",async(request,reply)=>{try{return await control.upgrade({...request.body as object,...request.params as object});}catch(error){return reply.code(error instanceof z.ZodError?400:409).send({error:message(error)});}});
  app.get("/api/scenarios/authorizations/:scopeRef/policy-upgrade",async(request,reply)=>{try{const input=z.object({scopeRef:text,caseId:text,commandId:text}).parse({...request.query as object,...request.params as object});return control.inspect(input.scopeRef,input.caseId,input.commandId);}catch(error){return reply.code(409).send({error:message(error)});}});
}
