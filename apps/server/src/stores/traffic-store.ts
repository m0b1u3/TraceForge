import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { trafficEntries } from "../db/schema.js";
import { type TrafficEntry, TrafficEntrySchema } from "@traceforge/shared";

export class TrafficStore {
  constructor(private db: Db) {}

  add(entry: TrafficEntry): void {
    const e = TrafficEntrySchema.parse(entry);
    this.db.insert(trafficEntries).values({
      id: e.id, caseId: e.caseId, url: e.url, method: e.method,
      requestHeadersJson: JSON.stringify(e.requestHeaders),
      requestBody: e.requestBody,
      responseStatus: e.responseStatus, responseBody: e.responseBody, createdAt: e.createdAt,
    }).run();
  }

  updateBody(id: string, responseBody: string | null): void {
    this.db.update(trafficEntries).set({ responseBody }).where(eq(trafficEntries.id, id)).run();
  }

  listByCase(caseId: string): TrafficEntry[] {
    return this.db.select().from(trafficEntries)
      .where(eq(trafficEntries.caseId, caseId)).all()
      .map((row) =>
        TrafficEntrySchema.parse({
          id: row.id, caseId: row.caseId, url: row.url, method: row.method,
          requestHeaders: JSON.parse(row.requestHeadersJson),
          requestBody: row.requestBody,
          responseStatus: row.responseStatus, responseBody: row.responseBody, createdAt: row.createdAt,
        }),
      );
  }
}
