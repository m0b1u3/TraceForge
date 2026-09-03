import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { canonicalJson, type ScenarioPackageBinding, type ScenarioRunState } from "@traceforge/orchestration-core";
import { authorizeScenarioResource, parseScenarioScope, ScenarioPackageRegistry, type ActiveScenarioAuthorization, type ScenarioAuthorizationPort,
  type ScenarioPackageInstallation, type ScenarioResourceAuthorization } from "@traceforge/scenario-sdk";

export const authorizationHash=(value:unknown)=>createHash("sha256").update(canonicalJson(value)).digest("hex");
export interface AuthorizationRow {
  id:string;case_id:string;scenario_kind:string;scope_json:string;status:string;expires_at:string;
}
export interface AuthorizationBinding {
  scope_ref:string;revision:number;package_json:string;contract_hash:string;scope_hash:string;updated_at:string;
}
export class AuthorizationRecoveryRequired extends Error {}

/** Exact installed Package is an audited host dependency, not an inferred signature over JS closures. */
export class SqliteScenarioAuthorizationService implements ScenarioAuthorizationPort {
  constructor(private readonly sqlite:Database.Database,private readonly packages:ScenarioPackageRegistry,private readonly now:()=>number=Date.now) {}

  row(scopeRef:string,caseId:string):AuthorizationRow {
    const row=this.sqlite.prepare("SELECT id,case_id,scenario_kind,scope_json,status,expires_at FROM scenario_authorizations WHERE id=?").get(scopeRef) as AuthorizationRow|undefined;
    if(!row || row.case_id!==caseId)throw new Error("Scope authorization does not belong to the assigned Case");
    if(row.status!=="active" || !(Date.parse(row.expires_at)>this.now()))throw new Error("Authorization scope is expired or revoked");
    return row;
  }
  binding(scopeRef:string):AuthorizationBinding|undefined {
    return this.sqlite.prepare("SELECT * FROM scenario_authorization_bindings WHERE scope_ref=?").get(scopeRef) as AuthorizationBinding|undefined;
  }
  installed(binding:ScenarioPackageBinding):ScenarioPackageInstallation {
    const pkg=this.packages.list().find(p=>p.id===binding.id && p.version===binding.version && p.schemaRevision===binding.schemaRevision);
    if(!pkg)throw new AuthorizationRecoveryRequired("Pinned authorization Package is not installed; recovery required");this.packages.assertAvailable(pkg);return pkg;
  }
  contract(pkg:ScenarioPackageInstallation):string {
    return authorizationHash({package:this.packages.bindingFor(pkg),definition:pkg.definition,
      policy:"format" in pkg.authorizationPolicy?pkg.authorizationPolicy:"legacy-host-callback"});
  }
  parse(row:AuthorizationRow,pkg:ScenarioPackageInstallation) {
    if(Buffer.byteLength(row.scope_json)>1024*1024)throw new Error("Authorization scope budget exceeded");
    if(pkg.definition.kind!==row.scenario_kind)throw new AuthorizationRecoveryRequired("Authorization scenario mismatch");
    const scope=parseScenarioScope(pkg.authorizationPolicy,JSON.parse(row.scope_json));
    const declared=new Set(pkg.definition.authorizationActions);
    if([...scope.allowedActions,...scope.deniedActions].some(a=>!declared.has(a)))throw new Error("Authorization contains undeclared actions");
    return scope;
  }
  requireScope(scopeRef:string,caseId:string,expected?:ScenarioPackageInstallation) {
    const row=this.row(scopeRef,caseId),binding=this.binding(scopeRef);
    if(!binding)throw new AuthorizationRecoveryRequired("Authorization policy version is unbound; explicit recovery required");
    const pkg=this.installed(JSON.parse(binding.package_json));
    if(binding.contract_hash!==this.contract(pkg) || binding.scope_hash!==authorizationHash(JSON.parse(row.scope_json)))throw new AuthorizationRecoveryRequired("Authorization binding integrity mismatch");
    if(expected && (expected.definition.kind!==pkg.definition.kind || !sameAuthorizationPolicy(pkg,expected)))throw new AuthorizationRecoveryRequired("Run and pinned authorization policy are incompatible");
    return {row,binding,package:pkg,scope:this.parse(row,pkg)};
  }
  requireRun(state:ScenarioRunState) {
    if(!state.scenarioPackage)throw new AuthorizationRecoveryRequired("Run Package is unbound");
    const pkg=this.packages.requireBinding(state.scenarioPackage,state.definitionKind,state.definitionVersion);
    return this.requireScope(state.scopeRef,state.caseId,pkg);
  }
  /** Trusted composition only. HTTP callers must use creation or the separately authorized upgrade control. */
  pin(scopeRef:string,caseId:string,target:ScenarioPackageBinding,expectedRevision:number) {
    const row=this.row(scopeRef,caseId),pkg=this.installed(target);this.parse(row,pkg);
    const previous=this.binding(scopeRef);
    if((previous?.revision??0)!==expectedRevision)throw new Error("Authorization binding revision conflict");
    const saved={scope_ref:scopeRef,revision:expectedRevision+1,package_json:canonicalJson(target),contract_hash:this.contract(pkg),scope_hash:authorizationHash(JSON.parse(row.scope_json)),updated_at:new Date(this.now()).toISOString()};
    if(previous){const result=this.sqlite.prepare("UPDATE scenario_authorization_bindings SET revision=@revision,package_json=@package_json,contract_hash=@contract_hash,scope_hash=@scope_hash,updated_at=@updated_at WHERE scope_ref=@scope_ref AND revision=@expected").run({...saved,expected:expectedRevision});if(result.changes!==1)throw new Error("Authorization binding revision conflict");}
    else this.sqlite.prepare("INSERT INTO scenario_authorization_bindings VALUES (@scope_ref,@revision,@package_json,@contract_hash,@scope_hash,@updated_at)").run(saved);
    return saved;
  }
  diagnostic(scopeRef:string,caseId:string) {
    const saved=this.binding(scopeRef);
    try {this.requireScope(scopeRef,caseId);return {status:"available",revision:saved!.revision,package:JSON.parse(saved!.package_json)};}
    catch(error){return {status:"recovery_required",revision:saved?.revision??0,package:saved?JSON.parse(saved.package_json):null,reason:error instanceof Error?error.message:"Authorization unavailable"};}
  }
  requireAction(scopeRef:string,caseId:string,action:string):ActiveScenarioAuthorization {
    const {row,scope}=this.requireScope(scopeRef,caseId);
    if(scope.deniedActions.includes(action))throw new Error(`Action ${action} is explicitly denied by ${scopeRef}`);
    if(!scope.allowedActions.includes(action))throw new Error(`Action ${action} is not authorized by ${scopeRef}`);
    return {id:row.id,caseId:row.case_id,scenarioKind:row.scenario_kind,scopePayload:scope.payload,expiresAt:row.expires_at};
  }
  authorizeResource(scopeRef:string,caseId:string,action:string,resourceKind:string,value:string):ScenarioResourceAuthorization {
    const authorization=this.requireAction(scopeRef,caseId,action),{package:pkg}=this.requireScope(scopeRef,caseId);
    return {...authorization,canonicalValue:authorizeScenarioResource(pkg.authorizationPolicy,authorization.scopePayload,resourceKind,value)};
  }
}
export function sameAuthorizationPolicy(a:ScenarioPackageInstallation,b:ScenarioPackageInstallation):boolean {
  const left=a.authorizationPolicy,right=b.authorizationPolicy;
  if("format" in left || "format" in right)return a.id===b.id && canonicalJson(left)===canonicalJson(right);
  return a.id===b.id && left.parseScope===right.parseScope && left.authorizeResource===right.authorizeResource;
}
