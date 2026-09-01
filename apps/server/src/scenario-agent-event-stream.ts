import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AgentEventCursorSchema, AgentEventProtocolError, decodeScenarioAgentEvent, type ScenarioAgentEvent, type ScenarioAgentEventDraft } from "@traceforge/shared";
import { canonicalJson } from "@traceforge/orchestration-core";
import type { AgentAuditProjection } from "./agent-audit-projection.js";

export interface ScenarioAgentEventWriter {
  append(event: ScenarioAgentEventDraft): ScenarioAgentEvent | void;
}

interface EventRow { event_json: string; run_id: string; sequence: number; id: string; case_id: string; work_id: string | null; turn_id: string; role: string; method: string; item_id: string | null; created_at:string }

export class AgentEventReadError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 409) { super(message); }
}

export class SqliteScenarioAgentEventStream implements ScenarioAgentEventWriter {
  private readonly subscribers = new Set<(event: ScenarioAgentEvent) => void>();

  constructor(
    private readonly sqlite: Database.Database,
    private readonly publish?: (event: ScenarioAgentEvent) => void,
    private readonly createId: () => string = randomUUID,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    // Adopt old rows without truncation. Admission only limits new records.
    sqlite.exec(`CREATE TABLE IF NOT EXISTS scenario_agent_event_policy (
      id INTEGER PRIMARY KEY CHECK(id=1), maximum_records INTEGER NOT NULL CHECK(maximum_records>0),
      maximum_bytes INTEGER NOT NULL CHECK(maximum_bytes>0), maximum_event_bytes INTEGER NOT NULL CHECK(maximum_event_bytes>0));
      INSERT OR IGNORE INTO scenario_agent_event_policy VALUES (1,200000,268435456,131072);
      CREATE TABLE IF NOT EXISTS scenario_agent_event_usage (id INTEGER PRIMARY KEY CHECK(id=1), records INTEGER NOT NULL, bytes INTEGER NOT NULL);
      INSERT OR IGNORE INTO scenario_agent_event_usage SELECT 1,count(*),coalesce(sum(length(CAST(event_json AS BLOB))),0) FROM scenario_agent_protocol_events;
      CREATE TABLE IF NOT EXISTS scenario_agent_fact_projections (source_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS agent_event_admit BEFORE INSERT ON scenario_agent_protocol_events BEGIN
        SELECT CASE WHEN EXISTS(SELECT 1 FROM scenario_agent_event_usage u JOIN scenario_agent_event_policy p USING(id)
          WHERE u.records>=p.maximum_records OR u.bytes+length(CAST(NEW.event_json AS BLOB))>p.maximum_bytes
          OR length(CAST(NEW.event_json AS BLOB))>p.maximum_event_bytes)
          THEN RAISE(ABORT,'Agent event capacity exhausted') END;
        SELECT execution_physical_admit(recovery_floor,maximum_database_bytes,maximum_wal_bytes,
          length(CAST(NEW.event_json AS BLOB)),'recovery') FROM execution_physical_policy WHERE id=1;
      END;
      CREATE TRIGGER IF NOT EXISTS agent_event_account AFTER INSERT ON scenario_agent_protocol_events BEGIN
        UPDATE scenario_agent_event_usage SET records=records+1,bytes=bytes+length(CAST(NEW.event_json AS BLOB)) WHERE id=1;
      END;
      CREATE TRIGGER IF NOT EXISTS agent_event_keep BEFORE DELETE ON scenario_agent_protocol_events BEGIN SELECT RAISE(ABORT,'Agent events are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS agent_event_immutable BEFORE UPDATE ON scenario_agent_protocol_events BEGIN SELECT RAISE(ABORT,'Agent events are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS agent_fact_keep BEFORE DELETE ON scenario_agent_fact_projections BEGIN SELECT RAISE(ABORT,'Agent fact identities are permanent'); END;
      CREATE TRIGGER IF NOT EXISTS agent_fact_immutable BEFORE UPDATE ON scenario_agent_fact_projections BEGIN SELECT RAISE(ABORT,'Agent fact identities are permanent'); END;`);
    sqlite.exec("CREATE INDEX IF NOT EXISTS scenario_agent_turn_method ON scenario_agent_protocol_events(run_id,turn_id,method)");
  }

