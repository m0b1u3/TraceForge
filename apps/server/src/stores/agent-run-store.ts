import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import type { AgentRun, AgentRunUsage } from "@traceforge/shared";
import { AgentRunSchema, AgentRunUsageSchema } from "@traceforge/shared";
import type { Db } from "../db/client.js";
import { agentRuns, agentRunUsage } from "../db/schema.js";

export class AgentRunStore {
  constructor(private db: Db) {}

  save(run: AgentRun): AgentRun {
    const parsed = AgentRunSchema.parse(run);
    const values = {
      id: parsed.id,
      caseId: parsed.caseId,
      goal: parsed.goal,
      status: parsed.status,
      createdAt: parsed.createdAt,
      startedAt: parsed.startedAt,
      finishedAt: parsed.finishedAt,
      interruptReason: parsed.interruptReason,
      completionReason: parsed.completionReason,
      error: parsed.error,
      promptTokens: parsed.promptTokens,
      completionTokens: parsed.completionTokens,
      totalTokens: parsed.totalTokens,
    };
    this.db.insert(agentRuns).values(values).onConflictDoUpdate({
      target: agentRuns.id,
      set: values,
    }).run();
    return parsed;
  }

  listAll(): AgentRun[] {
    return this.db.select().from(agentRuns).orderBy(asc(agentRuns.createdAt)).all()
      .map((row) => AgentRunSchema.parse(row));
  }

  appendUsage(
    run: AgentRun,
    usage: Pick<AgentRunUsage, "promptTokens" | "completionTokens" | "totalTokens">,
  ): AgentRunUsage {
    const turn = this.listUsage(run.id).length + 1;
    const entry = AgentRunUsageSchema.parse({
      id: `usage_${randomUUID()}`,
      runId: run.id,
      caseId: run.caseId,
      turn,
      ...usage,
      createdAt: new Date().toISOString(),
    });
    this.db.insert(agentRunUsage).values(entry).run();
    return entry;
  }

  listUsage(runId: string): AgentRunUsage[] {
    return this.db.select().from(agentRunUsage)
      .where(eq(agentRunUsage.runId, runId)).orderBy(asc(agentRunUsage.turn)).all()
      .map((row) => AgentRunUsageSchema.parse(row));
  }

  deleteByCase(caseId: string): void {
    this.db.delete(agentRunUsage).where(eq(agentRunUsage.caseId, caseId)).run();
    this.db.delete(agentRuns).where(eq(agentRuns.caseId, caseId)).run();
  }
}
