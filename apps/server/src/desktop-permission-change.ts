import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { DesktopPermissionChangeSchema } from "@traceforge/shared/desktop-execution";
import { canonicalJson, type DurableScenarioRuntime } from "@traceforge/orchestration-core";
import { AuthorizationFormSchema, buildAuthorizationScope } from "@traceforge/shared/authorization-form";
import { SqliteScenarioEventStore } from "./scenario-event-store.js";
import { SqliteScenarioAuthorizationService, authorizationHash } from "./scenario-authorization.js";
import { assertRunExecutionSettled } from "./scenario-run-migration.js";

/** Operator-only authorization transaction. Model proposals carry no authority;
 * an explicit request resolution can also continue its checkpointed Work. */
export class DesktopPermissionChange {
  constructor(private readonly db: Database.Database, private readonly authorization: SqliteScenarioAuthorizationService, private readonly runtime?: DurableScenarioRuntime) {
    db.exec(`CREATE TABLE IF NOT EXISTS desktop_permission_changes(conversation_id TEXT NOT NULL,command_id TEXT NOT NULL,fingerprint TEXT NOT NULL,audit_json TEXT NOT NULL,PRIMARY KEY(conversation_id,command_id));
      CREATE TRIGGER IF NOT EXISTS desktop_permission_changes_update BEFORE UPDATE ON desktop_permission_changes BEGIN SELECT RAISE(ABORT,'Permission change audit is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS desktop_permission_changes_delete BEFORE DELETE ON desktop_permission_changes BEGIN SELECT RAISE(ABORT,'Permission change audit is immutable'); END;`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS desktop_permission_changes_capacity BEFORE INSERT ON desktop_permission_changes BEGIN
      SELECT execution_physical_admit(execution_floor,maximum_database_bytes,maximum_wal_bytes,262144,'execution') FROM execution_physical_policy WHERE id=1; END;`);
  }
  private owned(conversationId: string, runId: string) {
    const owner = this.db.prepare("SELECT case_id FROM desktop_conversations WHERE id=?").get(conversationId) as {case_id:string}|undefined;
    const run = new SqliteScenarioEventStore(this.db).loadState(runId);
    if (!owner || !run || owner.case_id !== run.caseId) throw new Error("找不到当前会话的任务");
    return run;
  }
  recorded(conversationId:string,commandId:string){return !!this.db.prepare("SELECT 1 FROM desktop_permission_changes WHERE conversation_id=? AND command_id=?").get(conversationId,commandId);}
  read(conversationId: string, runId: string) {
    const run = this.owned(conversationId, runId), current = this.authorization.requireRun(run);
    if (!("form" in current.package.authorizationPolicy) || !current.package.authorizationPolicy.form) throw new Error("当前场景没有可编辑的授权表单");
    return { runId, expectedRevision: run.revision, expectedScopeRevision: current.binding.revision, scope: current.scope.payload,
      form: current.package.authorizationPolicy.form, policy: {allowedActions:current.scope.allowedActions,deniedActions:current.scope.deniedActions,resources:"resources" in current.package.authorizationPolicy?current.package.authorizationPolicy.resources:[]},
      requests: run.workItems.filter(work => work.status === "blocked" && work.permissionRequest?.status === "pending")
        .map(work => ({ workId: work.id, ...work.permissionRequest! })),
      status: run.status, expiresAt:current.row.expires_at, automaticResume: false };
  }
  change(conversationId: string, raw: unknown) {
    const input = DesktopPermissionChangeSchema.parse(raw);
    if (Buffer.byteLength(canonicalJson(input.scope)) > 32768) throw new Error("授权范围超过 32 KiB");
    const fingerprint = authorizationHash(input);
    return this.db.transaction(() => {
      this.owned(conversationId, input.runId);
      const saved = this.db.prepare("SELECT fingerprint,audit_json FROM desktop_permission_changes WHERE conversation_id=? AND command_id=?").get(conversationId,input.commandId) as {fingerprint:string;audit_json:string}|undefined;
      if (saved) { if(saved.fingerprint!==fingerprint) throw new Error("请求标识已用于另一份授权变更"); return {...JSON.parse(saved.audit_json),replayed:true}; }
      const run = this.owned(conversationId, input.runId), current = this.authorization.requireRun(run);
      if (run.status !== "paused" || run.revision !== input.expectedRevision || current.binding.revision !== input.expectedScopeRevision) throw new Error("请先暂停任务并重新读取当前授权");
      if (input.resolution) {
        const work = run.workItems.find(work => work.id === input.resolution!.workId);
        if (!this.runtime || work?.status !== "blocked" || work.permissionRequest?.status !== "pending"
          || work.permissionRequest.id !== input.resolution.requestId) throw new Error("权限申请已失效，请刷新任务状态");
      }
      const changesScope = !input.resolution || input.resolution.approved;
      const owners = this.db.prepare("SELECT DISTINCT run_id FROM scenario_events WHERE event_type='run_started' AND json_extract(payload_json,'$.state.scopeRef')=? LIMIT 2").all(run.scopeRef) as {run_id:string}[];
      if (changesScope && (owners.length !== 1 || owners[0].run_id !== run.id)) throw new Error("该授权被其他任务共用，不能修改；请为新任务单独登记授权");
      assertRunExecutionSettled(this.db, run.id);
      if (!changesScope && canonicalJson(input.scope) !== canonicalJson(current.scope.payload)) throw new Error("拒绝申请不得改变授权范围");
      if (changesScope) {
      const form = AuthorizationFormSchema.parse("form" in current.package.authorizationPolicy ? current.package.authorizationPolicy.form : undefined);
      const reconstructed = buildAuthorizationScope(form, form.fields.map(field => {
        let value:unknown=input.scope; for(const part of field.path)value=value&&typeof value==="object"?(value as Record<string,unknown>)[part]:undefined;
        if(field.type==="integer"){if(typeof value!=="number"||!Number.isSafeInteger(value))throw new Error("预算必须明确填写整数");return String(value);}
        if(field.type==="boolean") { if(typeof value!=="boolean")throw new Error("授权选项必须明确选择"); return String(value); }
        if(!Array.isArray(value)||!value.every(item=>typeof item==="string"))throw new Error("授权范围必须按表单填写"); return value.join("\n");
      }));
      if(canonicalJson(reconstructed)!==canonicalJson(input.scope))throw new Error("授权包含未声明或未规范化字段");
      }
      if((this.db.prepare("SELECT count(*) AS n FROM desktop_permission_changes").get() as {n:number}).n>=2048)throw new Error("授权变更历史已达到容量上限");
      // Scope validation uses the pinned package; new JSON cannot introduce actions.
      if (changesScope) this.authorization.parse({...current.row,scope_json:canonicalJson(input.scope)}, current.package);
      const at = new Date().toISOString();
      let revision = current.binding.revision;
      if (changesScope) {
        this.db.prepare("UPDATE scenario_authorizations SET scope_json=?,updated_at=? WHERE id=?").run(canonicalJson(input.scope),at,run.scopeRef);
        revision = this.authorization.pin(run.scopeRef,run.caseId,JSON.parse(current.binding.package_json),input.expectedScopeRevision).revision;
      }
      if (input.resolution) {
        // Operator feedback belongs to application composition, not the Core
        // lifecycle reducer. It is committed atomically with scope and resolution.
        const feedback = this.runtime!.execute({ runId: run.id, commandId: `permission-feedback:${input.commandId}`, expectedRevision: run.revision,
          command: { type: "issue_directive", directive: { id: `permission:${input.resolution.requestId}`, kind: "steer", targetWorkId: input.resolution.workId,
            instruction: `${input.resolution.approved ? "The user updated the authorization. Re-read the effective scope before acting." : "The user rejected the permission request. Continue within the unchanged scope or explain the remaining limitation."} User feedback: ${input.reason}`,
            rationale: "Explicit user permission decision", issuedBy: "operator" }, at } });
        this.runtime!.execute({ runId: run.id, commandId: `permission-resolution:${input.commandId}`, expectedRevision: feedback.state.revision,
          command: { type: "resolve_permission_request", workId: input.resolution.workId, requestId: input.resolution.requestId,
            approved: input.resolution.approved, reason: input.reason, at } });
      }
      const audit = { commandId:input.commandId,runId:run.id,scopeRef:run.scopeRef,reason:input.reason,previousScope:current.scope.payload,scope:input.scope,revision,at,automaticResume:!!input.resolution,
        ...(input.resolution ? { resolution: input.resolution } : {}) };
      this.db.prepare("INSERT INTO desktop_permission_changes VALUES(?,?,?,?)").run(conversationId,input.commandId,fingerprint,canonicalJson(audit));
      return {...audit,replayed:false};
    })();
  }
}
export function registerDesktopPermissionChange(app: FastifyInstance, control: DesktopPermissionChange) {
  const path = "/api/desktop/conversations/:conversationId/execution/:runId/permissions";
  app.get(path, async(request,reply) => { try { const p=request.params as {conversationId:string;runId:string}; return control.read(p.conversationId,p.runId); } catch(error) { return reply.code(409).send({error:(error as Error).message}); } });
  app.post(path,{bodyLimit:40000},async(request,reply) => { try { const p=request.params as {conversationId:string;runId:string}; const input=DesktopPermissionChangeSchema.parse(request.body); if(input.runId!==p.runId)throw new Error("任务标识不匹配"); return control.change(p.conversationId,input); } catch(error) {
    const parsed=DesktopPermissionChangeSchema.safeParse(request.body),p=request.params as {conversationId:string};
    return reply.code(409).send({error:(error as Error).message,notApplied:parsed.success&&!control.recorded(p.conversationId,parsed.data.commandId)});
  } });
}
