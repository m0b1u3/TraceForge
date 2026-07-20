import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import {
  AttackPathSchema,
  type AttackPath,
  type AttackPathStep,
} from "@traceforge/shared";
import type { Db } from "../db/client.js";
import {
  actionCards,
  attackPaths,
  facts,
  hypotheses,
  identityContexts,
  tasks,
  trafficEntries,
} from "../db/schema.js";

export type AttackPathInput = Omit<AttackPath, "id" | "caseId" | "version" | "createdAt" | "updatedAt">;
export type AttackPathPatch = Partial<Omit<AttackPathInput, "sourceRunId">>;

function hydrate(row: typeof attackPaths.$inferSelect): AttackPath {
  return AttackPathSchema.parse({
    id: row.id,
    caseId: row.caseId,
    title: row.title,
    objective: row.objective,
    status: row.status,
    confidence: row.confidence,
    sourceRunId: row.sourceRunId,
    lastRunId: row.lastRunId,
    entryIdentityId: row.entryIdentityId,
    targetAssetFactId: row.targetAssetFactId,
    findingFactIds: JSON.parse(row.findingFactIdsJson),
    hypothesisIds: JSON.parse(row.hypothesisIdsJson),
    evidenceRefs: JSON.parse(row.evidenceRefsJson),
    breakpoint: row.breakpoint,
    steps: JSON.parse(row.stepsJson),
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

export class AttackPathStore {
  constructor(private db: Db) {}

  create(caseId: string, input: AttackPathInput): AttackPath {
    const now = new Date().toISOString();
    const path = AttackPathSchema.parse({
      ...input,
      id: `path_${randomUUID()}`,
      caseId,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    this.validate(path);
    this.db.insert(attackPaths).values(this.values(path)).run();
    return path;
  }

  update(id: string, patch: AttackPathPatch): AttackPath | undefined {
    const current = this.getById(id);
    if (!current) return undefined;
    const next = AttackPathSchema.parse({
      ...current,
      ...patch,
      id: current.id,
      caseId: current.caseId,
      sourceRunId: current.sourceRunId,
      version: current.version + 1,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
    });
    this.validate(next);
    this.db.update(attackPaths).set(this.values(next)).where(eq(attackPaths.id, id)).run();
    return next;
  }

  getById(id: string): AttackPath | undefined {
    const row = this.db.select().from(attackPaths).where(eq(attackPaths.id, id)).get();
    return row ? hydrate(row) : undefined;
  }

  listByCase(caseId: string): AttackPath[] {
    return this.db.select().from(attackPaths)
      .where(eq(attackPaths.caseId, caseId))
      .orderBy(desc(attackPaths.updatedAt))
      .all()
      .map(hydrate);
  }

  private values(path: AttackPath): typeof attackPaths.$inferInsert {
    return {
      id: path.id,
      caseId: path.caseId,
      title: path.title,
      objective: path.objective,
      status: path.status,
      confidence: path.confidence,
      sourceRunId: path.sourceRunId,
      lastRunId: path.lastRunId,
      entryIdentityId: path.entryIdentityId,
      targetAssetFactId: path.targetAssetFactId,
      findingFactIdsJson: JSON.stringify(path.findingFactIds),
      hypothesisIdsJson: JSON.stringify(path.hypothesisIds),
      evidenceRefsJson: JSON.stringify(path.evidenceRefs),
      breakpoint: path.breakpoint,
      stepsJson: JSON.stringify(path.steps),
      version: path.version,
      createdAt: path.createdAt,
      updatedAt: path.updatedAt,
    };
  }

  private validate(path: AttackPath): void {
    const stepIds = new Set(path.steps.map((step) => step.id));
    if (stepIds.size !== path.steps.length) throw new Error("attack path step ids must be unique");
    for (const step of path.steps) {
      if (step.prerequisiteStepIds.some((id) => !stepIds.has(id) || id === step.id)) {
        throw new Error(`invalid prerequisite step reference in ${step.id}`);
      }
      if (step.status === "verified" && step.factIds.length === 0) {
        throw new Error(`verified attack path step ${step.id} requires evidence Facts`);
      }
    }
    const sortedOrders = [...path.steps].map((step) => step.order).sort((a, b) => a - b);
    if (new Set(sortedOrders).size !== sortedOrders.length) throw new Error("attack path step order must be unique");

    const identityIds = new Set(this.db.select({ id: identityContexts.id }).from(identityContexts).where(eq(identityContexts.caseId, path.caseId)).all().map((row) => row.id));
    const trafficIds = new Set(this.db.select({ id: trafficEntries.id }).from(trafficEntries).where(eq(trafficEntries.caseId, path.caseId)).all().map((row) => row.id));
    const factRows = this.db.select({ id: facts.id, type: facts.type, findingStatus: facts.findingStatus }).from(facts).where(eq(facts.caseId, path.caseId)).all();
    const factIds = new Set(factRows.map((row) => row.id));
    const hypothesisIds = new Set(this.db.select({ id: hypotheses.id }).from(hypotheses).where(eq(hypotheses.caseId, path.caseId)).all().map((row) => row.id));
    const taskIds = new Set(this.db.select({ id: tasks.id }).from(tasks).where(eq(tasks.caseId, path.caseId)).all().map((row) => row.id));
    const actionIds = new Set(this.db.select({ id: actionCards.id }).from(actionCards).where(eq(actionCards.caseId, path.caseId)).all().map((row) => row.id));

    this.assertRefs("identity", [
      path.entryIdentityId,
      ...path.steps.map((step) => step.identityId),
    ], identityIds);
    this.assertRefs("traffic", path.steps.map((step) => step.trafficId), trafficIds);
    this.assertRefs("Fact", [
      path.targetAssetFactId,
      ...path.findingFactIds,
      ...path.evidenceRefs,
      ...path.steps.flatMap((step) => step.factIds),
    ], factIds);
    this.assertRefs("Hypothesis", path.hypothesisIds, hypothesisIds);
    this.assertRefs("Task", path.steps.map((step) => step.taskId), taskIds);
    this.assertRefs("Action", path.steps.map((step) => step.actionId), actionIds);
    const findingRows = new Map(factRows.map((row) => [row.id, row]));
    if (path.findingFactIds.some((id) => findingRows.get(id)?.type !== "finding")) {
      throw new Error("findingFactIds must reference Finding Facts");
    }

    if (path.status === "validated") {
      if (path.steps.some((step) => step.status !== "verified")) throw new Error("validated attack path requires every step to be verified");
      if (path.evidenceRefs.length === 0 || path.findingFactIds.length === 0) {
        throw new Error("validated attack path requires evidence and at least one Finding");
      }
      if (path.findingFactIds.some((id) => findingRows.get(id)?.findingStatus !== "verified")) {
        throw new Error("validated attack path requires verified Findings");
      }
    }
  }

  private assertRefs(
    label: string,
    refs: Array<string | null | undefined>,
    available: ReadonlySet<string>,
  ): void {
    const unique = [...new Set(refs.filter((ref): ref is string => Boolean(ref)))];
    const missing = unique.filter((id) => !available.has(id));
    if (missing.length > 0) throw new Error(`${label} references are missing or belong to another case: ${missing.join(", ")}`);
  }
}

export function attackPathStep(input: Omit<AttackPathStep, "id"> & { id?: string }): AttackPathStep {
  return { ...input, id: input.id ?? `step_${randomUUID()}` };
}
