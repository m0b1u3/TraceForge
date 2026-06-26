import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { tasks } from "../db/schema.js";
import { type Task, TaskSchema } from "@traceforge/shared";

type TaskInput = Omit<Task, "id" | "caseId" | "createdAt" | "updatedAt" | "updateCount">;

function rowToTask(row: typeof tasks.$inferSelect): Task {
  return TaskSchema.parse({
    id: row.id, caseId: row.caseId, title: row.title, status: row.status, reason: row.reason,
    blockedBy: JSON.parse(row.blockedByJson), triggerWhen: JSON.parse(row.triggerWhenJson),
    relatedFacts: JSON.parse(row.relatedFactsJson), priority: row.priority,
    createdAt: row.createdAt, updatedAt: row.updatedAt, updateCount: row.updateCount,
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
      createdAt: now, updatedAt: now, updateCount: 0,
    }).run();
    return t;
  }

  update(id: string, patch: Partial<Pick<Task, "title" | "status" | "reason" | "priority" | "blockedBy" | "triggerWhen" | "relatedFacts">>): Task | undefined {
    const cur = this.getById(id);
    if (!cur) return undefined;
    const updatedAt = new Date().toISOString();
    const next = TaskSchema.parse({ ...cur, ...patch, updateCount: cur.updateCount + 1, updatedAt });
    this.db.update(tasks).set({
      title: next.title, status: next.status, reason: next.reason, priority: next.priority,
      blockedByJson: JSON.stringify(next.blockedBy), triggerWhenJson: JSON.stringify(next.triggerWhen),
      relatedFactsJson: JSON.stringify(next.relatedFacts), updateCount: next.updateCount, updatedAt,
    }).where(eq(tasks.id, id)).run();
    return next;
  }

  listByCase(caseId: string): Task[] {
    return this.db.select().from(tasks).where(eq(tasks.caseId, caseId)).all().map(rowToTask);
  }

  getById(id: string): Task | undefined {
    const row = this.db.select().from(tasks).where(eq(tasks.id, id)).get();
    return row ? rowToTask(row) : undefined;
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
