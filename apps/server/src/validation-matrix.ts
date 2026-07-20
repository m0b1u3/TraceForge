import type { IdentityContext, TrafficEntry } from "@traceforge/shared";
import type { EvidenceGap } from "./evidence-gap-planner.js";

export interface ValidationExperiment {
  id: string;
  gapId: string;
  role: "baseline" | "variant";
  identityId: string | null;
  trafficId: string | null;
  changedVariable: string;
  expectedSecureResult: string;
  evidenceToRecord: string;
  requiresApproval: boolean;
  stopCondition: string;
}

export interface ValidationMatrix {
  gapId: string;
  sourceId: string;
  experiments: ValidationExperiment[];
}

const NETWORK_COLLECTION = /replay|capture|http/i;
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function buildValidationMatrices(input: {
  gaps: EvidenceGap[];
  traffic: TrafficEntry[];
  identities: IdentityContext[];
}): ValidationMatrix[] {
  const trafficById = new Map(input.traffic.map((entry) => [entry.id, entry]));
  const activeIdentities = input.identities.filter((identity) => identity.status === "active");

  return input.gaps
    .filter((gap) => NETWORK_COLLECTION.test(gap.collectionMethod))
    .slice(0, 4)
    .map((gap) => {
      const traffic = gap.trafficId ? trafficById.get(gap.trafficId) : undefined;
      const baselineIdentityId = traffic?.identityId
        ?? activeIdentities.find((identity) => identity.id !== gap.identityId)?.id
        ?? activeIdentities[0]?.id
        ?? null;
      const variantIdentityId = gap.identityId && gap.identityId !== baselineIdentityId
        ? gap.identityId
        : activeIdentities.find((identity) => identity.id !== baselineIdentityId)?.id ?? null;
      const method = traffic?.method.toUpperCase() ?? "GET";
      const requiresApproval = MUTATING_METHODS.has(method);
      const target = traffic ? `${method} ${traffic.url}` : "the captured target request";
      const experiments: ValidationExperiment[] = [
        {
          id: `${gap.id}:baseline`,
          gapId: gap.id,
          role: "baseline",
          identityId: baselineIdentityId,
          trafficId: traffic?.id ?? null,
          changedVariable: "none — preserve request, parameters, and baseline identity",
          expectedSecureResult: `Baseline identity receives its normal authorized response for ${target}.`,
          evidenceToRecord: "status, response fingerprint, relevant body fields, identity version, and traffic ID",
          requiresApproval,
          stopCondition: requiresApproval
            ? "Stop after one controlled baseline mutation and restore state when restoration is supported."
            : "Stop when a stable baseline response is recorded.",
        },
        {
          id: `${gap.id}:identity-variant`,
          gapId: gap.id,
          role: "variant",
          identityId: variantIdentityId,
          trafficId: traffic?.id ?? null,
          changedVariable: variantIdentityId
            ? `identity only: ${baselineIdentityId ?? "baseline"} -> ${variantIdentityId}`
            : "authentication only: authenticated baseline -> unauthenticated request",
          expectedSecureResult: `The variant must be denied or return no protected resource/state from ${target}.`,
          evidenceToRecord: "same response fields as baseline plus the exact authorization differential; do not infer impact from status code alone",
          requiresApproval,
          stopCondition: "Stop after the first conclusive differential. If inconclusive, record the ambiguity instead of adding parameter permutations.",
        },
      ];
      return { gapId: gap.id, sourceId: gap.sourceId, experiments };
    });
}

export function formatValidationMatrices(matrices: ValidationMatrix[]): string {
  if (!matrices.length) return "No network evidence gap currently has enough structure for a controlled validation matrix.";
  return [
    "Minimal controlled validation matrices (execute one matrix at a time):",
    ...matrices.flatMap((matrix, matrixIndex) => [
      `${matrixIndex + 1}. Gap ${matrix.gapId} / source ${matrix.sourceId}`,
      ...matrix.experiments.map((experiment) =>
        `   - ${experiment.role} ${experiment.id}: traffic=${experiment.trafficId ?? "capture first"}; identity=${experiment.identityId ?? "unauthenticated"}; change=${experiment.changedVariable}; expected=${experiment.expectedSecureResult}; record=${experiment.evidenceToRecord}; approval=${experiment.requiresApproval ? "required" : "normal"}; stop=${experiment.stopCondition}`),
    ]),
    "Keep URL, method, body, and headers constant between baseline and variant except for the named variable. Do not expand into brute-force permutations.",
  ].join("\n");
}
