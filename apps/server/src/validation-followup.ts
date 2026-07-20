import type { Fact, Task } from "@traceforge/shared";
import type { ValidationConsensusResult } from "./validation-consensus.js";

export interface ValidationFollowupPlan {
  key: string;
  title: string;
  reason: string;
  priority: Task["priority"];
  triggerWhen: string[];
}

export function planValidationFollowup(
  finding: Fact,
  consensus: ValidationConsensusResult,
): ValidationFollowupPlan {
  const key = `[Consensus:${finding.id}:${consensus.status}]`;
  if (consensus.status === "conflicted") {
    return {
      key,
      title: `${key} Isolate the conflicting validation variable`,
      reason: `Supporting and refuting evidence coexist. Compare the evidence groups while changing only Run environment, Identity, source request, and target state one at a time. ${consensus.rationale.join("; ")}.`,
      priority: "high",
      triggerWhen: ["Use the same baseline request and protected fields.", "Stop after identifying the first variable that explains the disagreement."],
    };
  }
  if (consensus.status === "supported") {
    return {
      key,
      title: finding.verificationSummary?.trim()
        ? `${key} Review consensus before marking verified`
        : `${key} Complete the verification summary`,
      reason: `${consensus.independentSupports} independent evidence groups support the Finding. Preserve the evidence chain and perform the final lifecycle review; do not create another equivalent replay.`,
      priority: "high",
      triggerWhen: finding.verificationSummary?.trim()
        ? ["Confirm every evidence, hypothesis, task, action, and observation reference.", "Then update the Finding to verified."]
        : ["Summarize baseline, changed variable, observed differential, business impact, and limitations."],
    };
  }
  if (consensus.status === "refuted") {
    return {
      key,
      title: `${key} Review rejection or pivot to an adjacent hypothesis`,
      reason: `${consensus.independentRefutes} independent evidence groups refute the current Finding. Close it only after checking the experiment targeted the correct asset and authorization boundary; otherwise pivot without repeating the same matrix.`,
      priority: "medium",
      triggerWhen: ["Check target and protected-field selection.", "If correct, mark rejected; if not, record a distinct adjacent hypothesis."],
    };
  }
  const direction = consensus.independentSupports === 1
    ? "Reproduce the supporting result in a different Run, Identity, or source request."
    : consensus.independentRefutes === 1
      ? "Reproduce the refuting result independently before closing the Finding."
      : "Run one controlled baseline/variant matrix.";
  return {
    key,
    title: `${key} Collect one independent validation`,
    reason: `${direction} Existing duplicate experiments do not count as independent evidence. ${consensus.rationale.join("; ")}.`,
    priority: "high",
    triggerWhen: ["Change at least one independence dimension: Run, Identity, or source request.", "Keep all non-target variables constant."],
  };
}
