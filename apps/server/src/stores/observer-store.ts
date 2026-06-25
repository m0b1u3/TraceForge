import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { observerWarnings } from "../db/schema.js";
import { type ObserverWarning, ObserverWarningSchema } from "@traceforge/shared";

export class ObserverWarningStore {
  constructor(private db: Db) {}

  create(w: ObserverWarning): ObserverWarning {
    const parsed = ObserverWarningSchema.parse(w);
    this.db.insert(observerWarnings).values({
      id: parsed.id, caseId: parsed.caseId, level: parsed.level,
      title: parsed.title, description: parsed.description,
      relatedFactsJson: JSON.stringify(parsed.relatedFacts),
      relatedTasksJson: JSON.stringify(parsed.relatedTasks),
      suggestedAction: parsed.suggestedAction, createdAt: parsed.createdAt,
    }).run();
    return parsed;
  }

  listByCase(caseId: string): ObserverWarning[] {
    return this.db.select().from(observerWarnings).where(eq(observerWarnings.caseId, caseId)).all().map((row) =>
      ObserverWarningSchema.parse({
        id: row.id, caseId: row.caseId, level: row.level, title: row.title, description: row.description,
        relatedFacts: JSON.parse(row.relatedFactsJson), relatedTasks: JSON.parse(row.relatedTasksJson),
        suggestedAction: row.suggestedAction, createdAt: row.createdAt,
      }),
    );
  }
}
