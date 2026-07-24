import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { hypotheses } from "../db/schema.js";
import { type Hypothesis, type HypothesisTransition, type RuntimeEvent, HypothesisSchema, HypothesisTransitionSchema } from "@traceforge/shared";

function rowToH(row: typeof hypotheses.$inferSelect): Hypothesis {
  const parsedFactors = JSON.parse(row.scoreFactorsJson) as Record<string, unknown>;
  const scoreFactors = ["impact", "evidenceStrength", "verificationCost", "operationRisk", "pathRelevance", "freshness"]
    .every((key) => typeof parsedFactors[key] === "number")
    ? parsedFactors
    : undefined;
  return HypothesisSchema.parse({
    id: row.id,
    caseId: row.caseId,
    runId: row.runId,
    statement: row.statement,
    status: row.status,
    priorityScore: row.priorityScore,
    scoreFactors,
    basedOnFactIds: JSON.parse(row.basedOnFactIdsJson),
    relatedTaskIds: JSON.parse(row.relatedTaskIdsJson),
    relations: JSON.parse(row.relationsJson),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    updateCount: row.updateCount,
    auditTrail: JSON.parse(row.auditTrailJson),
  });
}

export interface HypothesisChangeContext {
  reason: string;
  evidenceFactIds?: string[];
  kind?: HypothesisTransition["kind"];
}

type Emit = (event: RuntimeEvent) => void;

export class HypothesisStore {
  constructor(private db: Db, private emit?: Emit) {}

  private normalizeRelations(relations?: Partial<NonNullable<Hypothesis["relations"]>>): NonNullable<Hypothesis["relations"]> {
    return {
      prerequisiteIds: [...new Set(relations?.prerequisiteIds ?? [])],
      conflictIds: [...new Set(relations?.conflictIds ?? [])],
      supportIds: [...new Set(relations?.supportIds ?? [])],
      derivedFromIds: [...new Set(relations?.derivedFromIds ?? [])],
    };
  }

  private validateRelations(
    caseId: string,
    runId: string | null,
    sourceId: string | null,
    relations: NonNullable<Hypothesis["relations"]>,
  ): void {
    const runHypotheses = this.listByCase(caseId).filter((item) => (item.runId ?? null) === runId);
    const related = new Map(runHypotheses.map((item) => [item.id, item]));
    const relationIds = [
      ...relations.prerequisiteIds,
      ...relations.conflictIds,
      ...relations.supportIds,
      ...relations.derivedFromIds,
    ];
    const invalidRelationIds = relationIds.filter((id) => id === sourceId || !related.has(id));
    if (invalidRelationIds.length > 0) {
      throw new Error(`hypothesis relations contain self, unknown, or cross-Run references: ${[...new Set(invalidRelationIds)].join(", ")}`);
    }
    if (!sourceId) return;

    const dependencyIds = (hypothesis: Hypothesis): string[] => [
      ...(hypothesis.relations?.prerequisiteIds ?? []),
      ...(hypothesis.relations?.derivedFromIds ?? []),
    ];
    const reachesSource = (id: string, visited: Set<string>): boolean => {
      if (id === sourceId) return true;
      if (visited.has(id)) return false;
      visited.add(id);
      const hypothesis = related.get(id);
      return hypothesis ? dependencyIds(hypothesis).some((dependencyId) => reachesSource(dependencyId, visited)) : false;
    };
    if ([...relations.prerequisiteIds, ...relations.derivedFromIds]
      .some((id) => reachesSource(id, new Set()))) {
      throw new Error("hypothesis prerequisite/derived relationship cycle detected");
    }
  }

