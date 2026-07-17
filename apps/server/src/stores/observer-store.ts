import { eq, and, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { observerWarnings } from "../db/schema.js";
import { type ObserverWarning, ObserverWarningSchema } from "@traceforge/shared";

function rowToWarning(row: typeof observerWarnings.$inferSelect): ObserverWarning {
  return ObserverWarningSchema.parse({
    id: row.id, caseId: row.caseId, level: row.level, title: row.title, description: row.description,
    relatedFacts: JSON.parse(row.relatedFactsJson), relatedTasks: JSON.parse(row.relatedTasksJson),
    suggestedAction: row.suggestedAction, status: row.status, relatedRunId: row.relatedRunId,
    suggestedGoal: row.suggestedGoal, evidence: row.evidence ?? undefined,
    fingerprint: row.fingerprint, occurrenceCount: row.occurrenceCount,
    lastObservedAt: row.lastObservedAt, escalationReason: row.escalationReason,
    resolvedAt: row.resolvedAt, createdAt: row.createdAt,
  });
}

export class ObserverWarningStore {
  constructor(private db: Db) {}

  create(w: ObserverWarning): ObserverWarning {
    const parsed = ObserverWarningSchema.parse(w);
    this.db.insert(observerWarnings).values({
      id: parsed.id, caseId: parsed.caseId, level: parsed.level,
      title: parsed.title, description: parsed.description,
      relatedFactsJson: JSON.stringify(parsed.relatedFacts),
      relatedTasksJson: JSON.stringify(parsed.relatedTasks),
      suggestedAction: parsed.suggestedAction, status: parsed.status,
      fingerprint: parsed.fingerprint, occurrenceCount: parsed.occurrenceCount,
      lastObservedAt: parsed.lastObservedAt || parsed.createdAt,
      escalationReason: parsed.escalationReason,
      relatedRunId: parsed.relatedRunId, suggestedGoal: parsed.suggestedGoal,
      evidence: parsed.evidence ?? null,
      resolvedAt: parsed.resolvedAt, createdAt: parsed.createdAt,
    }).run();
    return parsed;
  }

  listByCase(
    caseId: string,
    options: { status?: ObserverWarning["status"]; limit?: number; offset?: number } = {},
  ): { warnings: ObserverWarning[]; total: number } {
    const where = and(eq(observerWarnings.caseId, caseId), options.status ? eq(observerWarnings.status, options.status) : undefined);
    const warnings = this.db
      .select()
      .from(observerWarnings)
      .where(where)
      .limit(options.limit ?? Number.MAX_SAFE_INTEGER)
      .offset(options.offset ?? 0)
      .all()
      .map(rowToWarning);
    const totalRow = this.db.select({ count: sql<number>`count(*)` }).from(observerWarnings).where(where).get();
    return { warnings, total: totalRow?.count ?? 0 };
  }

  existsOpenDuplicate(caseId: string, title: string, description: string): boolean {
    const normalizedTitle = title.trim();
    const normalizedDescription = description.trim();
    const row = this.db
      .select()
      .from(observerWarnings)
      .where(
        and(
          eq(observerWarnings.caseId, caseId),
          eq(observerWarnings.status, "open"),
          eq(observerWarnings.title, normalizedTitle),
          eq(observerWarnings.description, normalizedDescription),
        ),
      )
      .get();
    return !!row;
  }

  getById(id: string): ObserverWarning | undefined {
    const row = this.db.select().from(observerWarnings).where(eq(observerWarnings.id, id)).get();
    return row ? rowToWarning(row) : undefined;
  }

  getActiveByFingerprint(caseId: string, fingerprint: string): ObserverWarning | undefined {
    const row = this.db.select().from(observerWarnings).where(and(
      eq(observerWarnings.caseId, caseId),
      eq(observerWarnings.fingerprint, fingerprint),
      inArray(observerWarnings.status, ["open", "detected", "correcting", "escalated"]),
    )).get();
    return row ? rowToWarning(row) : undefined;
  }

  observeAgain(id: string, input: { level: ObserverWarning["level"]; escalationReason?: string | null }): ObserverWarning | undefined {
    const current = this.getById(id);
    if (!current) return undefined;
    const occurrenceCount = current.occurrenceCount + 1;
    const lastObservedAt = new Date().toISOString();
    const status = input.level === "critical" && occurrenceCount >= 2 ? "escalated" : "detected";
    this.db.update(observerWarnings).set({
      level: input.level,
      status,
      occurrenceCount,
      lastObservedAt,
      escalationReason: input.escalationReason ?? null,
    }).where(eq(observerWarnings.id, id)).run();
    return ObserverWarningSchema.parse({
      ...current,
      level: input.level,
      status,
      occurrenceCount,
      lastObservedAt,
      escalationReason: input.escalationReason ?? null,
    });
  }

  updateStatus(id: string, status: ObserverWarning["status"]): ObserverWarning | undefined {
    const cur = this.getById(id);
    if (!cur) return undefined;
    const resolvedAt = new Date().toISOString();
    this.db.update(observerWarnings).set({ status, resolvedAt }).where(eq(observerWarnings.id, id)).run();
    return ObserverWarningSchema.parse({ ...cur, status, resolvedAt });
  }
}
