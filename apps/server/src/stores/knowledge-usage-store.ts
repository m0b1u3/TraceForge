import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { knowledgeUsage } from "../db/schema.js";

export type KnowledgeKind = "fact" | "identity" | "attack_path";
export interface KnowledgeRef { id: string; kind: KnowledgeKind }
export interface KnowledgeUsageScore {
  injected: number;
  used: number;
  positiveOutcome: number;
  negativeOutcome: number;
}

const rowId = (runId: string, ref: KnowledgeRef): string => `${runId}:${ref.kind}:${ref.id}`;

export class KnowledgeUsageStore {
  constructor(private readonly db: Db) {}

  recordInjected(caseId: string, runId: string, refs: KnowledgeRef[]): void {
    const now = new Date().toISOString();
    for (const ref of refs) {
      const id = rowId(runId, ref);
      const existing = this.db.select().from(knowledgeUsage).where(eq(knowledgeUsage.id, id)).get();
      if (existing) {
        this.db.update(knowledgeUsage).set({
          injectedCount: existing.injectedCount + 1,
          lastInjectedAt: now,
        }).where(eq(knowledgeUsage.id, id)).run();
      } else {
        this.db.insert(knowledgeUsage).values({
          id,
          caseId,
          runId,
          knowledgeId: ref.id,
          knowledgeKind: ref.kind,
          injectedCount: 1,
          usedCount: 0,
          positiveOutcomeScore: 0,
          negativeOutcomeScore: 0,
          firstInjectedAt: now,
          lastInjectedAt: now,
        }).run();
      }
    }
  }

  markReferenced(caseId: string, runId: string, payload: unknown, available: KnowledgeRef[]): KnowledgeRef[] {
    const serialized = typeof payload === "string" ? payload : JSON.stringify(payload);
    const matched = available.filter((ref) => serialized.includes(ref.id));
    this.markUsed(caseId, runId, matched);
    return matched;
  }

  markUsed(caseId: string, runId: string, refs: KnowledgeRef[]): void {
    const now = new Date().toISOString();
    for (const ref of refs) {
      const id = rowId(runId, ref);
      const existing = this.db.select().from(knowledgeUsage).where(and(
        eq(knowledgeUsage.id, id),
        eq(knowledgeUsage.caseId, caseId),
      )).get();
      if (!existing) continue;
      this.db.update(knowledgeUsage).set({
        usedCount: existing.usedCount + 1,
        lastUsedAt: now,
      }).where(eq(knowledgeUsage.id, id)).run();
    }
  }

  recordOutcome(caseId: string, runId: string, refs: KnowledgeRef[], positive: number, negative: number): void {
    if (positive <= 0 && negative <= 0) return;
    for (const ref of refs) {
      const id = rowId(runId, ref);
      const existing = this.db.select().from(knowledgeUsage).where(and(
        eq(knowledgeUsage.id, id),
        eq(knowledgeUsage.caseId, caseId),
      )).get();
      if (!existing) continue;
      this.db.update(knowledgeUsage).set({
        positiveOutcomeScore: existing.positiveOutcomeScore + positive,
        negativeOutcomeScore: existing.negativeOutcomeScore + negative,
      }).where(eq(knowledgeUsage.id, id)).run();
    }
  }

  scores(caseId: string, excludeRunId?: string): Map<string, KnowledgeUsageScore> {
    const rows = this.db.select().from(knowledgeUsage).where(eq(knowledgeUsage.caseId, caseId)).all();
    const scores = new Map<string, KnowledgeUsageScore>();
    for (const row of rows) {
      if (row.runId === excludeRunId) continue;
      const current = scores.get(row.knowledgeId) ?? {
        injected: 0,
        used: 0,
        positiveOutcome: 0,
        negativeOutcome: 0,
      };
      current.injected += row.injectedCount;
      current.used += row.usedCount;
      current.positiveOutcome += row.positiveOutcomeScore;
      current.negativeOutcome += row.negativeOutcomeScore;
      scores.set(row.knowledgeId, current);
    }
    return scores;
  }

  list(caseId: string, runId?: string) {
    const rows = this.db.select().from(knowledgeUsage).where(eq(knowledgeUsage.caseId, caseId)).all();
    return runId ? rows.filter((row) => row.runId === runId) : rows;
  }
}
