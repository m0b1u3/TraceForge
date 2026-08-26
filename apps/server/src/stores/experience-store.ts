import { desc, eq } from "drizzle-orm";
import { ExperienceEntrySchema, type ExperienceEntry } from "@traceforge/shared";
import type { Db } from "../db/client.js";
import { experienceEntries } from "../db/schema.js";

export class ExperienceStore {
  constructor(private readonly db: Db) {}

  save(value: ExperienceEntry): ExperienceEntry {
    const entry = ExperienceEntrySchema.parse(value);
    const row = {
      id: entry.id, title: entry.title, applicability: entry.applicability,
      procedureJson: JSON.stringify(entry.procedure), expectedSignalsJson: JSON.stringify(entry.expectedSignals),
      failureModesJson: JSON.stringify(entry.failureModes), evidenceRequirementsJson: JSON.stringify(entry.evidenceRequirements),
      sourceCaseId: entry.sourceCaseId, sourceRunId: entry.sourceRunId, sourceTaskId: entry.sourceTaskId,
      evidenceFactIdsJson: JSON.stringify(entry.evidenceFactIds), status: entry.status, version: entry.version,
      successCount: entry.successCount, failureCount: entry.failureCount, tagsJson: JSON.stringify(entry.tags),
      createdAt: entry.createdAt, updatedAt: entry.updatedAt,
    };
    this.db.insert(experienceEntries).values(row).onConflictDoUpdate({ target: experienceEntries.id, set: row }).run();
    return entry;
  }

  get(id: string): ExperienceEntry | undefined {
    const row = this.db.select().from(experienceEntries).where(eq(experienceEntries.id, id)).get();
    return row ? this.parse(row) : undefined;
  }

  list(status?: ExperienceEntry["status"]): ExperienceEntry[] {
    const rows = status
      ? this.db.select().from(experienceEntries).where(eq(experienceEntries.status, status)).orderBy(desc(experienceEntries.updatedAt)).all()
      : this.db.select().from(experienceEntries).orderBy(desc(experienceEntries.updatedAt)).all();
    return rows.map((row) => this.parse(row));
  }

  private parse(row: typeof experienceEntries.$inferSelect): ExperienceEntry {
    return ExperienceEntrySchema.parse({
      id: row.id, title: row.title, applicability: row.applicability,
      procedure: JSON.parse(row.procedureJson), expectedSignals: JSON.parse(row.expectedSignalsJson),
      failureModes: JSON.parse(row.failureModesJson), evidenceRequirements: JSON.parse(row.evidenceRequirementsJson),
      sourceCaseId: row.sourceCaseId, sourceRunId: row.sourceRunId, sourceTaskId: row.sourceTaskId,
      evidenceFactIds: JSON.parse(row.evidenceFactIdsJson), status: row.status, version: row.version,
      successCount: row.successCount, failureCount: row.failureCount, tags: JSON.parse(row.tagsJson),
      createdAt: row.createdAt, updatedAt: row.updatedAt,
    });
  }
}
