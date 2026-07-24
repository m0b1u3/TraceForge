import { asc, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { trafficEntries } from "../db/schema.js";
import { type TrafficEntry, TrafficEntrySchema } from "@traceforge/shared";

export class TrafficStore {
  constructor(private db: Db) {}

  add(entry: TrafficEntry): void {
    const e = TrafficEntrySchema.parse(entry);
    const responseBody = safeStoredBody(e.responseBody, e.contentType);
    this.db.insert(trafficEntries).values({
      id: e.id, caseId: e.caseId, runId: e.runId, identityId: e.identityId,
      identityVersion: e.identityVersion, attributionSource: e.attributionSource,
      parentTrafficId: e.parentTrafficId, url: e.url, method: e.method,
      requestHeadersJson: JSON.stringify(e.requestHeaders),
      requestBody: e.requestBody,
      responseStatus: e.responseStatus,
      responseHeadersJson: e.responseHeaders ? JSON.stringify(e.responseHeaders) : null,
      responseSize: e.responseSize ?? null,
      contentType: e.contentType ?? null,
      responseBody, createdAt: e.createdAt,
    }).run();
  }

  updateResponse(id: string, responseBody: string | null, responseSize: number | null): void {
    this.db.update(trafficEntries).set({ responseBody: safeStoredBody(responseBody, null), responseSize }).where(eq(trafficEntries.id, id)).run();
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
          identityVersion: row.identityVersion, attributionSource: row.attributionSource,
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

function safeStoredBody(body: string | null, contentType: string | null | undefined): string | null {
  if (!body) return body;
  const textual = !contentType || /(?:text|json|xml|javascript|x-www-form-urlencoded|graphql)/i.test(contentType);
  if (!textual) return null;
  const sample = body.slice(0, 4_096);
  let controls = 0;
  for (const character of sample) {
    const code = character.charCodeAt(0);
    if (code === 0 || code < 9 || (code > 13 && code < 32)) controls += 1;
  }
  if (controls / Math.max(1, sample.length) > 0.02) return null;
  return body.length > 64_000 ? body.slice(0, 64_000) : body;
}
