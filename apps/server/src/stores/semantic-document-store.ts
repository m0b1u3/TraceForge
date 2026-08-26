import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { semanticDocuments } from "../db/schema.js";

export interface SemanticDocument {
  id: string;
  caseId: string | null;
  kind: string;
  sourceId: string;
  textHash: string;
  content: string;
  model: string;
  dimensions: number;
  vector: number[];
  updatedAt: string;
}

export class SemanticDocumentStore {
  constructor(private readonly db: Db) {}

  save(document: SemanticDocument): void {
    this.db.insert(semanticDocuments).values({
      ...document,
      vectorJson: JSON.stringify(document.vector),
    }).onConflictDoUpdate({
      target: semanticDocuments.id,
      set: {
        caseId: document.caseId, kind: document.kind, sourceId: document.sourceId,
        textHash: document.textHash, content: document.content, model: document.model,
        dimensions: document.dimensions, vectorJson: JSON.stringify(document.vector), updatedAt: document.updatedAt,
      },
    }).run();
  }

  get(kind: string, sourceId: string): SemanticDocument | undefined {
    const row = this.db.select().from(semanticDocuments).where(and(eq(semanticDocuments.kind, kind), eq(semanticDocuments.sourceId, sourceId))).get();
    return row ? this.parse(row) : undefined;
  }

  list(caseId: string | null, kind: string): SemanticDocument[] {
    const rows = caseId === null
      ? this.db.select().from(semanticDocuments).where(and(eq(semanticDocuments.kind, kind), isNull(semanticDocuments.caseId))).all()
      : this.db.select().from(semanticDocuments).where(and(eq(semanticDocuments.kind, kind), eq(semanticDocuments.caseId, caseId))).all();
    return rows.map((row) => this.parse(row));
  }

  deleteByCase(caseId: string): number {
    return this.db.delete(semanticDocuments).where(eq(semanticDocuments.caseId, caseId)).run().changes;
  }

  private parse(row: typeof semanticDocuments.$inferSelect): SemanticDocument {
    return { ...row, vector: JSON.parse(row.vectorJson) as number[] };
  }
}
