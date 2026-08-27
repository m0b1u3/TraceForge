import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ScenarioAgentEventSchema, type ScenarioAgentEvent, type ScenarioAgentEventDraft } from "@traceforge/shared";

export interface ScenarioAgentEventWriter {
  append(event: ScenarioAgentEventDraft): ScenarioAgentEvent;
}

interface EventRow { event_json: string }

export class SqliteScenarioAgentEventStream implements ScenarioAgentEventWriter {
  private readonly subscribers = new Set<(event: ScenarioAgentEvent) => void>();

  constructor(
    private readonly sqlite: Database.Database,
    private readonly publish?: (event: ScenarioAgentEvent) => void,
    private readonly createId: () => string = randomUUID,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  append(draft: ScenarioAgentEventDraft): ScenarioAgentEvent {
    const event = this.sqlite.transaction(() => {
      this.sqlite.prepare(`
        INSERT INTO scenario_agent_event_streams (run_id, last_sequence) VALUES (?, 0)
        ON CONFLICT(run_id) DO NOTHING
      `).run(draft.runId);
      const stream = this.sqlite.prepare("SELECT last_sequence FROM scenario_agent_event_streams WHERE run_id = ?")
        .get(draft.runId) as { last_sequence: number };
      const value = ScenarioAgentEventSchema.parse({
        ...draft,
        protocolVersion: 2,
        id: this.createId(),
        sequence: stream.last_sequence + 1,
        createdAt: draft.createdAt ?? this.now(),
      });
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
    })();
    this.publish?.(event);
    for (const subscriber of [...this.subscribers]) subscriber(event);
    return event;
  }

  list(runId: string, after = 0, limit = 200): { events: ScenarioAgentEvent[]; nextCursor: number; hasMore: boolean } {
    const rows = this.sqlite.prepare(`
      SELECT event_json FROM scenario_agent_protocol_events
      WHERE run_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?
    `).all(runId, after, limit + 1) as EventRow[];
    const hasMore = rows.length > limit;
    const events = rows.slice(0, limit).map((row) => ScenarioAgentEventSchema.parse(JSON.parse(row.event_json)));
    return { events, nextCursor: events.at(-1)?.sequence ?? after, hasMore };
  }

  subscribe(listener: (event: ScenarioAgentEvent) => void): () => void {
    this.subscribers.add(listener);
    return () => { this.subscribers.delete(listener); };
  }

  reconcileFromProjections(): number {
    let appended = 0;
    const hasTurnStarted = this.sqlite.prepare("SELECT 1 FROM scenario_agent_protocol_events WHERE run_id = ? AND turn_id = ? AND method = 'turn/started' LIMIT 1");
    const hasTurnTerminal = this.sqlite.prepare("SELECT 1 FROM scenario_agent_protocol_events WHERE run_id = ? AND turn_id = ? AND method = 'turn/completed' LIMIT 1");
    const snapshots = this.sqlite.prepare(`
      SELECT id, run_id, case_id, work_id, consumer, source_run_revision, source_graph_revision, status, output_json, error, completed_at
      FROM scenario_cognitive_snapshots WHERE status IN ('completed', 'failed')
    `).all() as Array<{
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
             prompt_tokens, completion_tokens, total_tokens, error, completed_at
      FROM scenario_model_calls WHERE status IN ('completed', 'failed', 'timed_out')
    `).all() as Array<{
      id: string; snapshot_id: string; run_id: string; case_id: string; work_id: string | null; role: "planner" | "observer" | "worker";
      route_id: string; route_attempt: number; status: "completed" | "failed" | "timed_out"; reserved_tokens: number;
      prompt_tokens: number; completion_tokens: number; total_tokens: number; error: string | null; completed_at: string | null;
    }>;
    for (const row of calls) {
      if (hasItemTerminal.get(row.run_id, row.id)) continue;
      this.append({
        method: "item/completed", runId: row.run_id, caseId: row.case_id, workId: row.work_id,
        turnId: row.snapshot_id, role: row.role, createdAt: row.completed_at ?? this.now(),
        params: { item: {
          type: "modelCall", id: row.id, routeId: row.route_id, attempt: row.route_attempt,
          status: row.error?.includes("runtime restarted") ? "interrupted" : row.status === "timed_out" ? "timedOut" : row.status,
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
      FROM scenario_model_admissions WHERE status NOT IN ('queued', 'admitted')
    `).all() as Array<{
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
      FROM scenario_work_approvals
    `).all() as Array<{
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
      if (row.status === "pending" || hasItemTerminal.get(row.run_id, row.id)) continue;
      this.append({
        method: "item/completed", runId: row.run_id, caseId: row.case_id, workId: row.work_id, turnId, role: "system",
        createdAt: row.resolved_at ?? this.now(),
        params: { item: { type: "approval", id: row.id, tool: row.tool_name, status: row.status, risk: row.risk, reason: row.resolution_reason } },
      });
      appended += 1;
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

export function registerScenarioAgentEventRoutes(app: FastifyInstance, stream: SqliteScenarioAgentEventStream): void {
  app.get("/api/scenarios/runs/:runId/agent-events", async (request) => {
    const { runId } = z.object({ runId: z.string().min(1) }).parse(request.params);
    const { after, limit } = z.object({
      after: z.coerce.number().int().nonnegative().default(0),
      limit: z.coerce.number().int().min(1).max(1_000).default(200),
    }).parse(request.query);
    return stream.list(runId, after, limit);
  });
}
