import type Database from "better-sqlite3";
import { readHistoryRows } from "./db/scenario-history.js";
import type { ScenarioEvent } from "@traceforge/orchestration-core";
import type { ScenarioAgentEventDraft } from "@traceforge/shared";
import { AgentEventReadError, type SqliteScenarioAgentEventStream } from "./scenario-agent-event-stream.js";
import { readExecutionRow } from "./db/execution-archive.js";

type Identity = { caseId: string; runId: string; workId: string | null };
type Source = "compaction" | "contextSnapshot" | "invocation" | "reconciliation" | "recoveryCommand" | "executionOccupancy" | "processOccupancy";

/** Read existing durable sources; never owns a Worker, authorization command or tool port.
 * Projection can lag/fail independently of cancellation. Source rows are never deleted here.
 */
export class AgentAuditProjection {
  private health: { status: "pending" | "current_pass_completed" | "delayed"; lastPassAt: string | null; error: string | null } = {status:"pending",lastPassAt:null,error:null};
  constructor(private readonly sqlite: Database.Database, private readonly events: SqliteScenarioAgentEventStream) {}

  status() { return {...this.health, consistency:"eventual" as const}; }

  markDelayed(): void { this.health = {...this.health,status:"delayed",error:"Audit projection unavailable; use durable source records"}; }

  synchronize(): number {
    try {
      const written = this.reconcile();
      this.health = {status:written>=100 ? "pending" : "current_pass_completed",lastPassAt:new Date().toISOString(),error:null};
      return written;
    } catch (error) {
      this.health = {...this.health,status:"delayed",error:"Audit projection unavailable; use durable source records"};
      throw error;
    }
  }