  append(draft: ScenarioAgentEventDraft): ScenarioAgentEvent {
    const event = this.sqlite.transaction(() => this.insert(draft))();
    this.notify(event);
    return event;
  }

  /** The source marker and all events commit together; retries never repeat publication. */
  appendFact(sourceKey: string, drafts: ScenarioAgentEventDraft[]): boolean {
    if (!sourceKey || Buffer.byteLength(sourceKey)>4096 || drafts.length<1 || drafts.length>8) throw new Error("Invalid Agent fact batch");
    const fingerprint = createHash("sha256").update(canonicalJson(drafts)).digest("hex");
    const events = this.sqlite.transaction(() => {
      const previous = this.sqlite.prepare("SELECT fingerprint FROM scenario_agent_fact_projections WHERE source_key=?").get(sourceKey) as { fingerprint: string } | undefined;
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new AgentEventReadError("fact_conflict", "Audit source identity changed");
        return [];
      }
      const values = drafts.map((draft) => this.insert(draft));
      this.sqlite.prepare("INSERT INTO scenario_agent_fact_projections VALUES (?,?)").run(sourceKey,fingerprint);
      return values;
    })();
    events.forEach((event) => this.notify(event));
    return events.length>0;
  }

  private insert(draft: ScenarioAgentEventDraft): ScenarioAgentEvent {
      const owner = this.sqlite.prepare(`SELECT case_id FROM scenario_event_streams WHERE run_id=?
        UNION ALL SELECT case_id FROM scenario_agent_protocol_events WHERE run_id=? LIMIT 1`).get(draft.runId,draft.runId) as { case_id: string } | undefined;
      if (owner && owner.case_id !== draft.caseId) throw new AgentEventReadError("scope_mismatch", "Agent event Case does not own this Run");
      const turn = this.sqlite.prepare("SELECT work_id,role FROM scenario_agent_protocol_events WHERE run_id=? AND turn_id=? LIMIT 1")
        .get(draft.runId,draft.turnId) as {work_id:string|null;role:string} | undefined;
      if (turn && (turn.work_id!==draft.workId || turn.role!==draft.role)) throw new AgentEventReadError("scope_mismatch","Agent Turn ownership changed");
      this.sqlite.prepare(`
        INSERT INTO scenario_agent_event_streams (run_id, last_sequence) VALUES (?, 0)
        ON CONFLICT(run_id) DO NOTHING
      `).run(draft.runId);
      const stream = this.sqlite.prepare("SELECT last_sequence FROM scenario_agent_event_streams WHERE run_id = ?")
        .get(draft.runId) as { last_sequence: number };
      const value = decodeScenarioAgentEvent({
        ...draft,
        protocolVersion: 2,
        id: this.createId(),
        sequence: stream.last_sequence + 1,
        createdAt: draft.createdAt ?? this.now(),
      });
      if ("item" in value.params) {
        const item = this.sqlite.prepare("SELECT * FROM scenario_agent_protocol_events WHERE run_id=? AND turn_id=? AND item_id=? LIMIT 1").get(value.runId,value.turnId,value.params.item.id) as EventRow | undefined;
        if (item) {
          const previous = this.decodeRow(item);
          if (previous.turnId!==value.turnId || !("item" in previous.params) || previous.params.item.type!==value.params.item.type) {
            throw new AgentEventReadError("scope_mismatch","Agent Item ownership or type changed");
          }
        }
      }
      this.sqlite.prepare(`
        INSERT INTO scenario_agent_protocol_events (run_id, sequence, id, case_id, work_id, turn_id, role, method, item_id, event_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        value.runId, value.sequence, value.id, value.caseId, value.workId, value.turnId, value.role, value.method,
        "item" in value.params ? value.params.item.id : null, JSON.stringify(value), value.createdAt,
      );
      this.sqlite.prepare("UPDATE scenario_agent_event_streams SET last_sequence = ? WHERE run_id = ?")
        .run(value.sequence, value.runId);
      return value;
  }

  private notify(event: ScenarioAgentEvent): void {
    if (this.sqlite.inTransaction) {
      queueMicrotask(() => {
        // A nested append is not yet durable. Rollback must never leak a phantom event.
        if (this.sqlite.open && !this.sqlite.inTransaction && this.sqlite.prepare("SELECT 1 FROM scenario_agent_protocol_events WHERE id=?").get(event.id)) this.notify(event);
      });
      return;
    }
    // Transport delivery is best effort. A listener failure must not undo committed facts
    // or prevent cancellation/other listeners; consumers recover via durable cursors.
    for (const listener of [this.publish, ...this.subscribers]) {
      try { listener?.(event); } catch { /* durable replay is authoritative */ }
    }
  }

  list(runId: string, after = 0, limit = 200): { events: ScenarioAgentEvent[]; nextCursor: number; hasMore: boolean } {
    return this.sqlite.transaction(() => this.listSnapshot(runId,after,limit))();
  }

  private listSnapshot(runId: string, after: number, limit: number): { events: ScenarioAgentEvent[]; nextCursor: number; hasMore: boolean } {
    if (!Number.isSafeInteger(after) || after<0 || !Number.isSafeInteger(limit) || limit<1 || limit>1000) throw new AgentEventReadError("invalid_cursor", "Invalid replay bounds",400);
    const high = (this.sqlite.prepare("SELECT last_sequence FROM scenario_agent_event_streams WHERE run_id=?").get(runId) as { last_sequence: number } | undefined)?.last_sequence ?? 0;
    if (after>high) throw new AgentEventReadError("future_cursor", "Cursor is ahead of the durable stream");
    if (after>0 && !this.sqlite.prepare("SELECT 1 FROM scenario_agent_protocol_events WHERE run_id=? AND sequence=?").get(runId,after)) throw new AgentEventReadError("sequence_gap", "Cursor anchor is missing");
    const rows = this.sqlite.prepare(`
      SELECT * FROM scenario_agent_protocol_events
      WHERE run_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?
    `).all(runId, after, limit + 1) as EventRow[];
    const hasMore = rows.length > limit;
    const events = rows.slice(0, limit).map((row, index) => {
      const event = this.decodeRow(row);
      if (event.sequence !== after+index+1) throw new AgentEventReadError("sequence_gap", "Durable event sequence has a gap");
      return event;
    });
    if (!hasMore && (events.at(-1)?.sequence ?? after) !== high) throw new AgentEventReadError("sequence_gap", "Durable stream tail is missing");
    return { events, nextCursor: events.at(-1)?.sequence ?? after, hasMore };
  }

  replay(caseId: string, runId: string, cursor?: string, limit = 200) {
    return this.sqlite.transaction(() => this.replaySnapshot(caseId,runId,cursor,limit))();
  }

  private replaySnapshot(caseId: string, runId: string, cursor: string | undefined, limit: number) {
    let after = 0;
    if (cursor) {
      let decoded;
      try {
        if (cursor.length>16384 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
        decoded = AgentEventCursorSchema.parse(JSON.parse(Buffer.from(cursor,"base64url").toString("utf8")));
      } catch { throw new AgentEventReadError("invalid_cursor", "Malformed or unsupported Agent cursor",400); }
      if (decoded.caseId!==caseId || decoded.runId!==runId) throw new AgentEventReadError("scope_mismatch", "Cursor belongs to a different Case/Run");
      after = decoded.sequence;
      if (after>0) {
        const row = this.sqlite.prepare("SELECT * FROM scenario_agent_protocol_events WHERE run_id=? AND sequence=?").get(runId,after) as EventRow | undefined;
        if (!row || this.decodeRow(row).id!==decoded.eventId) throw new AgentEventReadError("cursor_anchor_mismatch", "Cursor no longer identifies the same durable event");
      }
    }
    const owner = this.sqlite.prepare(`SELECT case_id FROM scenario_event_streams WHERE run_id=? UNION ALL
      SELECT case_id FROM scenario_agent_protocol_events WHERE run_id=? LIMIT 1`).get(runId,runId) as { case_id: string } | undefined;
    if (!owner) throw new AgentEventReadError("unknown_run", "Unknown Agent event Run",404);
    if (owner.case_id!==caseId) throw new AgentEventReadError("scope_mismatch", "Case does not own the requested Run");
    const page = this.list(runId,after,limit);
    if (page.events.some((event) => event.caseId!==caseId)) throw new AgentEventReadError("scope_mismatch", "Stored event Case attribution mismatch");
    const last = page.events.at(-1);
    const nextCursor = last ? Buffer.from(JSON.stringify({ version:1,protocolVersion:2,caseId,runId,sequence:last.sequence,eventId:last.id })).toString("base64url")
      : cursor ?? Buffer.from(JSON.stringify({version:1,protocolVersion:2,caseId,runId,sequence:0,eventId:null})).toString("base64url");
    return { ...page, nextCursor, protocolVersion:2 as const, replayOnly:true as const };
  }

  private decodeRow(row: EventRow): ScenarioAgentEvent {
    let value: unknown;
    try { value=JSON.parse(row.event_json); } catch { throw new AgentEventReadError("invalid_event", "Stored Agent event is not JSON"); }
    const event = decodeScenarioAgentEvent(value);
    if (event.runId!==row.run_id || event.caseId!==row.case_id || event.id!==row.id || event.sequence!==row.sequence
      || event.workId!==row.work_id || event.turnId!==row.turn_id || event.role!==row.role || event.method!==row.method || event.createdAt!==row.created_at
      || ("item" in event.params ? event.params.item.id : null)!==row.item_id) throw new AgentEventReadError("invalid_attribution", "Stored event differs from its durable index");
    return event;
  }

  subscribe(listener: (event: ScenarioAgentEvent) => void): () => void {
    this.subscribers.add(listener);
    return () => { this.subscribers.delete(listener); };
  }

  /** Lifecycle source stores remain authoritative even while the audit projection is full. */
  bestEffortWriter(onError: (error: unknown) => void): ScenarioAgentEventWriter {
    return {append:(draft) => {
      try { this.append(draft); }
      catch (error) { try { onError(error); } catch { /* reporting cannot break cancellation */ } }
    }};
  }

  reconcileFromProjections(snapshotUpperRowId = Number.MAX_SAFE_INTEGER, limit = 100): number {
    if (!Number.isSafeInteger(snapshotUpperRowId) || snapshotUpperRowId<0 || !Number.isSafeInteger(limit) || limit<1 || limit>1000) throw new Error("Invalid lifecycle repair bounds");
    let appended = 0;
    const hasTurnStarted = this.sqlite.prepare("SELECT 1 FROM scenario_agent_protocol_events WHERE run_id = ? AND turn_id = ? AND method = 'turn/started' LIMIT 1");
    const hasTurnTerminal = this.sqlite.prepare("SELECT 1 FROM scenario_agent_protocol_events WHERE run_id = ? AND turn_id = ? AND method = 'turn/completed' LIMIT 1");
    const snapshots = this.sqlite.prepare(`
      SELECT id, run_id, case_id, work_id, consumer, source_run_revision, source_graph_revision, status, output_json, error, completed_at
      FROM scenario_cognitive_snapshots s WHERE status IN ('completed', 'failed') AND rowid<=?
        AND (NOT EXISTS(SELECT 1 FROM scenario_agent_protocol_events p WHERE p.run_id=s.run_id AND p.turn_id=s.id AND p.method='turn/started')
          OR NOT EXISTS(SELECT 1 FROM scenario_agent_protocol_events p WHERE p.run_id=s.run_id AND p.turn_id=s.id AND p.method='turn/completed'))
      ORDER BY rowid LIMIT ?
    `).all(snapshotUpperRowId,limit) as Array<{
      id: string; run_id: string; case_id: string; work_id: string | null; consumer: "planner" | "observer" | "worker" | "replay";
      source_run_revision: number; source_graph_revision: number | null; status: "completed" | "failed"; error: string | null; completed_at: string | null;
      output_json: string | null;
    }>;
    for (const row of snapshots) {
      if (!hasTurnStarted.get(row.run_id, row.id)) {
        this.append({
          method: "turn/started", runId: row.run_id, caseId: row.case_id, workId: row.work_id, turnId: row.id, role: row.consumer,
          params: { agentInstanceId: `${row.consumer}:${row.run_id}`, sourceRunRevision: row.source_run_revision, sourceGraphRevision: row.source_graph_revision },
        });
        appended += 1;
      }
      if (hasTurnTerminal.get(row.run_id, row.id)) continue;
      const recovered = recoveredTurnTerminal(row.consumer, row.status, row.output_json, row.error);
      this.append({
        method: "turn/completed", runId: row.run_id, caseId: row.case_id, workId: row.work_id, turnId: row.id, role: row.consumer,
        createdAt: row.completed_at ?? this.now(),
        params: {
          status: recovered.status, outcome: recovered.outcome, checkpointRef: null, error: recovered.error,
        },
      });
      appended += 1;
    }

    const hasItemTerminal = this.sqlite.prepare("SELECT 1 FROM scenario_agent_protocol_events WHERE run_id = ? AND item_id = ? AND method = 'item/completed' LIMIT 1");
    const calls = this.sqlite.prepare(`
      SELECT id, snapshot_id, run_id, case_id, work_id, role, route_id, route_attempt, status, reserved_tokens,
             prompt_tokens, completion_tokens, total_tokens, error, completed_at, termination_kind
      FROM scenario_model_calls c WHERE status IN ('completed', 'failed', 'timed_out')
        AND NOT EXISTS(SELECT 1 FROM scenario_agent_protocol_events p WHERE p.run_id=c.run_id AND p.item_id=c.id AND p.method='item/completed')
      ORDER BY c.rowid LIMIT ?
    `).all(limit) as Array<{
      id: string; snapshot_id: string; run_id: string; case_id: string; work_id: string | null; role: "planner" | "observer" | "worker";
      route_id: string; route_attempt: number; status: "completed" | "failed" | "timed_out"; reserved_tokens: number;
      prompt_tokens: number; completion_tokens: number; total_tokens: number; error: string | null; completed_at: string | null; termination_kind: "cancelled" | "interrupted" | null;
    }>;
    for (const row of calls) {
      if (hasItemTerminal.get(row.run_id, row.id)) continue;
      this.append({
        method: "item/completed", runId: row.run_id, caseId: row.case_id, workId: row.work_id,
        turnId: row.snapshot_id, role: row.role, createdAt: row.completed_at ?? this.now(),
        params: { item: {
          type: "modelCall", id: row.id, routeId: row.route_id, attempt: row.route_attempt,
          status: row.termination_kind ?? (row.error?.includes("runtime restarted") ? "interrupted" : row.status === "timed_out" ? "timedOut" : row.status),
          reservedTokens: row.reserved_tokens,
          usage: { promptTokens: row.prompt_tokens, completionTokens: row.completion_tokens, totalTokens: row.total_tokens },
          error: row.error,
        } },
      });
      appended += 1;
    }
    const admissions = this.sqlite.prepare(`
      SELECT id, snapshot_id, run_id, case_id, work_id, role, priority, status, outcome,
             queue_wait_ms, reason, released_at
      FROM scenario_model_admissions a WHERE status NOT IN ('queued', 'admitted')
        AND NOT EXISTS(SELECT 1 FROM scenario_agent_protocol_events p WHERE p.run_id=a.run_id AND p.item_id=a.id AND p.method='item/completed')
      ORDER BY a.rowid LIMIT ?
    `).all(limit) as Array<{
      id: string; snapshot_id: string; run_id: string; case_id: string; work_id: string | null; role: "planner" | "observer" | "worker";
      priority: number; status: "released" | "cancelled" | "timed_out" | "interrupted" | "rejected";
      outcome: "completed" | "failed" | "timed_out" | "cancelled" | null; queue_wait_ms: number | null; reason: string | null; released_at: string | null;
    }>;
    for (const row of admissions) {
      if (hasItemTerminal.get(row.run_id, row.id)) continue;
      this.append({
        method: "item/completed", runId: row.run_id, caseId: row.case_id, workId: row.work_id,
        turnId: row.snapshot_id, role: row.role, createdAt: row.released_at ?? this.now(),
        params: { item: {
          type: "modelAdmission", id: row.id,
          status: row.status === "timed_out" ? "timedOut" : row.status,
          priority: row.priority, queueWaitMs: row.queue_wait_ms,
          outcome: row.outcome === "timed_out" ? "timedOut" : row.outcome,
          reason: row.reason,
        } },
      });
      appended += 1;
    }

    const approvals = this.sqlite.prepare(`
      SELECT id, run_id, case_id, work_id, tool_name, risk, status, resolution_reason, created_at, resolved_at
      FROM scenario_work_approvals a WHERE
        NOT EXISTS(SELECT 1 FROM scenario_agent_protocol_events p WHERE p.run_id=a.run_id AND p.turn_id='approval:'||a.id AND p.method='turn/started')
        OR NOT EXISTS(SELECT 1 FROM scenario_agent_protocol_events p WHERE p.run_id=a.run_id AND p.item_id=a.id AND p.method='item/started')
        OR (a.status!='pending' AND (NOT EXISTS(SELECT 1 FROM scenario_agent_protocol_events p WHERE p.run_id=a.run_id AND p.item_id=a.id AND p.method='item/completed')
          OR NOT EXISTS(SELECT 1 FROM scenario_agent_protocol_events p WHERE p.run_id=a.run_id AND p.turn_id='approval:'||a.id AND p.method='turn/completed')))
      ORDER BY a.rowid LIMIT ?
    `).all(limit) as Array<{
      id: string; run_id: string; case_id: string; work_id: string; tool_name: string;
      risk: "read_only" | "bounded_write" | "privileged" | "destructive";
      status: "pending" | "approved" | "rejected" | "cancelled"; resolution_reason: string | null;
      created_at: string; resolved_at: string | null;
    }>;
    const hasItemStarted = this.sqlite.prepare("SELECT 1 FROM scenario_agent_protocol_events WHERE run_id = ? AND item_id = ? AND method = 'item/started' LIMIT 1");
    for (const row of approvals) {
      const turnId = `approval:${row.id}`;
      if (!hasTurnStarted.get(row.run_id, turnId)) {
        this.append({
          method: "turn/started", runId: row.run_id, caseId: row.case_id, workId: row.work_id, turnId, role: "system",
          createdAt: row.created_at, params: { agentInstanceId: "approval-gate", sourceRunRevision: 0, sourceGraphRevision: null },
        });
        appended += 1;
      }
      if (!hasItemStarted.get(row.run_id, row.id)) {
        this.append({
          method: "item/started", runId: row.run_id, caseId: row.case_id, workId: row.work_id, turnId, role: "system",
          createdAt: row.created_at,
          params: { item: { type: "approval", id: row.id, tool: row.tool_name, status: "pending", risk: row.risk, reason: null } },
        });
        appended += 1;
      }
      if (row.status === "pending") continue;
      if (!hasItemTerminal.get(row.run_id, row.id)) {
        this.append({
        method: "item/completed", runId: row.run_id, caseId: row.case_id, workId: row.work_id, turnId, role: "system",
        createdAt: row.resolved_at ?? this.now(),
        params: { item: { type: "approval", id: row.id, tool: row.tool_name, status: row.status, risk: row.risk, reason: row.resolution_reason } },
      });
        appended += 1;
      }
      if (!hasTurnTerminal.get(row.run_id, turnId)) {
        this.append({
          method: "turn/completed", runId: row.run_id, caseId: row.case_id, workId: row.work_id, turnId, role: "system",
          createdAt: row.resolved_at ?? this.now(),
          params: { status: row.status === "cancelled" ? "cancelled" : "completed", outcome: row.status === "approved" ? "continue" : "blocked", checkpointRef: null, error: null },
        });
        appended += 1;
      }
    }
    return appended;
  }
}

function recoveredTurnTerminal(
  consumer: "planner" | "observer" | "worker" | "replay",
  status: "completed" | "failed",
  outputJson: string | null,
  error: string | null,
): { status: "completed" | "failed" | "interrupted"; outcome: "continue" | "finish" | "blocked" | null; error: string | null } {
  if (error?.includes("runtime restarted")) return { status: "interrupted", outcome: null, error };
  if (status === "failed") return { status: "failed", outcome: null, error };
  const output = outputJson ? JSON.parse(outputJson) as { action?: string; type?: string } : {};
  if (consumer === "worker") {
    if (output.type === "invoke_tool") return { status: "interrupted", outcome: null, error: "runtime restarted before action lifecycle completed" };
    return { status: "completed", outcome: output.type === "block" ? "blocked" : "finish", error: null };
  }
  if (consumer === "observer") {
    return { status: "completed", outcome: output.action?.startsWith("terminate_") ? "blocked" : "continue", error: null };
  }
  if (consumer === "planner") return { status: "completed", outcome: output.action === "wait" ? "continue" : "finish", error: null };
  return { status: "completed", outcome: "finish", error: null };
}

export function registerScenarioAgentEventRoutes(app: FastifyInstance, stream: SqliteScenarioAgentEventStream, audit?: AgentAuditProjection): void {
  app.get("/api/scenarios/runs/:runId/agent-events", async (request, reply) => {
    try {
    const { runId } = z.object({ runId: z.string().min(1) }).parse(request.params);
    const { after, limit } = z.object({
      after: z.coerce.number().int().nonnegative().default(0),
      limit: z.coerce.number().int().min(1).max(1_000).default(200),
    }).parse(request.query);
    return stream.list(runId, after, limit);
    } catch (error) { return readError(reply,error); }
  });
  app.get("/api/scenarios/runs/:runId/agent-event-replay", async (request, reply) => {
    try {
      const {runId} = z.object({runId:z.string().min(1).max(2048)}).parse(request.params);
      const {caseId,cursor,limit} = z.object({caseId:z.string().min(1).max(2048),cursor:z.string().max(16384).optional(),
        limit:z.coerce.number().int().min(1).max(1000).default(200)}).strict().parse(request.query);
      return {...stream.replay(caseId,runId,cursor,limit),auditProjection:audit?.status() ?? null};
    } catch (error) { return readError(reply,error); }
  });
  if (audit) app.get("/api/scenarios/runs/:runId/agent-audit-reference", async (request,reply) => {
    try {
      const {runId} = z.object({runId:z.string().min(1).max(2048)}).parse(request.params);
      const {caseId,source,sourceId} = z.object({caseId:z.string().min(1).max(2048),
        source:z.enum(["compaction","contextSnapshot","invocation","reconciliation","recoveryCommand","executionOccupancy","processOccupancy"]),sourceId:z.string().min(1).max(2048)}).strict().parse(request.query);
      return audit.read(caseId,runId,source,sourceId);
    } catch (error) { return readError(reply,error); }
  });
}

function readError(reply: import("fastify").FastifyReply, error: unknown) {
  if (error instanceof z.ZodError) return reply.code(400).send({code:"invalid_query",error:"Invalid Agent replay query"});
  if (error instanceof AgentEventReadError) return reply.code(error.statusCode).send({code:error.code,error:error.message});
  if (error instanceof AgentEventProtocolError) return reply.code(409).send({code:error.code,error:error.message});
  return reply.code(503).send({code:"read_unavailable",error:"Agent audit storage unavailable"});
}
