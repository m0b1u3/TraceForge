import { desc, eq } from "drizzle-orm";
import {
  ObserverStrategyAuditSchema,
  type ObserverStrategyAudit,
} from "@traceforge/shared";
import type { Db } from "../db/client.js";
import { observerStrategyAudits } from "../db/schema.js";

function rowToAudit(row: typeof observerStrategyAudits.$inferSelect): ObserverStrategyAudit {
  return ObserverStrategyAuditSchema.parse({
    id: row.id,
    caseId: row.caseId,
    runId: row.runId,
    trigger: row.trigger,
    offeredCandidates: JSON.parse(row.offeredCandidatesJson),
    adoptions: JSON.parse(row.adoptionsJson),
    ignoredStrategyIds: JSON.parse(row.ignoredStrategyIdsJson),
    contextCharacters: row.contextCharacters,
    createdAt: row.createdAt,
  });
}

export class ObserverStrategyAuditStore {
  constructor(private readonly db: Db) {}

  create(input: ObserverStrategyAudit): ObserverStrategyAudit {
    const audit = ObserverStrategyAuditSchema.parse(input);
    this.db.insert(observerStrategyAudits).values({
      id: audit.id,
      caseId: audit.caseId,
      runId: audit.runId,
      trigger: audit.trigger,
      offeredCandidatesJson: JSON.stringify(audit.offeredCandidates),
      adoptionsJson: JSON.stringify(audit.adoptions),
      ignoredStrategyIdsJson: JSON.stringify(audit.ignoredStrategyIds),
      contextCharacters: audit.contextCharacters,
      createdAt: audit.createdAt,
    }).run();
    return audit;
  }

  listByCase(caseId: string, limit = 100): ObserverStrategyAudit[] {
    const safeLimit = Number.isFinite(limit)
      ? Math.max(1, Math.min(1_000, Math.trunc(limit)))
      : 100;
    return this.db.select()
      .from(observerStrategyAudits)
      .where(eq(observerStrategyAudits.caseId, caseId))
      .orderBy(desc(observerStrategyAudits.createdAt))
      .limit(safeLimit)
      .all()
      .map(rowToAudit);
  }
}
