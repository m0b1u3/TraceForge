import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { hypotheses } from "../db/schema.js";
import { type Hypothesis, HypothesisSchema } from "@traceforge/shared";

function rowToH(row: typeof hypotheses.$inferSelect): Hypothesis {
  return HypothesisSchema.parse({
    id: row.id,
    caseId: row.caseId,
    statement: row.statement,
    status: row.status,
    basedOnFactIds: JSON.parse(row.basedOnFactIdsJson),
    relatedTaskIds: JSON.parse(row.relatedTaskIdsJson),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    updateCount: row.updateCount,
  });
}

export class HypothesisStore {
  constructor(private db: Db) {}

  create(
    caseId: string,
    input: { statement: string; basedOnFactIds: string[]; relatedTaskIds?: string[] },
  ): Hypothesis {
    const now = new Date().toISOString();
    const h = HypothesisSchema.parse({
      id: `hyp_${randomUUID()}`,
      caseId,
      statement: input.statement,
      status: "open",
      basedOnFactIds: input.basedOnFactIds,
      relatedTaskIds: input.relatedTaskIds ?? [],
      createdAt: now,
      updatedAt: now,
      updateCount: 0,
    });
    this.db
      .insert(hypotheses)
      .values({
        id: h.id,
        caseId,
        statement: h.statement,
        status: h.status,
        basedOnFactIdsJson: JSON.stringify(h.basedOnFactIds),
        relatedTaskIdsJson: JSON.stringify(h.relatedTaskIds),
        createdAt: now,
        updatedAt: now,
        updateCount: 0,
      })
      .run();
    return h;
  }

  getById(id: string): Hypothesis | undefined {
    const row = this.db.select().from(hypotheses).where(eq(hypotheses.id, id)).get();
    return row ? rowToH(row) : undefined;
  }

  update(
    id: string,
    patch: Partial<Pick<Hypothesis, "status" | "relatedTaskIds" | "statement">>,
  ): Hypothesis | undefined {
    const cur = this.getById(id);
    if (!cur) return undefined;
    const next: Hypothesis = {
      ...cur,
      statement: patch.statement ?? cur.statement,
      status: patch.status ?? cur.status,
      relatedTaskIds: patch.relatedTaskIds ?? cur.relatedTaskIds,
      updatedAt: new Date().toISOString(),
      updateCount: cur.updateCount + 1,
    };
    this.db
      .update(hypotheses)
      .set({
        statement: next.statement,
        status: next.status,
        relatedTaskIdsJson: JSON.stringify(next.relatedTaskIds),
        updatedAt: next.updatedAt,
        updateCount: next.updateCount,
      })
      .where(eq(hypotheses.id, id))
      .run();
    return next;
  }

  listByCase(caseId: string): Hypothesis[] {
    return this.db
      .select()
      .from(hypotheses)
      .where(eq(hypotheses.caseId, caseId))
      .all()
      .map((r) => rowToH(r));
  }
}
