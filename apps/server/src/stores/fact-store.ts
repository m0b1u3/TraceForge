import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { facts } from "../db/schema.js";
import { type Fact, FactSchema } from "@traceforge/shared";

type FactInput = Omit<Fact, "id" | "caseId" | "createdAt">;

export class FactStore {
  constructor(private db: Db) {}

  create(caseId: string, input: FactInput): Fact {
    const id = `fact_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const f = FactSchema.parse({ ...input, id, caseId, createdAt });
    this.db.insert(facts).values({
      id, caseId, type: f.type, title: f.title,
      valueJson: JSON.stringify(f.value), sourceJson: JSON.stringify(f.source),
      confidence: f.confidence, tagsJson: JSON.stringify(f.tags), createdAt,
    }).run();
    return f;
  }

  listByCase(caseId: string): Fact[] {
    return this.db.select().from(facts).where(eq(facts.caseId, caseId)).all().map((row) =>
      FactSchema.parse({
        id: row.id, caseId: row.caseId, type: row.type, title: row.title,
        value: JSON.parse(row.valueJson), source: JSON.parse(row.sourceJson),
        confidence: row.confidence, tags: JSON.parse(row.tagsJson), createdAt: row.createdAt,
      }),
    );
  }
}
