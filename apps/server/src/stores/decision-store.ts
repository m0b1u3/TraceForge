import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { decisions } from "../db/schema.js";
import { type Decision, DecisionSchema } from "@traceforge/shared";

// 有默认值的字段（actionRef/result/newFacts）可省略，由 schema 补默认
type DecisionInput = Pick<Decision, "decision" | "basedOn" | "reasoning"> &
  Partial<Pick<Decision, "actionRef" | "result" | "newFacts">>;

export class DecisionStore {
  constructor(private db: Db) {}

  create(caseId: string, input: DecisionInput): Decision {
    const id = `decision_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const d = DecisionSchema.parse({ ...input, id, caseId, createdAt });
    this.db.insert(decisions).values({
      id, caseId, decision: d.decision, basedOnJson: JSON.stringify(d.basedOn),
      reasoning: d.reasoning, actionRef: d.actionRef, result: d.result,
      newFactsJson: JSON.stringify(d.newFacts), createdAt,
    }).run();
    return d;
  }

  listByCase(caseId: string): Decision[] {
    return this.db.select().from(decisions).where(eq(decisions.caseId, caseId)).all().map((row) =>
      DecisionSchema.parse({
        id: row.id, caseId: row.caseId, decision: row.decision,
        basedOn: JSON.parse(row.basedOnJson), reasoning: row.reasoning,
        actionRef: row.actionRef, result: row.result,
        newFacts: JSON.parse(row.newFactsJson), createdAt: row.createdAt,
      }),
    );
  }
}
