import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agentEvents } from "../db/schema.js";
import { type AgentEvent, AgentEventSchema } from "@traceforge/shared";

export class AgentEventStore {
  constructor(private db: Db) {}

  append(caseId: string, kind: AgentEvent["kind"], text: string, tool?: string): AgentEvent {
    const id = `ae_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const e = AgentEventSchema.parse({ id, caseId, kind, text, tool: tool ?? null, createdAt });
    this.db.insert(agentEvents).values({
      id, caseId, kind, text, tool: e.tool, createdAt,
    }).run();
    return e;
  }

  listByCase(caseId: string): AgentEvent[] {
    return this.db.select().from(agentEvents)
      .where(eq(agentEvents.caseId, caseId)).orderBy(asc(agentEvents.seq)).all()
      .map((row) =>
        AgentEventSchema.parse({
          id: row.id, caseId: row.caseId, kind: row.kind,
          text: row.text, tool: row.tool, createdAt: row.createdAt,
        }),
      );
  }
}
