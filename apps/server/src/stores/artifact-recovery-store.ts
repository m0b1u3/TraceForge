import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { ArtifactRecoverySchema, type ArtifactRecovery } from "@traceforge/shared";
import type { Db } from "../db/client.js";
import { artifactRecoveries } from "../db/schema.js";

function fromRow(row: typeof artifactRecoveries.$inferSelect): ArtifactRecovery {
  return ArtifactRecoverySchema.parse(row);
}

export class ArtifactRecoveryStore {
  constructor(private readonly db: Db) {}

  create(input: Omit<ArtifactRecovery, "id" | "afterFingerprint" | "result" | "status" | "createdAt" | "updatedAt">): ArtifactRecovery {
    const active = this.getActive(input.artifactId, input.analyzerId);
    if (active
      && active.caseId === input.caseId
      && active.runId === input.runId
      && active.taskId === input.taskId
      && active.failedAttemptId === input.failedAttemptId
      && active.beforeFingerprint === input.beforeFingerprint) return active;
    if (active) this.update(active.id, { status: "cancelled", result: "Superseded by a recovery for the current task or analyzer state." });
    const now = new Date().toISOString();
    const recovery = ArtifactRecoverySchema.parse({
      ...input, id: `artifact_recovery_${randomUUID()}`, afterFingerprint: null,
      result: null, status: "planned", createdAt: now, updatedAt: now,
    });
    this.db.insert(artifactRecoveries).values(recovery).run();
    return recovery;
  }

  update(id: string, patch: Partial<Pick<ArtifactRecovery, "status" | "afterFingerprint" | "result">>): ArtifactRecovery | undefined {
    const current = this.getById(id);
    if (!current) return undefined;
    const updatedAt = new Date().toISOString();
    const next = ArtifactRecoverySchema.parse({ ...current, ...patch, updatedAt });
    this.db.update(artifactRecoveries).set({
      status: next.status, afterFingerprint: next.afterFingerprint,
      result: next.result, updatedAt,
    }).where(eq(artifactRecoveries.id, id)).run();
    return next;
  }

  getById(id: string): ArtifactRecovery | undefined {
    const row = this.db.select().from(artifactRecoveries).where(eq(artifactRecoveries.id, id)).get();
    return row ? fromRow(row) : undefined;
  }

  getActive(artifactId: string, analyzerId: string): ArtifactRecovery | undefined {
    const rows = this.db.select().from(artifactRecoveries).where(and(
      eq(artifactRecoveries.artifactId, artifactId),
      eq(artifactRecoveries.analyzerId, analyzerId),
      inArray(artifactRecoveries.status, ["planned", "running"]),
    )).all();
    return rows.map(fromRow).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  }

  listByCase(caseId: string): ArtifactRecovery[] {
    return this.db.select().from(artifactRecoveries).where(eq(artifactRecoveries.caseId, caseId)).all()
      .map(fromRow).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }
}
