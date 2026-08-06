import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { ArtifactAnalysisAttemptSchema, type ArtifactAnalysisAttempt } from "@traceforge/shared";
import type { Db } from "../db/client.js";
import { artifactAnalysisAttempts } from "../db/schema.js";

function rowToAttempt(row: typeof artifactAnalysisAttempts.$inferSelect): ArtifactAnalysisAttempt {
  return ArtifactAnalysisAttemptSchema.parse({
    id: row.id,
    caseId: row.caseId,
    runId: row.runId,
    artifactId: row.artifactId,
    analyzerId: row.analyzerId,
    status: row.status,
    coverageDimensions: JSON.parse(row.coverageDimensionsJson),
    preflightFingerprint: row.preflightFingerprint,
    preflightAvailability: row.preflightAvailability,
    preflightReason: row.preflightReason,
    error: row.error,
    analysis: row.analysisJson ? JSON.parse(row.analysisJson) : null,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  });
}

export class ArtifactAnalysisAttemptStore {
  constructor(private readonly db: Db) {}

  start(input: {
    caseId: string;
    runId: string | null;
    artifactId: string;
    analyzerId: string | null;
    coverageDimensions: ArtifactAnalysisAttempt["coverageDimensions"];
    preflightFingerprint?: string | null;
    preflightAvailability?: ArtifactAnalysisAttempt["preflightAvailability"];
    preflightReason?: string | null;
    status?: "running" | "unsupported";
    error?: string | null;
  }): ArtifactAnalysisAttempt {
    const startedAt = new Date().toISOString();
    const status = input.status ?? "running";
    const attempt = ArtifactAnalysisAttemptSchema.parse({
      ...input,
      id: `artifact_attempt_${randomUUID()}`,
      status,
      error: input.error ?? null,
      analysis: null,
      startedAt,
      finishedAt: status === "running" ? null : startedAt,
    });
    this.db.insert(artifactAnalysisAttempts).values({
      id: attempt.id,
      caseId: attempt.caseId,
      runId: attempt.runId,
      artifactId: attempt.artifactId,
      analyzerId: attempt.analyzerId,
      status: attempt.status,
      coverageDimensionsJson: JSON.stringify(attempt.coverageDimensions),
      preflightFingerprint: attempt.preflightFingerprint,
      preflightAvailability: attempt.preflightAvailability,
      preflightReason: attempt.preflightReason,
      error: attempt.error,
      analysisJson: null,
      startedAt: attempt.startedAt,
      finishedAt: attempt.finishedAt,
    }).run();
    return attempt;
  }

  finish(
    id: string,
    status: "succeeded" | "failed",
    error: string | null = null,
    analysis: ArtifactAnalysisAttempt["analysis"] = null,
  ): ArtifactAnalysisAttempt | undefined {
    const current = this.getById(id);
    if (!current) return undefined;
    const finishedAt = new Date().toISOString();
    this.db.update(artifactAnalysisAttempts).set({
      status,
      error,
      analysisJson: analysis ? JSON.stringify(analysis) : null,
      finishedAt,
    })
      .where(eq(artifactAnalysisAttempts.id, id)).run();
    return { ...current, status, error, analysis, finishedAt };
  }

  getById(id: string): ArtifactAnalysisAttempt | undefined {
    const row = this.db.select().from(artifactAnalysisAttempts)
      .where(eq(artifactAnalysisAttempts.id, id)).get();
    return row ? rowToAttempt(row) : undefined;
  }

  listByArtifact(artifactId: string): ArtifactAnalysisAttempt[] {
    return this.db.select().from(artifactAnalysisAttempts)
      .where(eq(artifactAnalysisAttempts.artifactId, artifactId)).all()
      .map(rowToAttempt)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }

  listByCase(caseId: string): ArtifactAnalysisAttempt[] {
    return this.db.select().from(artifactAnalysisAttempts)
      .where(eq(artifactAnalysisAttempts.caseId, caseId)).all()
      .map(rowToAttempt)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }

  recoverInterrupted(): ArtifactAnalysisAttempt[] {
    const running = this.db.select().from(artifactAnalysisAttempts)
      .where(eq(artifactAnalysisAttempts.status, "running")).all()
      .map(rowToAttempt);
    return running.flatMap((attempt) => {
      const recovered = this.finish(
        attempt.id,
        "failed",
        "Analysis process ended before a result was persisted; retry only after checking analyzer availability.",
      );
      return recovered ? [recovered] : [];
    });
  }
}
