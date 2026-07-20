import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { actionCards, facts, hypotheses, tasks } from "../db/schema.js";
import {
  canTransitionFinding,
  type Fact,
  FactSchema,
  validateFindingEvidence,
  validateVerifiedFinding,
} from "@traceforge/shared";

type FactInput = Omit<Fact, "id" | "caseId" | "createdAt" | "updateCount" | "updatedAt" | "validity"> & Partial<Pick<Fact, "validity">>;

function rowToFact(row: typeof facts.$inferSelect): Fact {
  return FactSchema.parse({
    id: row.id, caseId: row.caseId, sourceRunId: row.sourceRunId, type: row.type, title: row.title,
    value: JSON.parse(row.valueJson), source: JSON.parse(row.sourceJson),
    confidence: row.confidence, tags: JSON.parse(row.tagsJson), createdAt: row.createdAt,
    updateCount: row.updateCount, updatedAt: row.updatedAt, validity: row.validity,
    findingStatus: row.findingStatus,
    evidenceRefs: JSON.parse(row.evidenceRefsJson),
    hypothesisIds: JSON.parse(row.hypothesisIdsJson),
    taskIds: JSON.parse(row.taskIdsJson),
    actionIds: JSON.parse(row.actionIdsJson),
    verificationSummary: row.verificationSummary,
    observations: JSON.parse(row.observationsJson),
  });
}

export class FactStore {
  constructor(private db: Db) {}

