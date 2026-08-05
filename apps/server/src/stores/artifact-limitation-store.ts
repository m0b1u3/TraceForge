import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { ArtifactLimitationDispositionSchema, type ArtifactLimitationDisposition } from "@traceforge/shared";
import type { Db } from "../db/client.js";
import { artifactLimitationDispositions } from "../db/schema.js";

const PROHIBITED = "This limitation does not prove content absence and cannot verify or reject a security finding." as const;

function fromRow(row: typeof artifactLimitationDispositions.$inferSelect): ArtifactLimitationDisposition {
  return ArtifactLimitationDispositionSchema.parse({
    id: row.id, caseId: row.caseId, runId: row.runId, taskId: row.taskId, artifactId: row.artifactId,
    status: row.status, missingDimensions: JSON.parse(row.missingDimensionsJson), attemptIds: JSON.parse(row.attemptIdsJson),
    rationale: row.rationale, prohibitedConclusion: row.prohibitedConclusion, createdAt: row.createdAt, updatedAt: row.updatedAt,
  });
}

export class ArtifactLimitationStore {
  constructor(private readonly db: Db) {}

  accept(input: Omit<ArtifactLimitationDisposition, "id" | "status" | "prohibitedConclusion" | "createdAt" | "updatedAt">): ArtifactLimitationDisposition {
    const current = this.getActive(input.taskId, input.artifactId);
    if (current) this.revoke(current.id);
    const now = new Date().toISOString();
    const value = ArtifactLimitationDispositionSchema.parse({
      ...input, id: `artifact_limitation_${randomUUID()}`, status: "accepted", prohibitedConclusion: PROHIBITED,
      createdAt: now, updatedAt: now,
    });
    this.db.insert(artifactLimitationDispositions).values({
      ...value,
      missingDimensionsJson: JSON.stringify(value.missingDimensions),
      attemptIdsJson: JSON.stringify(value.attemptIds),
    }).run();
    return value;
  }

  revoke(id: string): ArtifactLimitationDisposition | undefined {
    const current = this.getById(id);
    if (!current) return undefined;
    const updatedAt = new Date().toISOString();
    this.db.update(artifactLimitationDispositions).set({ status: "revoked", updatedAt }).where(eq(artifactLimitationDispositions.id, id)).run();
    return { ...current, status: "revoked", updatedAt };
  }

  getById(id: string): ArtifactLimitationDisposition | undefined {
    const row = this.db.select().from(artifactLimitationDispositions).where(eq(artifactLimitationDispositions.id, id)).get();
    return row ? fromRow(row) : undefined;
  }

  getActive(taskId: string, artifactId: string): ArtifactLimitationDisposition | undefined {
    const rows = this.db.select().from(artifactLimitationDispositions).where(and(
      eq(artifactLimitationDispositions.taskId, taskId), eq(artifactLimitationDispositions.artifactId, artifactId),
    )).all().map(fromRow).filter((item) => item.status === "accepted");
    return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  }

  listByCase(caseId: string): ArtifactLimitationDisposition[] {
    return this.db.select().from(artifactLimitationDispositions).where(eq(artifactLimitationDispositions.caseId, caseId)).all().map(fromRow)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}
