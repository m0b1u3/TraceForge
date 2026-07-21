import type { Fact, Hypothesis, Task } from "@traceforge/shared";
import type { TaskCompletionGateResult } from "@traceforge/extension";
import type { ValidationConsensusResult } from "./validation-consensus.js";

const KEY = /^\[Consensus:([^:\]]+):(insufficient|supported|conflicted|refuted)\]/;

export function evaluateValidationTaskCompletion(input: {
  task: Pick<Task, "title">;
  facts: Fact[];
  consensus: ValidationConsensusResult[];
  hypotheses: Hypothesis[];
}): TaskCompletionGateResult {
  const match = KEY.exec(input.task.title);
  if (!match) return { allowed: true, missing: [] };
  const [, findingId, expectedStatus] = match;
  const finding = input.facts.find((item) => item.id === findingId && item.type === "finding");
  const consensus = input.consensus.find((item) => item.findingId === findingId);
  const missing: string[] = [];
  if (!finding) missing.push(`Finding ${findingId} is missing`);
  if (!consensus) missing.push(`Validation consensus for ${findingId} is missing`);
  if (!finding || !consensus) return { allowed: false, missing };

  if (expectedStatus === "insufficient") {
    if (consensus.status === "insufficient") {
      missing.push("record a new independent Validation Conclusion under a different Run, Identity, or source request");
    }
  } else if (expectedStatus === "conflicted") {
    if (consensus.status === "conflicted") {
      missing.push("resolve the supporting/refuting evidence conflict and record the differentiating variable");
    }
  } else if (expectedStatus === "supported") {
    if (consensus.status !== "supported" || consensus.independentSupports < 2) {
      missing.push("retain at least two independent supporting evidence groups with no refutation");
    }
    if (!finding.verificationSummary?.trim()) missing.push("write a verification summary");
    if (!finding.observations?.length) missing.push("record at least one source-linked Observation");
    if (finding.findingStatus !== "verified") missing.push("complete the Finding lifecycle transition to verified");
  } else if (expectedStatus === "refuted") {
    const adjacent = input.hypotheses.some((hypothesis) =>
      !finding.hypothesisIds?.includes(hypothesis.id) &&
      ["candidate", "active"].includes(hypothesis.status) &&
      hypothesis.basedOnFactIds.some((id) => id === finding.id || finding.evidenceRefs?.includes(id)));
    if (finding.findingStatus !== "rejected" && !adjacent) {
      missing.push("mark the Finding rejected or record an evidence-linked adjacent Hypothesis");
    }
  }
  return { allowed: missing.length === 0, missing };
}