  create(caseId: string, input: FactInput): Fact {
    const id = `fact_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const f = FactSchema.parse({
      ...input,
      findingStatus: input.type === "finding" ? input.findingStatus ?? "candidate" : input.findingStatus,
      id, caseId, createdAt, updateCount: 0, updatedAt: createdAt,
    });
    if (f.type === "finding") {
      if (f.findingStatus !== "candidate") throw new Error("new finding must start as candidate");
      this.assertFindingChain(caseId, f);
    } else if (f.findingStatus) {
      throw new Error("findingStatus is only valid for finding facts");
    }
    this.db.insert(facts).values({
      id, caseId, sourceRunId: f.sourceRunId, type: f.type, title: f.title,
      valueJson: JSON.stringify(f.value), sourceJson: JSON.stringify(f.source),
      confidence: f.confidence, tagsJson: JSON.stringify(f.tags), createdAt,
      updateCount: 0, updatedAt: createdAt, validity: f.validity,
      findingStatus: f.findingStatus ?? null,
      evidenceRefsJson: JSON.stringify(f.evidenceRefs ?? []),
      hypothesisIdsJson: JSON.stringify(f.hypothesisIds ?? []),
      taskIdsJson: JSON.stringify(f.taskIds ?? []),
      actionIdsJson: JSON.stringify(f.actionIds ?? []),
      verificationSummary: f.verificationSummary ?? null,
      observationsJson: JSON.stringify(f.observations ?? []),
    }).run();
    return f;
  }

  getById(id: string): Fact | undefined {
    const row = this.db.select().from(facts).where(eq(facts.id, id)).get();
    return row ? rowToFact(row) : undefined;
  }

  update(id: string, patch: Partial<Pick<Fact, "type" | "title" | "value" | "confidence" | "tags" | "validity" | "findingStatus" | "evidenceRefs" | "hypothesisIds" | "taskIds" | "actionIds" | "verificationSummary" | "observations">>): Fact | undefined {
    const cur = this.getById(id);
    if (!cur) return undefined;
    const updatedAt = new Date().toISOString();
    const requestedStatus = patch.findingStatus ?? cur.findingStatus;
    if (cur.type === "finding" && cur.findingStatus && requestedStatus
      && !canTransitionFinding(cur.findingStatus, requestedStatus)) {
      throw new Error(`invalid finding transition: ${cur.findingStatus} -> ${requestedStatus}`);
    }
    const next = FactSchema.parse({
      ...cur,
      ...patch,
      findingStatus: (patch.validity === "conflicted" || (patch.validity === undefined && cur.validity === "conflicted"))
        && requestedStatus === "verified"
        ? "needs_review"
        : requestedStatus,
      updateCount: cur.updateCount + 1,
      updatedAt,
    });
    if (next.type === "finding") {
      this.assertFindingChain(next.caseId, next);
      if (next.findingStatus === "verified") {
        const errors = validateVerifiedFinding(next);
        if (errors.length) throw new Error(errors.join("; "));
      }
    }
    this.db.update(facts).set({
      type: next.type, title: next.title,
      valueJson: JSON.stringify(next.value), confidence: next.confidence,
      tagsJson: JSON.stringify(next.tags), validity: next.validity,
      findingStatus: next.findingStatus ?? null,
      evidenceRefsJson: JSON.stringify(next.evidenceRefs ?? []),
      hypothesisIdsJson: JSON.stringify(next.hypothesisIds ?? []),
      taskIdsJson: JSON.stringify(next.taskIds ?? []),
      actionIdsJson: JSON.stringify(next.actionIds ?? []),
      verificationSummary: next.verificationSummary ?? null,
      observationsJson: JSON.stringify(next.observations ?? []),
      updateCount: next.updateCount, updatedAt,
    }).where(eq(facts.id, id)).run();
    return next;
  }

  listByCase(caseId: string): Fact[] {
    return this.db.select().from(facts).where(eq(facts.caseId, caseId)).all().map(rowToFact);
  }

  private assertFindingChain(caseId: string, fact: Fact): void {
    const errors = validateFindingEvidence(fact);
    const invalidEvidence = (fact.evidenceRefs ?? []).filter((ref) => {
      const row = this.db.select({ caseId: facts.caseId, type: facts.type }).from(facts).where(eq(facts.id, ref)).get();
      return !row || row.caseId !== caseId || row.type === "finding";
    });
    const invalidHypotheses = (fact.hypothesisIds ?? []).filter((ref) => {
      const row = this.db.select({ caseId: hypotheses.caseId }).from(hypotheses).where(eq(hypotheses.id, ref)).get();
      return !row || row.caseId !== caseId;
    });
    const invalidTasks = (fact.taskIds ?? []).filter((ref) => {
      const row = this.db.select({
        caseId: tasks.caseId,
        hypothesisIdsJson: tasks.hypothesisIdsJson,
      }).from(tasks).where(eq(tasks.id, ref)).get();
      if (!row || row.caseId !== caseId) return true;
      const taskHypotheses = JSON.parse(row.hypothesisIdsJson) as string[];
      return !(fact.hypothesisIds ?? []).some((id) => taskHypotheses.includes(id));
    });
    const invalidActions = (fact.actionIds ?? []).filter((ref) => {
      const row = this.db.select({
        caseId: actionCards.caseId,
        evidenceRefsJson: actionCards.evidenceRefsJson,
        hypothesisRefsJson: actionCards.hypothesisRefsJson,
        taskRefsJson: actionCards.taskRefsJson,
      }).from(actionCards).where(eq(actionCards.id, ref)).get();
      if (!row || row.caseId !== caseId) return true;
      const actionEvidence = JSON.parse(row.evidenceRefsJson) as string[];
      const actionHypotheses = JSON.parse(row.hypothesisRefsJson) as string[];
      const actionTasks = JSON.parse(row.taskRefsJson) as string[];
      return !(fact.evidenceRefs ?? []).some((id) => actionEvidence.includes(id))
        || !(fact.hypothesisIds ?? []).some((id) => actionHypotheses.includes(id))
        || !(fact.taskIds ?? []).some((id) => actionTasks.includes(id));
    });
    if (invalidEvidence.length) errors.push(`invalid evidence refs: ${invalidEvidence.join(", ")}`);
    if (invalidHypotheses.length) errors.push(`invalid hypothesis refs: ${invalidHypotheses.join(", ")}`);
    if (invalidTasks.length) errors.push(`invalid task refs: ${invalidTasks.join(", ")}`);
    if (invalidActions.length) errors.push(`invalid action refs: ${invalidActions.join(", ")}`);
    if (errors.length) throw new Error(errors.join("; "));
  }
}
