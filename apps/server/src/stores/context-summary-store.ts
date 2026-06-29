import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { contextSummaries } from "../db/schema.js";
import { type ContextSummary, ContextSummarySchema } from "@traceforge/shared";

export class ContextSummaryStore {
  constructor(private db: Db) {}

  append(caseId: string, coversUpToEventSeq: number, content: string): ContextSummary {
    const s = ContextSummarySchema.parse({
      id: `cs_${randomUUID()}`, caseId, coversUpToEventSeq, content, createdAt: new Date().toISOString(),
    });
    this.db.insert(contextSummaries).values({
      id: s.id, caseId, coversUpToEventSeq, content, createdAt: s.createdAt,
    }).run();
    return s;
  }

  latest(caseId: string): ContextSummary | undefined {
    const row = this.db.select().from(contextSummaries)
      .where(eq(contextSummaries.caseId, caseId)).orderBy(desc(contextSummaries.seq)).get();
    if (!row) return undefined;
    return ContextSummarySchema.parse({
      id: row.id, caseId: row.caseId, coversUpToEventSeq: row.coversUpToEventSeq,
      content: row.content, createdAt: row.createdAt,
    });
  }
}
