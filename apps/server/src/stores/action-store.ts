import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { actionCards } from "../db/schema.js";
import { type ActionCard, ActionCardSchema } from "@traceforge/shared";

export class ActionCardStore {
  constructor(private db: Db) {}

  create(a: ActionCard): ActionCard {
    const card = ActionCardSchema.parse(a);
    this.db.insert(actionCards).values({
      id: card.id, caseId: card.caseId, title: card.title, goal: card.goal,
      evidenceRefsJson: JSON.stringify(card.evidenceRefs),
      hypothesisRefsJson: JSON.stringify(card.hypothesisRefs),
      taskRefsJson: JSON.stringify(card.taskRefs),
      reasoning: card.reasoning, stepsJson: JSON.stringify(card.steps),
      expectedResultsJson: JSON.stringify(card.expectedResults),
      riskNotesJson: JSON.stringify(card.riskNotes),
      tool: card.tool, priority: card.priority,
      requiresHumanApproval: card.requiresHumanApproval ? 1 : 0,
      status: card.status, createdAt: card.createdAt, updatedAt: card.updatedAt,
    }).run();
    return card;
  }

  getById(id: string): ActionCard | undefined {
    const row = this.db.select().from(actionCards).where(eq(actionCards.id, id)).get();
    if (!row) return undefined;
    return ActionCardSchema.parse({
      id: row.id, caseId: row.caseId, title: row.title, goal: row.goal,
      evidenceRefs: JSON.parse(row.evidenceRefsJson),
      hypothesisRefs: JSON.parse(row.hypothesisRefsJson),
      taskRefs: JSON.parse(row.taskRefsJson),
      reasoning: row.reasoning, steps: JSON.parse(row.stepsJson),
      expectedResults: JSON.parse(row.expectedResultsJson),
      riskNotes: JSON.parse(row.riskNotesJson),
      tool: row.tool, priority: row.priority,
      requiresHumanApproval: row.requiresHumanApproval === 1,
      status: row.status, createdAt: row.createdAt, updatedAt: row.updatedAt,
    });
  }

  listByCase(caseId: string): ActionCard[] {
    return this.db.select().from(actionCards).where(eq(actionCards.caseId, caseId)).all().map((row) =>
      ActionCardSchema.parse({
        id: row.id, caseId: row.caseId, title: row.title, goal: row.goal,
        evidenceRefs: JSON.parse(row.evidenceRefsJson),
        hypothesisRefs: JSON.parse(row.hypothesisRefsJson),
        taskRefs: JSON.parse(row.taskRefsJson),
        reasoning: row.reasoning, steps: JSON.parse(row.stepsJson),
        expectedResults: JSON.parse(row.expectedResultsJson),
        riskNotes: JSON.parse(row.riskNotesJson),
        tool: row.tool, priority: row.priority,
        requiresHumanApproval: row.requiresHumanApproval === 1,
        status: row.status, createdAt: row.createdAt, updatedAt: row.updatedAt,
      }),
    );
  }
}
