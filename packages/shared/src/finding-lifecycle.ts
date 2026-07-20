import type { Fact } from "./schemas.js";

export type FindingStatus = NonNullable<Fact["findingStatus"]>;

const TRANSITIONS: Record<FindingStatus, ReadonlySet<FindingStatus>> = {
  candidate: new Set(["validating", "rejected", "stale"]),
  validating: new Set(["verified", "needs_review", "rejected", "stale"]),
  verified: new Set(["needs_review", "stale"]),
  needs_review: new Set(["validating", "verified", "rejected", "stale"]),
  rejected: new Set(["validating"]),
  stale: new Set(["validating"]),
};

export function canTransitionFinding(from: FindingStatus, to: FindingStatus): boolean {
  return from === to || TRANSITIONS[from].has(to);
}

export function validateFindingEvidence(fact: Pick<Fact, "evidenceRefs" | "hypothesisIds" | "taskIds" | "actionIds" | "observations" | "verificationSummary">): string[] {
  const errors: string[] = [];
  if (!fact.evidenceRefs?.length) errors.push("finding requires at least one evidence Fact");
  if (!fact.hypothesisIds?.length) errors.push("finding requires a Hypothesis reference");
  if (!fact.taskIds?.length) errors.push("finding requires a Task reference");
  if (!fact.actionIds?.length) errors.push("finding requires an Action reference");
  return errors;
}

export function validateVerifiedFinding(fact: Pick<Fact, "evidenceRefs" | "hypothesisIds" | "taskIds" | "actionIds" | "observations" | "verificationSummary">): string[] {
  const errors = validateFindingEvidence(fact);
  if (!fact.observations?.length) errors.push("verified finding requires at least one Observation");
  if (!fact.verificationSummary?.trim()) errors.push("verified finding requires a verification summary");
  return errors;
}
