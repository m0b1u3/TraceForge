import { asc, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { trafficEntries } from "../db/schema.js";
import { type TrafficEntry, TrafficEntrySchema } from "@traceforge/shared";

export class TrafficStore {
  constructor(private db: Db) {}

  add(entry: TrafficEntry): void {
    const e = TrafficEntrySchema.parse(entry);
    this.db.insert(trafficEntries).values({
      id: e.id, caseId: e.caseId, runId: e.runId, identityId: e.identityId,
      parentTrafficId: e.parentTrafficId, url: e.url, method: e.method,
      requestHeadersJson: JSON.stringify(e.requestHeaders),
      requestBody: e.requestBody,
      responseStatus: e.responseStatus,
      responseHeadersJson: e.responseHeaders ? JSON.stringify(e.responseHeaders) : null,
      responseSize: e.responseSize ?? null,
      contentType: e.contentType ?? null,
      responseBody: e.responseBody, createdAt: e.createdAt,
    }).run();
  }

  updateResponse(id: string, responseBody: string | null, responseSize: number | null): void {
    this.db.update(trafficEntries).set({ responseBody, responseSize }).where(eq(trafficEntries.id, id)).run();
  }

  clearByCase(caseId: string): number {
    return this.db.delete(trafficEntries).where(eq(trafficEntries.caseId, caseId)).run().changes;
  }

  listByCase(caseId: string, options: { limit?: number; offset?: number } = {}): TrafficEntry[] {
    const rows = options.limit === undefined
      ? this.db.select().from(trafficEntries)
        .where(eq(trafficEntries.caseId, caseId))
        .orderBy(asc(trafficEntries.createdAt), sql`rowid asc`).all()
      : this.db.select().from(trafficEntries)
        .where(eq(trafficEntries.caseId, caseId))
        .orderBy(desc(trafficEntries.createdAt), sql`rowid desc`)
        .limit(options.limit).offset(options.offset ?? 0).all().reverse();
    return rows.map((row) =>
        TrafficEntrySchema.parse({
          id: row.id, caseId: row.caseId, runId: row.runId, identityId: row.identityId,
          parentTrafficId: row.parentTrafficId, url: row.url, method: row.method,
          requestHeaders: JSON.parse(row.requestHeadersJson),
          requestBody: row.requestBody,
          responseStatus: row.responseStatus,
          responseHeaders: row.responseHeadersJson ? JSON.parse(row.responseHeadersJson) : undefined,
          responseSize: row.responseSize,
          contentType: row.contentType,
          responseBody: row.responseBody, createdAt: row.createdAt,
        }),
      );
  }
}
