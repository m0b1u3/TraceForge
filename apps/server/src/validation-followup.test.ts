import { describe, expect, it } from "vitest";
import { FactSchema } from "@traceforge/shared";
import type { ValidationConsensusResult } from "./validation-consensus.js";
import { planValidationFollowup } from "./validation-followup.js";

const finding = FactSchema.parse({
  id: "fact_idor", caseId: "case_1", type: "finding", title: "Order IDOR",
  value: { severity: "high" }, source: { type: "agent", ref: "run_1" },
  confidence: 0.8, tags: ["idor"], validity: "valid", findingStatus: "validating",
  evidenceRefs: ["fact_evidence"], hypothesisIds: ["hyp_1"], taskIds: ["task_1"],
  actionIds: ["action_1"], observations: [], createdAt: "now", updatedAt: "now",
});
const consensus = (
  status: ValidationConsensusResult["status"],
  supports: number,
  refutes: number,
): ValidationConsensusResult => ({
  findingId: finding.id,
  status,
  independentSupports: supports,
  independentRefutes: refutes,
  inconclusive: 0,
  duplicatesExcluded: 0,
  confidence: 0.9,
  recommendation: status === "supported" ? "mark_verified" : status === "conflicted" ? "keep_needs_review" : status === "refuted" ? "consider_rejected" : "collect_more",
  evidenceGroups: [],
  rationale: [`${supports} support`, `${refutes} refute`],
});

describe("validation follow-up planning", () => {
  it("asks for one independent reproduction when evidence is insufficient", () => {
    const plan = planValidationFollowup(finding, consensus("insufficient", 1, 0));
    expect(plan.title).toContain("Collect one independent validation");
    expect(plan.reason).toContain("different Run, Identity, or source request");
  });

  it("isolates variables for conflicts instead of repeating the matrix", () => {
    const plan = planValidationFollowup(finding, consensus("conflicted", 1, 1));
    expect(plan.title).toContain("Isolate the conflicting validation variable");
    expect(plan.triggerWhen.join(" ")).toContain("first variable");
  });

  it("moves supported consensus to lifecycle review and refuted consensus to closure review", () => {
    expect(planValidationFollowup(finding, consensus("supported", 2, 0)).title).toContain("Complete the verification summary");
    expect(planValidationFollowup(finding, consensus("refuted", 0, 2)).title).toContain("Review rejection");
  });
});