  create(
    caseId: string,
    input: {
      statement: string; basedOnFactIds: string[]; relatedTaskIds?: string[]; runId?: string | null;
      priorityScore?: number; scoreFactors?: Hypothesis["scoreFactors"]; status?: "candidate" | "active";
      relations?: Partial<NonNullable<Hypothesis["relations"]>>;
      reason?: string;
    },
  ): Hypothesis {
    const runHypotheses = this.listByCase(caseId).filter((item) => (item.runId ?? null) === (input.runId ?? null));
    if (runHypotheses.length >= 30) throw new Error("hypothesis pool limit reached (30)");
    const requestedStatus = input.status === "active"
      && runHypotheses.filter((item) => item.status === "active").length >= 5
      ? "candidate"
      : input.status ?? "candidate";
    const relations = this.normalizeRelations(input.relations);
    this.validateRelations(caseId, input.runId ?? null, null, relations);
    const now = new Date().toISOString();
    const transition = HypothesisTransitionSchema.parse({
      id: `hyptr_${randomUUID()}`,
      kind: "created",
      fromStatus: null,
      toStatus: requestedStatus,
      previousScore: null,
      nextScore: input.priorityScore ?? 50,
      reason: input.reason?.trim() || "Recorded as an evidence-backed hypothesis.",
      evidenceFactIds: input.basedOnFactIds,
      createdAt: now,
    });
    const h = HypothesisSchema.parse({
      id: `hyp_${randomUUID()}`,
      caseId,
      statement: input.statement,
      runId: input.runId ?? null,
      status: requestedStatus,
      priorityScore: input.priorityScore ?? 50,
      scoreFactors: input.scoreFactors,
      basedOnFactIds: input.basedOnFactIds,
      relatedTaskIds: input.relatedTaskIds ?? [],
      relations,
      createdAt: now,
      updatedAt: now,
      updateCount: 0,
      auditTrail: [transition],
    });
    this.db
      .insert(hypotheses)
      .values({
        id: h.id,
        caseId,
        statement: h.statement,
        runId: h.runId,
        status: h.status,
        priorityScore: h.priorityScore,
        scoreFactorsJson: JSON.stringify(h.scoreFactors ?? {}),
        basedOnFactIdsJson: JSON.stringify(h.basedOnFactIds),
        relatedTaskIdsJson: JSON.stringify(h.relatedTaskIds),
        relationsJson: JSON.stringify(h.relations),
        auditTrailJson: JSON.stringify(h.auditTrail),
        createdAt: now,
        updatedAt: now,
        updateCount: 0,
      })
      .run();
    this.emit?.({ type: "hypothesis_created", hypothesis: h, transition });
    return h;
  }

  getById(id: string): Hypothesis | undefined {
    const row = this.db.select().from(hypotheses).where(eq(hypotheses.id, id)).get();
    return row ? rowToH(row) : undefined;
  }

  update(
    id: string,
    patch: Partial<Pick<Hypothesis, "status" | "relatedTaskIds" | "statement" | "priorityScore" | "scoreFactors" | "relations">>,
    context?: HypothesisChangeContext,
  ): Hypothesis | undefined {
    const cur = this.getById(id);
    if (!cur) return undefined;
    const nextRelations = patch.relations === undefined
      ? this.normalizeRelations(cur.relations)
      : this.normalizeRelations(patch.relations);
    if (patch.relations !== undefined) {
      this.validateRelations(cur.caseId, cur.runId ?? null, cur.id, nextRelations);
    }
    const nextStatus = patch.status ?? cur.status;
    const nextScore = patch.priorityScore ?? cur.priorityScore ?? 50;
    const inferredKind: HypothesisTransition["kind"] = nextStatus !== cur.status
      ? nextStatus === "active" ? "promoted" : nextStatus === "candidate" ? "demoted" : nextStatus
      : nextScore !== cur.priorityScore ? "scored" : "updated";
    const transition = HypothesisTransitionSchema.parse({
      id: `hyptr_${randomUUID()}`,
      kind: context?.kind ?? inferredKind,
      fromStatus: cur.status,
      toStatus: nextStatus,
      previousScore: cur.priorityScore ?? null,
      nextScore,
      reason: context?.reason.trim() || "Hypothesis metadata updated.",
      evidenceFactIds: context?.evidenceFactIds ?? [],
      createdAt: new Date().toISOString(),
    });
    const next: Hypothesis = {
      ...cur,
      statement: patch.statement ?? cur.statement,
      status: nextStatus,
      priorityScore: nextScore,
      scoreFactors: patch.scoreFactors ?? cur.scoreFactors,
      relatedTaskIds: patch.relatedTaskIds ?? cur.relatedTaskIds,
      relations: nextRelations,
      updatedAt: new Date().toISOString(),
      updateCount: cur.updateCount + 1,
      auditTrail: [...cur.auditTrail, transition],
    };
    this.db
      .update(hypotheses)
      .set({
        statement: next.statement,
        status: next.status,
        priorityScore: next.priorityScore,
        scoreFactorsJson: JSON.stringify(next.scoreFactors ?? {}),
        relatedTaskIdsJson: JSON.stringify(next.relatedTaskIds),
        relationsJson: JSON.stringify(next.relations),
        auditTrailJson: JSON.stringify(next.auditTrail),
        updatedAt: next.updatedAt,
        updateCount: next.updateCount,
      })
      .where(eq(hypotheses.id, id))
      .run();
    this.emit?.({ type: "hypothesis_updated", hypothesis: next, transition });
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