  reconcile(limit = 100): number {
    if (!Number.isSafeInteger(limit) || limit<1 || limit>1000) throw new Error("Invalid audit reconciliation bound");
    let written = this.controls(limit);
    if(this.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name='process_execution_occupancy'").get()){
      const rows=this.sqlite.prepare(`SELECT p.id,p.identity_json,p.state,p.created_at FROM process_execution_occupancy p
        JOIN scenario_event_streams r ON r.run_id=json_extract(p.identity_json,'$.attribution.runId') AND r.case_id=json_extract(p.identity_json,'$.attribution.caseId')
        WHERE json_extract(p.identity_json,'$.kind')='work' AND NOT EXISTS(SELECT 1 FROM scenario_agent_fact_projections f WHERE f.source_key='processOccupancy:'||p.id||':'||p.state)
        ORDER BY p.id LIMIT ?`).all(limit) as {id:string;identity_json:string;state:string;created_at:string}[];
      for(const row of rows){const saved=JSON.parse(row.identity_json);written+=this.fact("processOccupancy",row.id,row.state,
        {caseId:saved.attribution.caseId,runId:saved.attribution.runId,workId:saved.attribution.workId},null,"observed_state");}
    }
    if(this.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='managed_execution_occupancy'").get()) {
      const rows=this.sqlite.prepare(`SELECT idempotency_key,identity_json,state,updated_at FROM managed_execution_occupancy o WHERE NOT EXISTS
        (SELECT 1 FROM scenario_agent_fact_projections p WHERE p.source_key='executionOccupancy:'||o.idempotency_key||':'||o.state)
        ORDER BY o.idempotency_key LIMIT ?`).all(limit) as Array<{idempotency_key:string;identity_json:string;state:string;updated_at:string}>;
      for(const row of rows){const identity=JSON.parse(row.identity_json).scheduling;
        written+=this.fact("executionOccupancy",row.idempotency_key,row.state,{caseId:identity.caseId,runId:identity.runId,workId:identity.workId},row.updated_at,"observed_state");}
    }
    if (this.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='context_compactions'").get()) {
      const rows = this.sqlite.prepare(`SELECT id,status,identity_json FROM context_compactions c WHERE NOT EXISTS
        (SELECT 1 FROM scenario_agent_fact_projections p WHERE p.source_key='compaction:'||c.id||':'||c.status) ORDER BY c.id LIMIT ?`)
        .all(limit) as Array<{ id: string; status: string; identity_json: string }>;
      for (const row of rows) {
        const identity = JSON.parse(row.identity_json) as Identity;
        // Compaction is cached per role/context, not owned by one model Turn or Work.
        written += this.fact("compaction",row.id,row.status,{caseId:identity.caseId,runId:identity.runId,workId:null},null,"durable_fact");
      }
    }
    const snapshots = this.sqlite.prepare(`SELECT id,case_id,run_id,work_id,created_at,context_manifest_json FROM scenario_cognitive_snapshots c
      WHERE json_extract(context_manifest_json,'$.contextCompaction.id') IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM scenario_agent_fact_projections p WHERE p.source_key='contextSnapshot:'||c.id||':'||json_extract(c.context_manifest_json,'$.contextCompaction.status'))
      ORDER BY c.id LIMIT ?`).all(limit) as Array<{id:string;case_id:string;run_id:string;work_id:string|null;created_at:string;context_manifest_json:string}>;
    for (const row of snapshots) written += this.fact("contextSnapshot",row.id,JSON.parse(row.context_manifest_json).contextCompaction.status,
      {caseId:row.case_id,runId:row.run_id,workId:row.work_id},row.created_at,"durable_fact");
    const invocations = this.sqlite.prepare(`SELECT b.idempotency_key,b.case_id,b.run_id,b.work_id,e.status,e.updated_at
      FROM tool_invocation_bindings b JOIN tool_invocation_executions e USING(idempotency_key)
      WHERE e.status='uncertain' AND NOT EXISTS(SELECT 1 FROM scenario_agent_fact_projections p
        WHERE p.source_key='invocation:'||b.idempotency_key||':uncertain') ORDER BY b.idempotency_key LIMIT ?`)
      .all(limit) as Array<{ idempotency_key: string; case_id: string; run_id: string; work_id: string; status: string; updated_at: string }>;
    for (const row of invocations) written += this.fact("invocation",row.idempotency_key,row.status,
      {caseId:row.case_id,runId:row.run_id,workId:row.work_id},row.updated_at,"observed_state");

    const reconciliations = this.sqlite.prepare(`SELECT a.command_id,a.outcome,a.requested_resolution,a.created_at,b.case_id,b.run_id,b.work_id
      FROM tool_invocation_reconciliation_audits a JOIN tool_invocation_bindings b USING(idempotency_key)
      WHERE NOT EXISTS(SELECT 1 FROM scenario_agent_fact_projections p WHERE p.source_key='reconciliation:'||a.command_id||':'||a.outcome||':'||a.requested_resolution)
      ORDER BY a.command_id LIMIT ?`).all(limit) as Array<{ command_id: string; outcome: string; requested_resolution: string; created_at: string; case_id: string; run_id: string; work_id: string }>;
    for (const row of reconciliations) written += this.fact("reconciliation",row.command_id,`${row.outcome}:${row.requested_resolution}`,
      {caseId:row.case_id,runId:row.run_id,workId:row.work_id},row.created_at,"durable_fact");

    const commands = this.sqlite.prepare(`SELECT c.command_id,c.created_at,b.case_id,b.run_id,b.work_id FROM tool_recovery_commands c
      JOIN tool_invocation_bindings b USING(idempotency_key) WHERE NOT EXISTS(SELECT 1 FROM scenario_agent_fact_projections p
        WHERE p.source_key='recoveryCommand:'||c.command_id||':registered') ORDER BY c.command_id LIMIT ?`)
      .all(limit) as Array<{ command_id: string; created_at: string; case_id: string; run_id: string; work_id: string }>;
    for (const row of commands) written += this.fact("recoveryCommand",row.command_id,"registered",
      {caseId:row.case_id,runId:row.run_id,workId:row.work_id},row.created_at,"durable_fact");
    return written;
  }

