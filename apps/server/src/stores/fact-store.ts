import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { facts } from "../db/schema.js";
import { type Fact, FactSchema } from "@traceforge/shared";

type FactInput = Omit<Fact, "id" | "caseId" | "createdAt" | "updateCount" | "updatedAt" | "validity"> & Partial<Pick<Fact, "validity">>;

function rowToFact(row: typeof facts.$inferSelect): Fact {
  return FactSchema.parse({
    id: row.id, caseId: row.caseId, type: row.type, title: row.title,
    value: JSON.parse(row.valueJson), source: JSON.parse(row.sourceJson),
    confidence: row.confidence, tags: JSON.parse(row.tagsJson), createdAt: row.createdAt,
    updateCount: row.updateCount, updatedAt: row.updatedAt, validity: row.validity,
  });
}

export class FactStore {
  constructor(private db: Db) {}

  create(caseId: string, input: FactInput): Fact {
    const id = `fact_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const f = FactSchema.parse({ ...input, id, caseId, createdAt, updateCount: 0, updatedAt: createdAt });
    this.db.insert(facts).values({
      id, caseId, type: f.type, title: f.title,
      valueJson: JSON.stringify(f.value), sourceJson: JSON.stringify(f.source),
      confidence: f.confidence, tagsJson: JSON.stringify(f.tags), createdAt,
      updateCount: 0, updatedAt: createdAt, validity: f.validity,
    }).run();
    return f;
  }

  getById(id: string): Fact | undefined {
    const row = this.db.select().from(facts).where(eq(facts.id, id)).get();
    return row ? rowToFact(row) : undefined;
  }

  update(id: string, patch: Partial<Pick<Fact, "type" | "title" | "value" | "confidence" | "tags" | "validity">>): Fact | undefined {
    const cur = this.getById(id);
    if (!cur) return undefined;
    const updatedAt = new Date().toISOString();
    const next = FactSchema.parse({ ...cur, ...patch, updateCount: cur.updateCount + 1, updatedAt });
    this.db.update(facts).set({
      type: next.type, title: next.title,
      valueJson: JSON.stringify(next.value), confidence: next.confidence,
      tagsJson: JSON.stringify(next.tags), validity: next.validity,
      updateCount: next.updateCount, updatedAt,
    }).where(eq(facts.id, id)).run();
    return next;
  }

  listByCase(caseId: string): Fact[] {
    return this.db.select().from(facts).where(eq(facts.caseId, caseId)).all().map(rowToFact);
  }
}
