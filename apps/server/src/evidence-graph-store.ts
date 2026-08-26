import type Database from "better-sqlite3";
import {
  EvidenceGraphKernel,
  evolveEvidenceGraph,
  type EvidenceGraphCommandEnvelope,
  type EvidenceGraphCommandResult,
  type EvidenceGraphEvent,
  type EvidenceGraphState,
} from "@traceforge/evidence-graph";
import { commandFingerprint } from "@traceforge/orchestration-core";
import type { BlackboardChangeBus } from "./blackboard-change-bus.js";

interface StreamRow { revision: number }
interface EventRow { payload_json: string }
interface CommandRow { fingerprint: string; resulting_revision: number }

export class EvidenceGraphRevisionConflictError extends Error {
  constructor(readonly caseId: string, readonly expectedRevision: number, readonly actualRevision: number) {
    super(`Evidence Graph ${caseId} revision conflict: expected ${expectedRevision}, actual ${actualRevision}`);
    this.name = "EvidenceGraphRevisionConflictError";
  }
}

export class EvidenceGraphIdempotencyConflictError extends Error {
  constructor(readonly caseId: string, readonly commandId: string) {
    super(`Evidence Graph command ${commandId} for Case ${caseId} was reused with different content`);
    this.name = "EvidenceGraphIdempotencyConflictError";
  }
}

export class SqliteEvidenceGraphStore {
  constructor(private readonly sqlite: Database.Database, private readonly changes?: BlackboardChangeBus) {}

  load(caseId: string, throughRevision?: number): EvidenceGraphState | undefined {
    const stream = this.sqlite.prepare("SELECT revision FROM evidence_graph_streams WHERE case_id = ?").get(caseId) as StreamRow | undefined;
    if (!stream) return undefined;
    const maximum = Math.min(throughRevision ?? stream.revision, stream.revision);
    const rows = this.sqlite.prepare(
      "SELECT payload_json FROM evidence_graph_events WHERE case_id = ? AND sequence <= ? ORDER BY sequence ASC",
    ).all(caseId, maximum) as EventRow[];
    let state: EvidenceGraphState | undefined;
    for (const row of rows) state = evolveEvidenceGraph(state, JSON.parse(row.payload_json) as EvidenceGraphEvent);
    return state;
  }