  /** Minimal referenced metadata only: never prompt text, summary bodies, credentials or execution. */
  read(caseId: string, runId: string, source: Source, sourceId: string) {
    let identity: Identity | undefined;
    let state: Record<string, unknown> | undefined;
    if(source==="processOccupancy") {
      const row=this.sqlite.prepare("SELECT identity_json,state,request_id,proof_ref FROM process_execution_occupancy WHERE id=?").get(sourceId) as
        {identity_json:string;state:string;request_id:string|null;proof_ref:string|null}|undefined;
      if(row){const saved=JSON.parse(row.identity_json);identity={caseId:saved.attribution.caseId,runId:saved.attribution.runId,workId:saved.attribution.workId};
        state={status:row.state,source:saved.source,version:saved.version,operation:saved.operation,ownership:saved.kind,requestId:row.request_id,proofRef:row.proof_ref};}
    } else if(source==="executionOccupancy") {
      const row=this.sqlite.prepare("SELECT identity_json,state,request_id,proof_ref,updated_at FROM managed_execution_occupancy WHERE idempotency_key=?").get(sourceId) as
        {identity_json:string;state:string;request_id:string|null;proof_ref:string|null;updated_at:string}|undefined;
      if(row){const saved=JSON.parse(row.identity_json).scheduling;identity={caseId:saved.caseId,runId:saved.runId,workId:saved.workId};
        state={status:row.state,providerId:saved.providerId,providerVersion:saved.providerVersion,requestId:row.request_id,proofRef:row.proof_ref,updatedAt:row.updated_at};}
    } else if (source === "compaction") {
      const row = this.sqlite.prepare("SELECT identity_json,status FROM context_compactions WHERE id=?").get(sourceId) as { identity_json: string; status: string } | undefined;
      if (row) {
        const record = JSON.parse(row.identity_json);
        identity = { caseId:record.caseId,runId:record.runId,workId:null };
        state = { status:row.status,consumer:record.consumer,inputFingerprint:record.inputFingerprint,
          protectedFingerprint:record.protectedFingerprint,sourceFingerprint:record.sourceFingerprint,
          compactorVersion:record.compactorVersion,sourceIds:record.sourceIds,semanticQualityVerified:false };
      }
    } else if (source === "contextSnapshot") {
      const row = this.sqlite.prepare("SELECT case_id,run_id,work_id,consumer,context_manifest_json FROM scenario_cognitive_snapshots WHERE id=?").get(sourceId) as
        {case_id:string;run_id:string;work_id:string|null;consumer:string;context_manifest_json:string} | undefined;
      if (row) {
        identity = {caseId:row.case_id,runId:row.run_id,workId:row.work_id};
        const manifest = JSON.parse(row.context_manifest_json).contextCompaction;
        if (manifest?.id) state = {consumer:row.consumer,compactionId:manifest.id,status:manifest.status,
          inputFingerprint:manifest.inputFingerprint,outputFingerprint:manifest.outputFingerprint,sourceFingerprint:manifest.sourceFingerprint,
          compactorVersion:manifest.compactorVersion,semanticQualityVerified:false};
      }
    } else {
      const saved = source === "invocation" ? undefined : readExecutionRow<Record<string,unknown>>(this.sqlite,source === "reconciliation" ? "reconciliation" : "command",sourceId);
      const key = source === "invocation" ? sourceId : saved?.idempotency_key as string | undefined;
      const binding = key ? this.sqlite.prepare("SELECT case_id,run_id,work_id,invocation_id FROM tool_invocation_bindings WHERE idempotency_key=?").get(key) as
        { case_id: string; run_id: string; work_id: string; invocation_id: string } | undefined : undefined;
      if (binding) {
        identity = {caseId:binding.case_id,runId:binding.run_id,workId:binding.work_id};
        if (source === "invocation") state = this.sqlite.prepare("SELECT status,owner_id AS ownerId,lease_id AS leaseId,updated_at AS updatedAt FROM tool_invocation_executions WHERE idempotency_key=?").get(key) as Record<string,unknown> | undefined;
        else if (source === "reconciliation") state = {outcome:saved!.outcome,requestedResolution:saved!.requested_resolution,
          authorizationDecision:saved!.authorization_decision,evidenceFingerprint:saved!.evidence_fingerprint,createdAt:saved!.created_at};
        else state = { status:"registered" };
      }
    }
    if (!identity || !state) throw new AgentEventReadError("unknown_reference","Unknown audit reference",404);
    if (identity.caseId!==caseId || identity.runId!==runId) throw new AgentEventReadError("scope_mismatch","Audit reference belongs to another Case/Run");
    return { source,sourceId,...identity,state,readOnly:true,automaticRetryAllowed:false };
  }

  private fact(source: Source, sourceId: string, state: string, identity: Identity, at: string | null, semantics: "durable_fact" | "observed_state"): number {
    const key = `${source}:${sourceId}:${state}`;
    const base = { ...identity,turnId:`audit:${key}`,role:"system" as const,...(at ? {createdAt:at} : {}) };
    return Number(this.events.appendFact(key,[
      { ...base,method:"turn/started",params:{agentInstanceId:"audit-projector",sourceRunRevision:0,sourceGraphRevision:null} },
      { ...base,method:"item/completed",params:{item:{type:"controlChange",id:key,status:"completed",eventType:`audit/${source}`,
        summary:`Recorded ${source} ${state}; this is not a tool execution or cleanup confirmation`,refs:[`agent-audit:${key}`],
        audit:{version:1,source,sourceId,state,semantics,automaticRetryAllowed:false}}} },
      { ...base,method:"turn/completed",params:{status:"completed",outcome:null,checkpointRef:null,error:null} },
    ]));
  }

