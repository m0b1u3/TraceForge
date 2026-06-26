import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { sessionState } from "../db/schema.js";
import { type SessionState, SessionStateSchema } from "@traceforge/shared";

export class SessionStateStore {
  constructor(private db: Db) {}

  get(caseId: string): SessionState | undefined {
    const row = this.db.select().from(sessionState).where(eq(sessionState.caseId, caseId)).get();
    if (!row) return undefined;
    return SessionStateSchema.parse({
      caseId: row.caseId,
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
  ): SessionState {
    const cur = this.get(caseId);
    const next = SessionStateSchema.parse({
      caseId,
      currentGoal: patch.currentGoal ?? cur?.currentGoal ?? "",
      phase: patch.phase ?? cur?.phase ?? "recon",
      focus: patch.focus ?? cur?.focus ?? {},
      activeHypothesisIds: patch.activeHypothesisIds ?? cur?.activeHypothesisIds ?? [],
      updatedAt: new Date().toISOString(),
    });
    const values = {
      caseId,
      currentGoal: next.currentGoal,
      phase: next.phase,
      focusJson: JSON.stringify(next.focus),
      activeHypothesisIdsJson: JSON.stringify(next.activeHypothesisIds),
      updatedAt: next.updatedAt,
    };
    this.db
      .insert(sessionState)
      .values(values)
      .onConflictDoUpdate({ target: sessionState.caseId, set: values })
      .run();
    return next;
  }
}
