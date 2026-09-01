import type Database from "better-sqlite3";
import {
  IdempotencyConflictError,
  RevisionConflictError,
  type AppendEventsRequest,
  type AppendEventsResult,
  type RecordedCommand,
  type ScenarioEvent,
  type ScenarioEventStore,
  type ScenarioEventStream,
  type WorkerDescriptor,
  type WorkerStatus,
} from "@traceforge/orchestration-core";
import type { BlackboardChangeBus } from "@traceforge/cognitive-runtime";
import { historyRevision, readHistoryRows, readHistoryState } from "./db/scenario-history.js";

interface StreamRow { revision: number }
export interface ScenarioRunSummaryRow {
  runId: string;
  caseId: string;
  definitionKind: string;
  definitionVersion: number;
  scenarioPackage: { id: string; version: string; schemaRevision: number } | null;
  status: string;
  activePhaseId: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface ScenarioApprovalRow {
  id: string;
  runId: string;
  caseId: string;
  workId: string;
  actionKey: string;
  toolName: string;
  risk: string;
  rationale: string;
  inputRef: string;
  status: string;
  requestedByWorkerId: string;
  resolutionReason: string | null;
  createdAt: string;
  resolvedAt: string | null;
}
export interface ScenarioWorkLeaseRow {
  runId: string;
  workId: string;
  workerId: string;
  leaseId: string;
  leaseExpiresAt: string;
  updatedAt: string;
}
interface CommandRow { fingerprint: string; resulting_revision: number }
interface EventRow { payload_json: string }
interface WorkerRow {
  id: string;
  roles_json: string;
  capabilities_json: string;
  max_concurrent_work: number;
  status: WorkerStatus;
  heartbeat_at: string;
}

function parseEvents(rows: EventRow[]): ScenarioEvent[] {
  return rows.map((row) => JSON.parse(row.payload_json) as ScenarioEvent);
}

export class SqliteScenarioEventStore implements ScenarioEventStore {
  constructor(private readonly sqlite: Database.Database, private readonly changes?: BlackboardChangeBus) {}

  loadState(runId: string, through?: number) { return readHistoryState(this.sqlite, runId, through); }
  validateState(state: import("@traceforge/orchestration-core").ScenarioRunState) {
    if (Buffer.byteLength(JSON.stringify(state)) > 2 * 1024 * 1024) throw new Error("Run state capacity exceeded before commit");
  }
  revision(runId: string) { return historyRevision(this.sqlite, runId); }
  page(runId: string, after = 0, limit = 100, through?: number) { return readHistoryRows(this.sqlite, runId, after, limit, through); }
  recent(runId: string, limit: number): ScenarioEvent[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("Invalid recent event limit");
    return this.page(runId, Math.max(0, this.revision(runId) - limit), limit).map(row => JSON.parse(row.payload_json) as ScenarioEvent);
  }
  hasUsedLease(runId: string, leaseId: string): boolean {
    return !!this.sqlite.prepare("SELECT 1 FROM scenario_lease_history WHERE run_id=? AND lease_id=?").get(runId, leaseId)
      || !!this.sqlite.prepare(`SELECT 1 FROM scenario_events WHERE run_id=? AND event_type='work_claimed'
        AND json_extract(CASE WHEN json_valid(payload_json) THEN payload_json ELSE '{}' END,'$.leaseId')=? LIMIT 1`).get(runId, leaseId);
  }

  load(runId: string): ScenarioEventStream {
    const row = this.sqlite.prepare("SELECT revision FROM scenario_event_streams WHERE run_id = ?").get(runId) as StreamRow | undefined;
    if (!row) return { runId, revision: 0, events: [] };
    if (row.revision > 5000) throw new Error("Full event export budget exceeded; use event pages");
    const events: EventRow[] = []; let bytes = 0;
    for (let after = 0; after < row.revision;) {
      const page = this.page(runId, after, Math.min(1000, row.revision - after));
      if (!page.length || page[0]!.sequence !== after + 1) throw new Error("Run event sequence integrity mismatch");
      bytes += page.reduce((n, event) => n + Buffer.byteLength(event.payload_json), 0);
      if (bytes > 16 * 1024 * 1024) throw new Error("Full event export byte budget exceeded; use event pages");
      events.push(...page); after = page.at(-1)!.sequence;
    }
    return { runId, revision: row.revision, events: parseEvents(events) };
  }