  controls(limit = 100): number {
    const rows = this.sqlite.prepare(`SELECT e.run_id,e.sequence,e.payload_json,s.case_id FROM scenario_events e
      JOIN scenario_event_streams s USING(run_id)
      WHERE e.event_type IN ('run_started','work_completed','work_failed','work_requeued','work_blocked','work_cancelled',
        'directive_issued','phase_advanced','run_completed','run_paused','run_resumed','run_cancelled','run_package_migrated')
      AND NOT EXISTS(SELECT 1 FROM scenario_agent_protocol_events p WHERE p.run_id=e.run_id
        AND p.turn_id='control:'||e.run_id||':'||e.sequence AND p.method='turn/completed')
      ORDER BY e.run_id,e.sequence LIMIT ?`).all(limit) as Array<{run_id:string;sequence:number;payload_json:string;case_id:string}>;
    let written = 0;
    for (const row of rows) {
      const event = JSON.parse(readHistoryRows(this.sqlite, row.run_id, row.sequence - 1, 1)[0]!.payload_json) as ScenarioEvent;
      const control = controlDescription(event);
      if (!control) continue;
      const turnId = `control:${row.run_id}:${row.sequence}`;
      const base = {runId:row.run_id,caseId:row.case_id,workId:control.workId,turnId,role:"system" as const,
        createdAt:event.type==="run_started" ? event.state.updatedAt : event.at};
      const drafts: ScenarioAgentEventDraft[] = [
        {...base,method:"turn/started",params:{agentInstanceId:"scenario-control-plane",sourceRunRevision:row.sequence,sourceGraphRevision:null}},
        {...base,method:"item/completed",params:{item:{type:"controlChange",id:`${row.run_id}:${row.sequence}`,status:"completed",eventType:event.type,summary:control.summary,refs:control.refs}}},
        {...base,method:"turn/completed",params:{status:event.type.includes("cancelled") ? "cancelled" : event.type==="work_failed" ? "failed" : "completed",
          outcome:event.type==="work_blocked" ? "blocked" : event.type==="work_completed" || event.type==="run_completed" ? "finish" : "continue",
          checkpointRef:null,error:event.type==="work_failed" ? event.error : null}},
      ];
      // Complete pre-upgrade partial batches without replaying their already durable prefix.
      const missing = drafts.filter((draft) => !this.sqlite.prepare("SELECT 1 FROM scenario_agent_protocol_events WHERE run_id=? AND turn_id=? AND method=?")
        .get(row.run_id,turnId,draft.method));
      if (missing.length) written += Number(this.events.appendFact(turnId,missing));
    }
    return written;
  }
}

function controlDescription(event: ScenarioEvent): {workId:string|null;summary:string;refs:string[]} | null {
  if(event.type==="run_package_migrated")return {workId:null,summary:`Package migrated from ${event.from.version} to ${event.to.version}: ${event.reason}`,refs:[event.migrationRef]};
  if (event.type==="run_started") return {workId:null,summary:`Run started: ${event.state.goal}`,refs:[]};
  if (event.type==="work_completed") return {workId:event.workId,summary:event.summary,refs:event.outputs.flatMap((output) => output.refs)};
  if (event.type==="work_failed") return {workId:event.workId,summary:event.error,refs:[]};
  if (event.type==="work_requeued" || event.type==="work_blocked" || event.type==="work_cancelled") return {workId:event.workId,summary:event.reason,refs:[]};
  if (event.type==="directive_issued") return {workId:event.directive.targetWorkId,summary:event.directive.instruction,refs:[`run-directive:${event.directive.id}`]};
  if (event.type==="phase_advanced") return {workId:null,summary:`Phase advanced from ${event.from} to ${event.to}`,refs:[]};
  if (event.type==="run_completed") return {workId:null,summary:"Run completed",refs:[]};
  if (event.type==="run_paused" || event.type==="run_resumed" || event.type==="run_cancelled") return {workId:null,summary:event.reason,refs:[]};
  return null;
}
