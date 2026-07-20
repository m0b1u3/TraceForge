import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { runCognitiveState, sessionState } from "../db/schema.js";
import { type SessionState, SessionStateSchema } from "@traceforge/shared";

export class SessionStateStore {
  constructor(private db: Db) {}

  get(caseId: string, runId?: string | null): SessionState | undefined {
    if (runId) {
      const runRow = this.db.select().from(runCognitiveState).where(eq(runCognitiveState.runId, runId)).get();
      if (!runRow) return undefined;
      return SessionStateSchema.parse({
        caseId: runRow.caseId, runId: runRow.runId, currentGoal: runRow.currentGoal,
        phase: normalizePhase(runRow.phase), focus: JSON.parse(runRow.focusJson),
        activeHypothesisIds: JSON.parse(runRow.activeHypothesisIdsJson), updatedAt: runRow.updatedAt,
      });
    }
    const row = this.db.select().from(sessionState).where(eq(sessionState.caseId, caseId)).get();
    if (!row) return undefined;
    return SessionStateSchema.parse({
      caseId: row.caseId,
      runId: row.runId,
      currentGoal: row.currentGoal,
      phase: normalizePhase(row.phase),
      focus: JSON.parse(row.focusJson),
      activeHypothesisIds: JSON.parse(row.activeHypothesisIdsJson),
      updatedAt: row.updatedAt,
    });
  }

  upsert(
    caseId: string,
    patch: Partial<Pick<SessionState, "currentGoal" | "phase" | "focus" | "activeHypothesisIds">>,
    runId?: string | null,
  ): SessionState {
    const cur = this.get(caseId, runId);
    const next = SessionStateSchema.parse({
      caseId,
      runId: runId ?? null,
      currentGoal: patch.currentGoal ?? cur?.currentGoal ?? "",
      phase: patch.phase ?? cur?.phase ?? "discover",
      focus: patch.focus ?? cur?.focus ?? {},
      activeHypothesisIds: patch.activeHypothesisIds ?? cur?.activeHypothesisIds ?? [],
      updatedAt: new Date().toISOString(),
    });
    if (runId) {
      const runValues = {
        runId, caseId, currentGoal: next.currentGoal, phase: next.phase,
        focusJson: JSON.stringify(next.focus), activeHypothesisIdsJson: JSON.stringify(next.activeHypothesisIds),
        updatedAt: next.updatedAt,
      };
      this.db.insert(runCognitiveState).values(runValues)
        .onConflictDoUpdate({ target: runCognitiveState.runId, set: runValues }).run();
      return next;
    }
    const values = {
      caseId,
      runId: null,
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

function normalizePhase(phase: string): SessionState["phase"] {
  if (["scope", "discover", "map", "test", "validate", "chain", "report"].includes(phase)) {
    return phase as SessionState["phase"];
  }
  if (phase === "recon") return "discover";
  if (phase === "analyze") return "map";
  if (phase === "exploit") return "test";
  return "discover";
}
