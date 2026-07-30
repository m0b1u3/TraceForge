import { eq, and, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { observerWarnings } from "../db/schema.js";
import { type ObserverWarning, ObserverWarningSchema } from "@traceforge/shared";
import { nextObserverStatus } from "../observer-policy.js";

function rowToWarning(row: typeof observerWarnings.$inferSelect): ObserverWarning {
  return ObserverWarningSchema.parse({
    id: row.id, caseId: row.caseId, level: row.level, title: row.title, description: row.description,
    issueType: row.issueType, subject: row.subject,
    relatedFacts: JSON.parse(row.relatedFactsJson), relatedTasks: JSON.parse(row.relatedTasksJson),
    suggestedAction: row.suggestedAction, status: row.status, relatedRunId: row.relatedRunId,
    suggestedGoal: row.suggestedGoal, evidence: row.evidence ?? undefined,
    fingerprint: row.fingerprint, occurrenceCount: row.occurrenceCount,
    lastObservedAt: row.lastObservedAt, escalationReason: row.escalationReason,
    correctionCount: row.correctionCount,
    correctionResolvedCount: row.correctionResolvedCount,
    correctionFailedCount: row.correctionFailedCount,
    correctionOutcome: row.correctionOutcome,
    lastCorrectionAt: row.lastCorrectionAt,
    lastCorrectionTrigger: row.lastCorrectionTrigger,
    resolvedAt: row.resolvedAt, createdAt: row.createdAt,
  });
}

export class ObserverWarningStore {
  constructor(private db: Db) {}

  create(w: ObserverWarning): ObserverWarning {
    const parsed = ObserverWarningSchema.parse(w);
    this.db.insert(observerWarnings).values({
      id: parsed.id, caseId: parsed.caseId, level: parsed.level,
      issueType: parsed.issueType, subject: parsed.subject,
      title: parsed.title, description: parsed.description,
      relatedFactsJson: JSON.stringify(parsed.relatedFacts),
      relatedTasksJson: JSON.stringify(parsed.relatedTasks),
      suggestedAction: parsed.suggestedAction, status: parsed.status,
      fingerprint: parsed.fingerprint, occurrenceCount: parsed.occurrenceCount,
      lastObservedAt: parsed.lastObservedAt || parsed.createdAt,
      correctionCount: parsed.correctionCount,
      correctionResolvedCount: parsed.correctionResolvedCount,
      correctionFailedCount: parsed.correctionFailedCount,
      correctionOutcome: parsed.correctionOutcome,
      lastCorrectionAt: parsed.lastCorrectionAt,
      lastCorrectionTrigger: parsed.lastCorrectionTrigger,
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

  getActiveByFingerprint(caseId: string, runId: string, fingerprint: string): ObserverWarning | undefined {
    const row = this.db.select().from(observerWarnings).where(and(
      eq(observerWarnings.caseId, caseId),
      eq(observerWarnings.relatedRunId, runId),
      eq(observerWarnings.fingerprint, fingerprint),
      inArray(observerWarnings.status, ["open", "detected", "correcting", "escalated"]),
    )).get();
    return row ? rowToWarning(row) : undefined;
  }

  resolveActiveFromOtherRuns(caseId: string, runId: string): ObserverWarning[] {
    const rows = this.db.select().from(observerWarnings).where(and(
      eq(observerWarnings.caseId, caseId),
      or(isNull(observerWarnings.relatedRunId), ne(observerWarnings.relatedRunId, runId)),
      inArray(observerWarnings.status, ["open", "detected", "correcting", "escalated"]),
    )).all();
    if (rows.length === 0) return [];
    const resolvedAt = new Date().toISOString();
    const ids = rows.map((row) => row.id);
    this.db.update(observerWarnings)
      .set({ status: "resolved", resolvedAt })
      .where(inArray(observerWarnings.id, ids))
      .run();
    return rows.map((row) => ObserverWarningSchema.parse({
      ...rowToWarning(row),
      status: "resolved",
      resolvedAt,
    }));
  }

  observeAgain(id: string, input: { level: ObserverWarning["level"]; escalationReason?: string | null }): ObserverWarning | undefined {
    const current = this.getById(id);
    if (!current) return undefined;
    if (current.status === "escalated") return current;
    const occurrenceCount = current.occurrenceCount + 1;
    const lastObservedAt = new Date().toISOString();
    const status = nextObserverStatus(current.status, input.level);
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

  recordCorrection(id: string, trigger: string): ObserverWarning | undefined {
    const current = this.getById(id);
    if (!current) return undefined;
    const lastCorrectionAt = new Date().toISOString();
    const correctionCount = current.correctionCount + 1;
    this.db.update(observerWarnings).set({
      correctionCount,
      correctionOutcome: "pending",
      lastCorrectionAt,
      lastCorrectionTrigger: trigger,
    }).where(eq(observerWarnings.id, id)).run();
    return ObserverWarningSchema.parse({
      ...current,
      correctionCount,
      correctionOutcome: "pending",
      lastCorrectionAt,
      lastCorrectionTrigger: trigger,
    });
  }

  settleCorrection(
    id: string,
    outcome: Extract<ObserverWarning["correctionOutcome"], "resolved" | "persisted" | "escalated">,
  ): ObserverWarning | undefined {
    const current = this.getById(id);
    if (!current) return undefined;
    if (current.correctionOutcome !== "pending") return current;
    const correctionResolvedCount = current.correctionResolvedCount + (outcome === "resolved" ? 1 : 0);
    const correctionFailedCount = current.correctionFailedCount + (outcome === "resolved" ? 0 : 1);
    this.db.update(observerWarnings).set({
      correctionOutcome: outcome,
      correctionResolvedCount,
      correctionFailedCount,
    }).where(eq(observerWarnings.id, id)).run();
    return ObserverWarningSchema.parse({
      ...current,
      correctionOutcome: outcome,
      correctionResolvedCount,
      correctionFailedCount,
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
