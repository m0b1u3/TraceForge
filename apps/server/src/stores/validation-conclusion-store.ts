import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import type { ValidationAssessment } from "@traceforge/extension";
import type { Db } from "../db/client.js";
import { validationConclusions } from "../db/schema.js";

export interface ValidationConclusion {
  id: string;
  caseId: string;
  runId: string;
  findingId: string;
  gapId: string;
  verdict: ValidationAssessment["verdict"];
  confidence: number;
  baselineTrafficId: string;
  variantTrafficId: string;
  confirmationTrafficId: string | null;
  identityId: string | null;
  assessment: ValidationAssessment;
  createdAt: string;
}

export class ValidationConclusionStore {
  constructor(private readonly db: Db) {}

  create(input: Omit<ValidationConclusion, "id" | "createdAt" | "verdict" | "confidence">): ValidationConclusion {
    const conclusion: ValidationConclusion = {
      ...input,
      id: `validation_${randomUUID()}`,
      verdict: input.assessment.verdict,
      confidence: input.assessment.confidence,
      createdAt: new Date().toISOString(),
    };
    this.db.insert(validationConclusions).values({
      id: conclusion.id,
      caseId: conclusion.caseId,
      runId: conclusion.runId,
      findingId: conclusion.findingId,
      gapId: conclusion.gapId,
      verdict: conclusion.verdict,
      confidence: conclusion.confidence,
      baselineTrafficId: conclusion.baselineTrafficId,
      variantTrafficId: conclusion.variantTrafficId,
      confirmationTrafficId: conclusion.confirmationTrafficId,
      identityId: conclusion.identityId,
      assessmentJson: JSON.stringify(conclusion.assessment),
      createdAt: conclusion.createdAt,
    }).run();
    return conclusion;
  }

  listByCase(caseId: string): ValidationConclusion[] {
    return this.db.select().from(validationConclusions)
      .where(eq(validationConclusions.caseId, caseId))
      .orderBy(asc(validationConclusions.createdAt))
      .all()
      .map((row) => ({
        id: row.id,
        caseId: row.caseId,
        runId: row.runId,
        findingId: row.findingId,
        gapId: row.gapId,
        verdict: row.verdict as ValidationConclusion["verdict"],
        confidence: row.confidence,
        baselineTrafficId: row.baselineTrafficId,
        variantTrafficId: row.variantTrafficId,
        confirmationTrafficId: row.confirmationTrafficId,
        identityId: row.identityId,
        assessment: JSON.parse(row.assessmentJson) as ValidationAssessment,
        createdAt: row.createdAt,
      }));
  }
}
