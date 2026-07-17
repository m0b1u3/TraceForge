import { randomUUID } from "node:crypto";
import { asc, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { timeline } from "../db/schema.js";
import { type TimelineEntry, TimelineEntrySchema } from "@traceforge/shared";

export class TimelineStore {
  constructor(private db: Db) {}

  append(caseId: string, eventType: string, detail: string, refId?: string): TimelineEntry {
    const id = `tl_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const e = TimelineEntrySchema.parse({ id, caseId, eventType, refId: refId ?? null, detail, createdAt });
    this.db.insert(timeline).values({
      id, caseId, eventType, refId: e.refId, detail, createdAt,
    }).run();
    return e;
  }

  listByCase(caseId: string, options: { limit?: number; offset?: number } = {}): TimelineEntry[] {
    const rows = options.limit === undefined
      ? this.db.select().from(timeline)
        .where(eq(timeline.caseId, caseId)).orderBy(asc(timeline.createdAt), sql`rowid asc`).all()
      : this.db.select().from(timeline)
        .where(eq(timeline.caseId, caseId))
        .orderBy(desc(timeline.createdAt), sql`rowid desc`)
        .limit(options.limit).offset(options.offset ?? 0).all().reverse();
    return rows.map((row) =>
        TimelineEntrySchema.parse({
          id: row.id, caseId: row.caseId, eventType: row.eventType,
          refId: row.refId, detail: row.detail, createdAt: row.createdAt,
        }),
      );
  }
}
