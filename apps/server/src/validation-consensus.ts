import type { TrafficEntry } from "@traceforge/shared";
import type { ValidationConclusion } from "./stores/validation-conclusion-store.js";

export type ValidationConsensusStatus = "insufficient" | "supported" | "conflicted" | "refuted";

export interface ValidationConsensusResult {
  findingId: string;
  status: ValidationConsensusStatus;
  independentSupports: number;
  independentRefutes: number;
  inconclusive: number;
  duplicatesExcluded: number;
  confidence: number;
  recommendation: "collect_more" | "mark_verified" | "keep_needs_review" | "consider_rejected";
  evidenceGroups: Array<{
    key: string;
    verdict: "supports" | "refutes";
    conclusionIds: string[];
  }>;
  rationale: string[];
}

export function evaluateValidationConsensus(input: {
  findingId: string;
  conclusions: ValidationConclusion[];
  traffic: TrafficEntry[];
}): ValidationConsensusResult {
  const traffic = new Map(input.traffic.map((entry) => [entry.id, entry]));
  const relevant = input.conclusions.filter((item) => item.findingId === input.findingId);
  const grouped = new Map<string, ValidationConclusion[]>();
  let inconclusive = 0;
  for (const conclusion of relevant) {
    if (conclusion.verdict === "inconclusive") {
      inconclusive += 1;
      continue;
    }
    const variant = traffic.get(conclusion.variantTrafficId);
    const sourceRequest = variant?.parentTrafficId ?? conclusion.variantTrafficId;
    const identity = conclusion.identityId ?? variant?.identityId ?? "unknown";
    const key = `${conclusion.runId}|${identity}|${sourceRequest}`;
    const list = grouped.get(key) ?? [];
    list.push(conclusion);
    grouped.set(key, list);
  }

  const evidenceGroups = [...grouped.entries()].flatMap(([key, items]) => {
    const strongestSupport = items
      .filter((item) => item.verdict === "supports" && item.confidence >= 0.75)
      .sort((left, right) => right.confidence - left.confidence)[0];
    const strongestRefute = items
      .filter((item) => item.verdict === "refutes" && item.confidence >= 0.8)
      .sort((left, right) => right.confidence - left.confidence)[0];
    return [
      strongestSupport ? {
        key,
        verdict: "supports" as const,
        conclusionIds: items.filter((item) => item.verdict === "supports").map((item) => item.id),
        confidence: strongestSupport.confidence,
      } : null,
      strongestRefute ? {
        key,
        verdict: "refutes" as const,
        conclusionIds: items.filter((item) => item.verdict === "refutes").map((item) => item.id),
        confidence: strongestRefute.confidence,
      } : null,
    ].filter((item): item is NonNullable<typeof item> => item !== null);
  });
  const independentSupports = evidenceGroups.filter((group) => group.verdict === "supports").length;
  const independentRefutes = evidenceGroups.filter((group) => group.verdict === "refutes").length;
  const duplicatesExcluded = relevant.length - inconclusive - evidenceGroups.length;
  const confidence = evidenceGroups.length
    ? Number((evidenceGroups.reduce((sum, group) => sum + group.confidence, 0) / evidenceGroups.length).toFixed(4))
    : 0;

  let status: ValidationConsensusStatus = "insufficient";
  let recommendation: ValidationConsensusResult["recommendation"] = "collect_more";
  if (independentSupports > 0 && independentRefutes > 0) {
    status = "conflicted";
    recommendation = "keep_needs_review";
  } else if (independentSupports >= 2) {
    status = "supported";
    recommendation = "mark_verified";
  } else if (independentRefutes >= 2) {
    status = "refuted";
    recommendation = "consider_rejected";
  }
  const rationale = [
    `${independentSupports} independent supporting group(s)`,
    `${independentRefutes} independent refuting group(s)`,
    `${inconclusive} inconclusive conclusion(s)`,
    `${Math.max(0, duplicatesExcluded)} duplicate conclusion(s) excluded`,
  ];
  return {
    findingId: input.findingId,
    status,
    independentSupports,
    independentRefutes,
    inconclusive,
    duplicatesExcluded: Math.max(0, duplicatesExcluded),
    confidence,
    recommendation,
    evidenceGroups: evidenceGroups.map(({ confidence: _confidence, ...group }) => group),
    rationale,
  };
}
