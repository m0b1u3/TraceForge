import { desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { runCognitiveState } from "../db/schema.js";
import { type SessionState, SessionStateSchema } from "@traceforge/shared";

export class SessionStateStore {
  constructor(private db: Db) {}

  getLatestByCase(caseId: string): SessionState | undefined {
    const row = this.db.select().from(runCognitiveState)
      .where(eq(runCognitiveState.caseId, caseId))
      .orderBy(desc(runCognitiveState.updatedAt))
      .get();
    if (!row) return undefined;
    return SessionStateSchema.parse({
      caseId: row.caseId,
      runId: row.runId,
      currentGoal: row.currentGoal,
      phase: row.phase,
      focus: JSON.parse(row.focusJson),
      activeHypothesisIds: JSON.parse(row.activeHypothesisIdsJson),
      updatedAt: row.updatedAt,
    });
  }

  get(caseId: string, runId: string): SessionState | undefined {
    const row = this.db.select().from(runCognitiveState)
      .where(eq(runCognitiveState.runId, runId)).get();
    if (!row || row.caseId !== caseId) return undefined;
    return SessionStateSchema.parse({
      caseId: row.caseId,
      runId: row.runId,
      currentGoal: row.currentGoal,
      phase: row.phase,
      focus: JSON.parse(row.focusJson),
      activeHypothesisIds: JSON.parse(row.activeHypothesisIdsJson),
      updatedAt: row.updatedAt,
    });
  }

  upsert(
    caseId: string,
    patch: Partial<Pick<SessionState, "currentGoal" | "phase" | "focus" | "activeHypothesisIds">>,
    runId: string,
  ): SessionState {
    const current = this.get(caseId, runId);
    const next = SessionStateSchema.parse({
      caseId,
      runId,
      currentGoal: patch.currentGoal ?? current?.currentGoal ?? "",
      phase: patch.phase ?? current?.phase ?? "discover",
      focus: patch.focus ?? current?.focus ?? {},
      activeHypothesisIds: patch.activeHypothesisIds ?? current?.activeHypothesisIds ?? [],
      updatedAt: new Date().toISOString(),
    });
    const values = {
      runId,
      caseId,
      currentGoal: next.currentGoal,
      phase: next.phase,
      focusJson: JSON.stringify(next.focus),
      activeHypothesisIdsJson: JSON.stringify(next.activeHypothesisIds),
      updatedAt: next.updatedAt,
    };
    this.db.insert(runCognitiveState).values(values)
      .onConflictDoUpdate({ target: runCognitiveState.runId, set: values }).run();
    return next;
  }
}