  execute(envelope: EvidenceGraphCommandEnvelope): EvidenceGraphCommandResult {
    const fingerprint = commandFingerprint(envelope.command);
    const result = this.sqlite.transaction(() => {
      const recorded = this.sqlite.prepare(
        "SELECT fingerprint, resulting_revision FROM evidence_graph_commands WHERE case_id = ? AND command_id = ?",
      ).get(envelope.caseId, envelope.commandId) as CommandRow | undefined;
      if (recorded) {
        if (recorded.fingerprint !== fingerprint) throw new EvidenceGraphIdempotencyConflictError(envelope.caseId, envelope.commandId);
        const state = this.load(envelope.caseId, recorded.resulting_revision);
        if (!state) throw new Error(`Recorded Evidence Graph command ${envelope.commandId} has no stream`);
        const events = this.commandEvents(envelope.caseId, envelope.commandId);
        return { state, events, idempotentReplay: true };
      }

      const current = this.load(envelope.caseId);
      const actualRevision = current?.revision ?? 0;
      if (actualRevision !== envelope.expectedRevision) {
        throw new EvidenceGraphRevisionConflictError(envelope.caseId, envelope.expectedRevision, actualRevision);
      }
      if (envelope.command.type === "initialize_graph" && envelope.command.caseId !== envelope.caseId) {
        throw new Error("Evidence Graph command belongs to another Case");
      }
      const decided = new EvidenceGraphKernel().execute(current, envelope.command);
      if (decided.events.length === 0) throw new Error(`Evidence Graph command ${envelope.commandId} emitted no events`);

      const firstAt = decided.events[0].at;
      if (!current) {
        if (decided.events[0].type !== "graph_initialized") throw new Error(`New Evidence Graph ${envelope.caseId} must be initialized first`);
        this.sqlite.prepare(
          "INSERT INTO evidence_graph_streams (case_id, revision, created_at, updated_at) VALUES (?, 0, ?, ?)",
        ).run(envelope.caseId, firstAt, firstAt);
      }
      const insertEvent = this.sqlite.prepare(`
        INSERT INTO evidence_graph_events
          (case_id, sequence, command_id, event_index, event_type, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      decided.events.forEach((event, index) => {
        insertEvent.run(
          envelope.caseId, envelope.expectedRevision + index + 1, envelope.commandId, index,
          event.type, JSON.stringify(event), event.at,
        );
        this.applyProjection(envelope.caseId, event);
      });
      const resultingRevision = envelope.expectedRevision + decided.events.length;
      const update = this.sqlite.prepare(
        "UPDATE evidence_graph_streams SET revision = ?, updated_at = ? WHERE case_id = ? AND revision = ?",
      ).run(resultingRevision, decided.events.at(-1)!.at, envelope.caseId, envelope.expectedRevision);
      if (update.changes !== 1) throw new EvidenceGraphRevisionConflictError(envelope.caseId, envelope.expectedRevision, actualRevision);
      this.sqlite.prepare(`
        INSERT INTO evidence_graph_commands (case_id, command_id, fingerprint, resulting_revision, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(envelope.caseId, envelope.commandId, fingerprint, resultingRevision, decided.events.at(-1)!.at);
      return { ...decided, idempotentReplay: false };
    })();
    if (!result.idempotentReplay) {
      this.changes?.publish({
        kind: "graph",
        caseId: envelope.caseId,
        revision: result.state.revision,
        eventTypes: result.events.map((event) => event.type),
        at: result.events.at(-1)!.at,
      });
    }
    return result;
  }

  ensure(caseId: string, at: string): EvidenceGraphState {
    return this.load(caseId) ?? this.execute({
      caseId,
      commandId: `initialize:${caseId}`,
      expectedRevision: 0,
      command: { type: "initialize_graph", caseId, at },
    }).state;
  }

  private commandEvents(caseId: string, commandId: string): EvidenceGraphEvent[] {
    const rows = this.sqlite.prepare(`
      SELECT payload_json FROM evidence_graph_events
      WHERE case_id = ? AND command_id = ? ORDER BY event_index ASC
    `).all(caseId, commandId) as EventRow[];
    return rows.map((row) => JSON.parse(row.payload_json) as EvidenceGraphEvent);
  }

  private applyProjection(caseId: string, event: EvidenceGraphEvent): void {
    if (event.type === "node_added") {
      const node = event.node;
      this.sqlite.prepare(`
        INSERT INTO evidence_graph_nodes
          (id, case_id, run_id, kind, title, summary, status, confidence, properties_json, source_json,
           version, created_at, updated_at, invalidated_at, invalidation_reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
      `).run(
        node.id, caseId, node.runId, node.kind, node.title, node.summary, node.status, node.confidence,
        JSON.stringify(node.properties), node.source ? JSON.stringify(node.source) : null,
        node.version, node.createdAt, node.updatedAt,
      );
      return;
    }
    if (event.type === "edge_added") {
      const edge = event.edge;
      this.sqlite.prepare(`
        INSERT INTO evidence_graph_edges (id, case_id, source_id, target_id, relation, rationale, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(edge.id, caseId, edge.sourceId, edge.targetId, edge.relation, edge.rationale, edge.createdAt);
      return;
    }
    if (event.type === "node_status_changed") {
      this.sqlite.prepare(`
        UPDATE evidence_graph_nodes SET status = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND case_id = ?
      `).run(event.status, event.at, event.nodeId, caseId);
      return;
    }
    if (event.type === "node_invalidated") {
      this.sqlite.prepare(`
        UPDATE evidence_graph_nodes
        SET status = 'invalidated', version = version + 1, updated_at = ?, invalidated_at = ?, invalidation_reason = ?
        WHERE id = ? AND case_id = ?
      `).run(event.at, event.at, event.reason, event.nodeId, caseId);
    }
  }
}
