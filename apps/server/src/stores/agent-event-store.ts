import { randomUUID } from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agentEvents } from "../db/schema.js";
import { type AgentEvent, type AgentEventRefs, AgentEventSchema } from "@traceforge/shared";

export class AgentEventStore {
  constructor(private db: Db) {}

  append(
    caseId: string,
    kind: AgentEvent["kind"],
    text: string,
    tool?: string,
    occurredAt?: string,
    refs?: AgentEventRefs,
    lifecycle: {
      runId?: string;
      executionId?: string;
      outcome?: NonNullable<AgentEvent["outcome"]>;
      recoveredByExecutionId?: string;
      failureDiagnostic?: NonNullable<AgentEvent["failureDiagnostic"]>;
    } = {},
  ): AgentEvent {
    const id = `ae_${randomUUID()}`;
    const createdAt = occurredAt ?? new Date().toISOString();
    const e = AgentEventSchema.parse({
      id, caseId, kind, text, tool: tool ?? null, refs: refs ?? null,
      runId: lifecycle.runId ?? null,
      executionId: lifecycle.executionId ?? null,
      outcome: lifecycle.outcome ?? null,
      recoveredByExecutionId: lifecycle.recoveredByExecutionId ?? null,
      failureDiagnostic: lifecycle.failureDiagnostic ?? null,
      createdAt,
    });
    this.db.insert(agentEvents).values({
      id, caseId, kind, text, tool: e.tool, refsJson: e.refs ? JSON.stringify(e.refs) : null,
      runId: e.runId, executionId: e.executionId, outcome: e.outcome,
      recoveredByExecutionId: e.recoveredByExecutionId,
      failureDiagnosticJson: e.failureDiagnostic ? JSON.stringify(e.failureDiagnostic) : null,
      createdAt,
    }).run();
    return e;
  }

  markRecovered(caseId: string, executionIds: string[], recoveredByExecutionId: string): void {
    for (const executionId of executionIds) {
      this.db.update(agentEvents)
        .set({ outcome: "recovered", recoveredByExecutionId })
        .where(and(
          eq(agentEvents.caseId, caseId),
          eq(agentEvents.kind, "tool_result"),
          eq(agentEvents.executionId, executionId),
          eq(agentEvents.outcome, "failed"),
        ))
        .run();
    }
  }

  listByCase(caseId: string, options: { limit?: number; offset?: number } = {}): AgentEvent[] {
    const rows = options.limit === undefined
      ? this.db.select().from(agentEvents)
        .where(eq(agentEvents.caseId, caseId)).orderBy(asc(agentEvents.seq)).all()
      : this.db.select().from(agentEvents)
        .where(eq(agentEvents.caseId, caseId))
        .orderBy(desc(agentEvents.seq))
        .limit(options.limit).offset(options.offset ?? 0).all().reverse();
    return rows.map((row) =>
        AgentEventSchema.parse({
          id: row.id, caseId: row.caseId, kind: row.kind,
          text: row.text, tool: row.tool, createdAt: row.createdAt,
          refs: row.refsJson ? JSON.parse(row.refsJson) : null,
          runId: row.runId,
          executionId: row.executionId,
          outcome: row.outcome,
          recoveredByExecutionId: row.recoveredByExecutionId,
          failureDiagnostic: row.failureDiagnosticJson ? JSON.parse(row.failureDiagnosticJson) : null,
        }),
      );
  }
}
