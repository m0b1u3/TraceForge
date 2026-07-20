import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { validationConsensus } from "../db/schema.js";
import type { ValidationConsensusResult } from "../validation-consensus.js";

export class ValidationConsensusStore {
  constructor(private readonly db: Db) {}

  upsert(caseId: string, result: ValidationConsensusResult): ValidationConsensusResult {
    const updatedAt = new Date().toISOString();
    const values = {
      findingId: result.findingId,
      caseId,
      status: result.status,
      independentSupports: result.independentSupports,
      independentRefutes: result.independentRefutes,
      inconclusiveCount: result.inconclusive,
      duplicatesExcluded: result.duplicatesExcluded,
      confidence: result.confidence,
      recommendation: result.recommendation,
      resultJson: JSON.stringify(result),
      updatedAt,
    };
    this.db.insert(validationConsensus).values(values).onConflictDoUpdate({
      target: validationConsensus.findingId,
      set: values,
    }).run();
    return result;
  }

  listByCase(caseId: string): ValidationConsensusResult[] {
    return this.db.select().from(validationConsensus)
      .where(eq(validationConsensus.caseId, caseId))
      .all()
      .map((row) => JSON.parse(row.resultJson) as ValidationConsensusResult);
  }
}