  findCommand(runId: string, commandId: string): RecordedCommand | undefined {
    const command = this.sqlite.prepare(
      "SELECT fingerprint, resulting_revision FROM scenario_commands WHERE run_id = ? AND command_id = ?",
    ).get(runId, commandId) as CommandRow | undefined;
    if (!command) return undefined;
    const span = this.sqlite.prepare("SELECT min(sequence) first,count(*) n FROM scenario_events WHERE run_id=? AND command_id=?")
      .get(runId, commandId) as { first: number; n: number };
    if (!span.n || span.n > 1000 || span.first + span.n - 1 !== command.resulting_revision) throw new Error("Run command event range mismatch");
    const events = this.page(runId, span.first - 1, span.n);
    if (events.length !== span.n || events.some((event, index) => event.command_id !== commandId || event.event_index !== index)) throw new Error("Run command event identity mismatch");
    return {
      commandId,
      fingerprint: command.fingerprint,
      resultingRevision: command.resulting_revision,
      events: parseEvents(events),
    };
  }

  append(request: AppendEventsRequest): AppendEventsResult {
    if (request.events.length === 0) throw new Error(`Command ${request.commandId} emitted no events`);
    if (request.events.length > 1000 || Buffer.byteLength(JSON.stringify(request.events)) > 16 * 1024 * 1024) throw new Error("Run command event budget exceeded");
    const result = this.sqlite.transaction(() => {
      const existing = this.findCommand(request.runId, request.commandId);
      if (existing) {
        if (existing.fingerprint !== request.fingerprint) {
          throw new IdempotencyConflictError(request.runId, request.commandId);
        }
        return { resultingRevision: existing.resultingRevision, events: existing.events, idempotentReplay: true };
      }

      const stream = this.sqlite.prepare(
        "SELECT revision FROM scenario_event_streams WHERE run_id = ?",
      ).get(request.runId) as StreamRow | undefined;
      const actualRevision = stream?.revision ?? 0;
      if (actualRevision !== request.expectedRevision) {
        throw new RevisionConflictError(request.runId, request.expectedRevision, actualRevision);
      }
      const firstTimestamp = request.events[0].type === "run_started"
        ? request.events[0].state.createdAt
        : request.events[0].at;
      if (!stream) {
        const started = request.events[0];
        if (started.type !== "run_started") throw new Error(`New scenario stream ${request.runId} must begin with run_started`);
        this.sqlite.prepare(
          `INSERT INTO scenario_event_streams
            (run_id, case_id, definition_kind, definition_version, scenario_package_id, scenario_package_version,
             scenario_schema_revision, status, active_phase_id, revision, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        ).run(
          request.runId,
          started.state.caseId,
          started.state.definitionKind,
          started.state.definitionVersion,
          started.state.scenarioPackage?.id ?? null,
          started.state.scenarioPackage?.version ?? null,
          started.state.scenarioPackage?.schemaRevision ?? null,
          started.state.status,
          started.state.activePhaseId,
          firstTimestamp,
          firstTimestamp,
        );
      }

      const insertEvent = this.sqlite.prepare(
        "INSERT INTO scenario_events (run_id, sequence, command_id, event_index, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      request.events.forEach((event, index) => {
        const timestamp = event.type === "run_started" ? event.state.createdAt : event.at;
        insertEvent.run(
          request.runId,
          request.expectedRevision + index + 1,
          request.commandId,
          index,
          event.type,
          JSON.stringify(event),
          timestamp,
        );
        if (event.type === "work_claimed") this.sqlite.prepare("INSERT INTO scenario_lease_history VALUES (?,?,?)")
          .run(request.runId, event.leaseId, request.expectedRevision + index + 1);
        this.updateLeaseProjection(request.runId, event, timestamp);
        this.updateRunProjection(request.runId, event);
        this.updateApprovalProjection(request.runId, event, timestamp);
        this.updateToolInvocationBindingLifecycle(request.runId, event, timestamp);
      });
      const resultingRevision = request.expectedRevision + request.events.length;
      const lastEvent = request.events.at(-1)!;
      const updatedAt = lastEvent.type === "run_started" ? lastEvent.state.updatedAt : lastEvent.at;
      this.sqlite.prepare(
        "UPDATE scenario_event_streams SET revision = ?, updated_at = ? WHERE run_id = ? AND revision = ?",
      ).run(resultingRevision, updatedAt, request.runId, request.expectedRevision);
      this.sqlite.prepare(
        "INSERT INTO scenario_commands (run_id, command_id, fingerprint, resulting_revision, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(request.runId, request.commandId, request.fingerprint, resultingRevision, updatedAt);
      return { resultingRevision, events: request.events, idempotentReplay: false };
    })();
    if (!result.idempotentReplay) {
      const stream = this.sqlite.prepare("SELECT case_id FROM scenario_event_streams WHERE run_id = ?")
        .get(request.runId) as { case_id: string };
      const last = request.events.at(-1)!;
      this.changes?.publish({
        kind: "run",
        runId: request.runId,
        caseId: stream.case_id,
        revision: result.resultingRevision,
        eventTypes: request.events.map((event) => event.type),
        at: last.type === "run_started" ? last.state.updatedAt : last.at,
      });
    }
    return result;
  }

  listRuns(caseId?: string): ScenarioRunSummaryRow[] {
    const rows = (caseId
      ? this.sqlite.prepare(`
          SELECT run_id, case_id, definition_kind, definition_version, scenario_package_id, scenario_package_version,
                 scenario_schema_revision, status, active_phase_id, revision, created_at, updated_at
          FROM scenario_event_streams WHERE case_id = ? ORDER BY created_at DESC
        `).all(caseId)
      : this.sqlite.prepare(`
          SELECT run_id, case_id, definition_kind, definition_version, scenario_package_id, scenario_package_version,
                 scenario_schema_revision, status, active_phase_id, revision, created_at, updated_at
          FROM scenario_event_streams ORDER BY created_at DESC
        `).all()) as Array<{
          run_id: string;
          case_id: string;
          definition_kind: string;
          definition_version: number;
          scenario_package_id: string | null;
          scenario_package_version: string | null;
          scenario_schema_revision: number | null;
          status: string;
          active_phase_id: string;
          revision: number;
          created_at: string;
          updated_at: string;
        }>;
    return rows.map((row) => ({
      runId: row.run_id,
      caseId: row.case_id,
      definitionKind: row.definition_kind,
      definitionVersion: row.definition_version,
      scenarioPackage: row.scenario_package_id && row.scenario_package_version && row.scenario_schema_revision !== null
        ? { id: row.scenario_package_id, version: row.scenario_package_version, schemaRevision: row.scenario_schema_revision }
        : null,
      status: row.status,
      activePhaseId: row.active_phase_id,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  listApprovals(filter: { caseId?: string; status?: string } = {}): ScenarioApprovalRow[] {
    const clauses: string[] = [];
    const parameters: string[] = [];
    if (filter.caseId) { clauses.push("case_id = ?"); parameters.push(filter.caseId); }
    if (filter.status) { clauses.push("status = ?"); parameters.push(filter.status); }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.sqlite.prepare(`
      SELECT id, run_id, case_id, work_id, action_key, tool_name, risk, rationale, input_ref,
             status, requested_by_worker_id, resolution_reason, created_at, resolved_at
      FROM scenario_work_approvals${where} ORDER BY created_at ASC
    `).all(...parameters) as Array<{
      id: string; run_id: string; case_id: string; work_id: string; action_key: string; tool_name: string;
      risk: string; rationale: string; input_ref: string; status: string; requested_by_worker_id: string;
      resolution_reason: string | null; created_at: string; resolved_at: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      caseId: row.case_id,
      workId: row.work_id,
      actionKey: row.action_key,
      toolName: row.tool_name,
      risk: row.risk,
      rationale: row.rationale,
      inputRef: row.input_ref,
      status: row.status,
      requestedByWorkerId: row.requested_by_worker_id,
      resolutionReason: row.resolution_reason,
      createdAt: row.created_at,
      resolvedAt: row.resolved_at,
    }));
  }

  private updateApprovalProjection(runId: string, event: ScenarioEvent, at: string): void {
    if (event.type === "work_approval_requested") {
      const stream = this.sqlite.prepare("SELECT case_id FROM scenario_event_streams WHERE run_id = ?")
        .get(runId) as { case_id: string } | undefined;
      if (!stream) throw new Error(`Approval ${event.approval.id} references missing run ${runId}`);
      const approval = event.approval;
      this.sqlite.prepare(`
        INSERT INTO scenario_work_approvals
          (id, run_id, case_id, work_id, action_key, tool_name, risk, rationale, input_ref, status,
           requested_by_worker_id, resolution_reason, created_at, resolved_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)
      `).run(
        approval.id, runId, stream.case_id, approval.workId, approval.actionKey, approval.toolName,
        approval.risk, approval.rationale, approval.inputRef, approval.status, approval.requestedByWorkerId, at,
      );
      return;
    }
    if (event.type === "work_approval_resolved") {
      const result = this.sqlite.prepare(`
        UPDATE scenario_work_approvals SET status = ?, resolution_reason = ?, resolved_at = ?
        WHERE id = ? AND run_id = ? AND work_id = ? AND status = 'pending'
      `).run(event.approved ? "approved" : "rejected", event.reason, at, event.approvalId, runId, event.workId);
      if (result.changes !== 1) throw new Error(`Cannot resolve missing approval ${event.approvalId}`);
      return;
    }
    if (event.type === "work_cancelled") {
      this.sqlite.prepare(`
        UPDATE scenario_work_approvals SET status = 'cancelled', resolution_reason = ?, resolved_at = ?
        WHERE run_id = ? AND work_id = ? AND status = 'pending'
      `).run(event.reason, at, runId, event.workId);
      return;
    }
    if (event.type === "run_cancelled") {
      this.sqlite.prepare(`
        UPDATE scenario_work_approvals SET status = 'cancelled', resolution_reason = ?, resolved_at = ?
        WHERE run_id = ? AND status = 'pending'
      `).run(event.reason, at, runId);
    }
  }

  private updateRunProjection(runId: string, event: ScenarioEvent): void {
    switch (event.type) {
      case "run_package_migrated":
        this.sqlite.prepare("UPDATE scenario_event_streams SET scenario_package_id=?,scenario_package_version=?,scenario_schema_revision=?,definition_version=? WHERE run_id=?")
          .run(event.to.id,event.to.version,event.to.schemaRevision,event.toDefinitionVersion,runId);
        return;
      case "phase_advanced":
        this.sqlite.prepare("UPDATE scenario_event_streams SET active_phase_id = ? WHERE run_id = ?").run(event.to, runId);
        return;
      case "run_completed":
        this.sqlite.prepare("UPDATE scenario_event_streams SET status = 'completed' WHERE run_id = ?").run(runId);
        return;
      case "run_paused":
        this.sqlite.prepare("UPDATE scenario_event_streams SET status = 'paused' WHERE run_id = ?").run(runId);
        return;
      case "run_resumed":
        this.sqlite.prepare("UPDATE scenario_event_streams SET status = 'running' WHERE run_id = ?").run(runId);
        return;
      case "run_cancelled":
        this.sqlite.prepare("UPDATE scenario_event_streams SET status = 'cancelled' WHERE run_id = ?").run(runId);
    }
  }

  private updateLeaseProjection(runId: string, event: ScenarioEvent, at: string): void {
    if (event.type === "work_claimed") {
      this.sqlite.prepare(`
        INSERT INTO scenario_work_leases (run_id, work_id, worker_id, lease_id, lease_expires_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(runId, event.workId, event.workerId, event.leaseId, event.leaseExpiresAt, at);
      return;
    }
    if (event.type === "work_lease_renewed") {
      const result = this.sqlite.prepare(`
        UPDATE scenario_work_leases SET lease_expires_at = ?, updated_at = ?
        WHERE run_id = ? AND work_id = ? AND lease_id = ?
      `).run(event.leaseExpiresAt, at, runId, event.workId, event.leaseId);
      if (result.changes !== 1) throw new Error(`Cannot renew missing lease ${event.leaseId}`);
      return;
    }
    switch (event.type) {
      case "work_completed":
      case "work_failed":
      case "work_blocked":
      case "work_requeued":
      case "work_approval_requested":
        this.sqlite.prepare(
          "DELETE FROM scenario_work_leases WHERE run_id = ? AND work_id = ?",
        ).run(runId, event.workId);
        return;
      case "work_cancelled":
        this.sqlite.prepare(
          "DELETE FROM scenario_work_leases WHERE run_id = ? AND work_id = ?",
        ).run(runId, event.workId);
        return;
      case "run_cancelled":
      case "run_completed":
      case "run_paused":
        this.sqlite.prepare("DELETE FROM scenario_work_leases WHERE run_id = ?").run(runId);
    }
  }

  private updateToolInvocationBindingLifecycle(runId: string, event: ScenarioEvent, at: string): void {
    let workId: string | undefined;
    let reason: string | undefined;
    switch (event.type) {
      case "work_completed":
        workId = event.workId;
        reason = "Work completed before the Tool Invocation produced a terminal receipt";
        break;
      case "work_failed":
        workId = event.workId;
        reason = "Work failed before the Tool Invocation produced a terminal receipt";
        break;
      case "work_blocked":
        workId = event.workId;
        reason = "Work became blocked before the Tool Invocation produced a terminal receipt";
        break;
      case "work_cancelled":
        workId = event.workId;
        reason = "Work was cancelled before the Tool Invocation produced a terminal receipt";
        break;
      case "run_completed":
        reason = "Run completed before the Tool Invocation produced a terminal receipt";
        break;
      case "run_cancelled":
        reason = "Run was cancelled before the Tool Invocation produced a terminal receipt";
        break;
      default:
        return;
    }
    const scope = workId ? "run_id = ? AND work_id = ?" : "run_id = ?";
    const parameters = workId ? [reason, at, runId, workId] : [reason, at, runId];
    this.sqlite.prepare(`
      UPDATE tool_invocation_bindings
      SET status = 'released', release_reason = ?, updated_at = ?
      WHERE ${scope} AND status = 'prepared'
    `).run(...parameters);
  }
}

export class SqliteWorkerRegistry {
  constructor(private readonly sqlite: Database.Database) {}

  upsert(worker: WorkerDescriptor, updatedAt: string): void {
    if (!worker.id.trim() || worker.roles.length === 0 || worker.maxConcurrentWork < 1) {
      throw new Error("Worker id, roles, and positive capacity are required");
    }
    this.sqlite.prepare(`
      INSERT INTO scenario_workers (id, roles_json, capabilities_json, max_concurrent_work, status, heartbeat_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        roles_json = excluded.roles_json,
        capabilities_json = excluded.capabilities_json,
        max_concurrent_work = excluded.max_concurrent_work,
        status = excluded.status,
        heartbeat_at = excluded.heartbeat_at,
        updated_at = excluded.updated_at
    `).run(
      worker.id,
      JSON.stringify([...new Set(worker.roles)].sort()),
      JSON.stringify([...new Set(worker.capabilities)].sort()),
      worker.maxConcurrentWork,
      worker.status,
      worker.heartbeatAt,
      updatedAt,
    );
  }

  heartbeat(workerId: string, at: string): void {
    const result = this.sqlite.prepare(
      "UPDATE scenario_workers SET heartbeat_at = ?, updated_at = ? WHERE id = ?",
    ).run(at, at, workerId);
    if (result.changes !== 1) throw new Error(`Unknown worker ${workerId}`);
  }

  setStatus(workerId: string, status: WorkerStatus, at: string): void {
    const result = this.sqlite.prepare(
      "UPDATE scenario_workers SET status = ?, updated_at = ? WHERE id = ?",
    ).run(status, at, workerId);
    if (result.changes !== 1) throw new Error(`Unknown worker ${workerId}`);
  }

  list(): WorkerDescriptor[] {
    const rows = this.sqlite.prepare(
      "SELECT id, roles_json, capabilities_json, max_concurrent_work, status, heartbeat_at FROM scenario_workers ORDER BY id",
    ).all() as WorkerRow[];
    return rows.map((row) => ({
      id: row.id,
      roles: JSON.parse(row.roles_json) as WorkerDescriptor["roles"],
      capabilities: JSON.parse(row.capabilities_json) as string[],
      maxConcurrentWork: row.max_concurrent_work,
      status: row.status,
      heartbeatAt: row.heartbeat_at,
    }));
  }

  activeWorkCounts(): Record<string, number> {
    const rows = this.sqlite.prepare(
      "SELECT worker_id, COUNT(*) AS count FROM scenario_work_leases GROUP BY worker_id",
    ).all() as Array<{ worker_id: string; count: number }>;
    return Object.fromEntries(rows.map((row) => [row.worker_id, row.count]));
  }

  listLeases(runId?: string): ScenarioWorkLeaseRow[] {
    const rows = (runId
      ? this.sqlite.prepare(`
          SELECT run_id, work_id, worker_id, lease_id, lease_expires_at, updated_at
          FROM scenario_work_leases WHERE run_id = ? ORDER BY updated_at ASC, work_id ASC
        `).all(runId)
      : this.sqlite.prepare(`
          SELECT run_id, work_id, worker_id, lease_id, lease_expires_at, updated_at
          FROM scenario_work_leases ORDER BY updated_at ASC, work_id ASC
        `).all()) as Array<{
          run_id: string; work_id: string; worker_id: string; lease_id: string;
          lease_expires_at: string; updated_at: string;
        }>;
    return rows.map((row) => ({
      runId: row.run_id,
      workId: row.work_id,
      workerId: row.worker_id,
      leaseId: row.lease_id,
      leaseExpiresAt: row.lease_expires_at,
      updatedAt: row.updated_at,
    }));
  }
}
