import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { tasks } from "../db/schema.js";
import { type Task, TaskSchema } from "@traceforge/shared";

type TaskInput = Omit<Task, "id" | "caseId" | "createdAt" | "updatedAt">;

function rowToTask(row: typeof tasks.$inferSelect): Task {
  return TaskSchema.parse({
    id: row.id, caseId: row.caseId, title: row.title, status: row.status, reason: row.reason,
    blockedBy: JSON.parse(row.blockedByJson), triggerWhen: JSON.parse(row.triggerWhenJson),
    relatedFacts: JSON.parse(row.relatedFactsJson), priority: row.priority,
    createdAt: row.createdAt, updatedAt: row.updatedAt,
  });
}

export class TaskStore {
  constructor(private db: Db) {}

  create(caseId: string, input: TaskInput): Task {
    const id = `task_${randomUUID()}`;
    const now = new Date().toISOString();
    const t = TaskSchema.parse({ ...input, id, caseId, createdAt: now, updatedAt: now });
    this.db.insert(tasks).values({
      id, caseId, title: t.title, status: t.status, reason: t.reason,
      blockedByJson: JSON.stringify(t.blockedBy), triggerWhenJson: JSON.stringify(t.triggerWhen),
      relatedFactsJson: JSON.stringify(t.relatedFacts), priority: t.priority,
      createdAt: now, updatedAt: now,
    }).run();
    return t;
  }

  listByCase(caseId: string): Task[] {
    return this.db.select().from(tasks).where(eq(tasks.caseId, caseId)).all().map(rowToTask);
  }

  updateStatus(id: string, status: Task["status"], reason?: string): Task | undefined {
    const row = this.db.select().from(tasks).where(eq(tasks.id, id)).get();
    if (!row) return undefined;
    const updatedAt = new Date().toISOString();
    const nextReason = reason ?? row.reason;
    this.db.update(tasks)
      .set({ status, reason: nextReason, updatedAt })
      .where(eq(tasks.id, id)).run();
    return rowToTask({ ...row, status, reason: nextReason, updatedAt });
  }
}
