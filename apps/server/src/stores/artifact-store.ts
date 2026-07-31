import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { artifacts } from "../db/schema.js";
import type { ArtifactAnalysis, ArtifactRecord, ArtifactStatus } from "../artifact-types.js";

function rowToArtifact(row: typeof artifacts.$inferSelect): ArtifactRecord {
  return {
    id: row.id,
    caseId: row.caseId,
    runId: row.runId,
    sourceUrl: row.sourceUrl,
    filename: row.filename,
    relativePath: row.relativePath,
    byteSize: row.byteSize,
    sha256: row.sha256,
    detectedFormat: row.detectedFormat,
    mediaType: row.mediaType,
    status: row.status as ArtifactStatus,
    analyzerId: row.analyzerId,
    analysis: row.analysisJson ? JSON.parse(row.analysisJson) as ArtifactAnalysis : null,
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class ArtifactStore {
  constructor(private readonly db: Db) {}

  record(input: Omit<ArtifactRecord, "id" | "status" | "analyzerId" | "analysis" | "error" | "createdAt" | "updatedAt">): ArtifactRecord {
    const existing = this.db.select().from(artifacts).where(and(
      eq(artifacts.caseId, input.caseId),
      eq(artifacts.sha256, input.sha256),
    )).get();
    if (existing) return rowToArtifact(existing);
    const now = new Date().toISOString();
    const record: ArtifactRecord = {
      ...input,
      id: `artifact_${randomUUID()}`,
      status: "downloaded",
      analyzerId: null,
      analysis: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.insert(artifacts).values({
      id: record.id,
      caseId: record.caseId,
      runId: record.runId,
      sourceUrl: record.sourceUrl,
      filename: record.filename,
      relativePath: record.relativePath,
      byteSize: record.byteSize,
      sha256: record.sha256,
      detectedFormat: record.detectedFormat,
      mediaType: record.mediaType,
      status: record.status,
      analyzerId: null,
      analysisJson: null,
      error: null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }).run();
    return record;
  }

  getById(id: string): ArtifactRecord | undefined {
    const row = this.db.select().from(artifacts).where(eq(artifacts.id, id)).get();
    return row ? rowToArtifact(row) : undefined;
  }

  listByCase(caseId: string): ArtifactRecord[] {
    return this.db.select().from(artifacts).where(eq(artifacts.caseId, caseId)).all().map(rowToArtifact);
  }

  updateAnalysis(
    id: string,
    status: ArtifactStatus,
    analyzerId: string | null,
    analysis: ArtifactAnalysis | null,
    error: string | null = null,
  ): ArtifactRecord | undefined {
    const current = this.getById(id);
    if (!current) return undefined;
    const updatedAt = new Date().toISOString();
    this.db.update(artifacts).set({
      status,
      analyzerId,
      analysisJson: analysis ? JSON.stringify(analysis) : null,
      error,
      updatedAt,
    }).where(eq(artifacts.id, id)).run();
    return { ...current, status, analyzerId, analysis, error, updatedAt };
  }
}
