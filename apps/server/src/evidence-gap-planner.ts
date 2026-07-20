import type { AttackPath, Fact, IdentityContext, TrafficEntry } from "@traceforge/shared";
import { keywordScore } from "@traceforge/reasoning-core";

export type EvidenceGapSource = "finding" | "attack_path";

export interface EvidenceGap {
  id: string;
  source: EvidenceGapSource;
  sourceId: string;
  requirement: string;
  collectionMethod: string;
  identityId: string | null;
  trafficId: string | null;
  validationCondition: string;
  score: number;
}

function bestTraffic(text: string, traffic: TrafficEntry[]): TrafficEntry | undefined {
  return [...traffic].sort((left, right) =>
    keywordScore(text, `${right.method} ${right.url} ${right.requestBody ?? ""}`) -
    keywordScore(text, `${left.method} ${left.url} ${left.requestBody ?? ""}`) ||
    right.createdAt.localeCompare(left.createdAt),
  )[0];
}

function alternateIdentity(
  preferredId: string | null | undefined,
  identities: IdentityContext[],
): IdentityContext | undefined {
  return identities.find((identity) => identity.status === "active" && identity.id !== preferredId)
    ?? identities.find((identity) => identity.status === "active");
}

function severityBoost(fact: Fact): number {
  const value = fact.value as { severity?: string } | undefined;
  return ({ critical: 20, high: 15, medium: 10, low: 5, info: 0 } as Record<string, number>)[value?.severity ?? ""] ?? 5;
}

export function mapEvidenceGaps(input: {
  facts: Fact[];
  paths: AttackPath[];
  traffic: TrafficEntry[];
  identities: IdentityContext[];
}): EvidenceGap[] {
  const gaps: EvidenceGap[] = [];
  const activeIdentities = input.identities.filter((identity) => identity.status === "active");

  for (const finding of input.facts.filter((fact) =>
    fact.type === "finding" && fact.validity === "valid" && fact.findingStatus !== "verified" &&
    !["rejected", "stale"].includes(fact.findingStatus ?? ""))) {
    const text = `${finding.title} ${JSON.stringify(finding.value)} ${finding.tags.join(" ")}`;
    const traffic = bestTraffic(text, input.traffic);
    const identity = alternateIdentity(traffic?.identityId, activeIdentities);
    const base = 70 + severityBoost(finding);

    if (!finding.evidenceRefs?.length) {
      gaps.push({
        id: `gap:${finding.id}:evidence`,
        source: "finding",
        sourceId: finding.id,
        requirement: "Record a non-Finding evidence Fact linked to the candidate.",
        collectionMethod: traffic ? "replay_traffic then record_fact" : "capture browser/http traffic then record_fact",
        identityId: identity?.id ?? traffic?.identityId ?? null,
        trafficId: traffic?.id ?? null,
        validationCondition: "The evidence must identify the exact request, response, identity, and tested condition.",
        score: base + 10,
      });
    }
    if (!finding.observations?.length) {
      gaps.push({
        id: `gap:${finding.id}:observation`,
        source: "finding",
        sourceId: finding.id,
        requirement: "Produce a controlled observation under a named identity and condition.",
        collectionMethod: traffic ? "replay_traffic with an alternate identity" : "http_replay with explicit identity attribution",
        identityId: identity?.id ?? null,
        trafficId: traffic?.id ?? null,
        validationCondition: "Compare baseline and variant responses; record sourceRef, identityId, condition, and a concrete differential.",
        score: base + 15,
      });
    }
    if (!finding.hypothesisIds?.length || !finding.taskIds?.length || !finding.actionIds?.length) {
      const missing = [
        !finding.hypothesisIds?.length ? "Hypothesis" : "",
        !finding.taskIds?.length ? "Task" : "",
        !finding.actionIds?.length ? "Action" : "",
      ].filter(Boolean).join(", ");
      gaps.push({
        id: `gap:${finding.id}:provenance`,
        source: "finding",
        sourceId: finding.id,
        requirement: `Complete investigation provenance: ${missing}.`,
        collectionMethod: "record_hypothesis / record_task / record_action",
        identityId: null,
        trafficId: traffic?.id ?? null,
        validationCondition: "Every reference must resolve inside this case and preserve the evidence-to-decision chain.",
        score: base,
      });
    }
    if (!finding.verificationSummary?.trim()) {
      gaps.push({
        id: `gap:${finding.id}:summary`,
        source: "finding",
        sourceId: finding.id,
        requirement: "Write a verification summary after controlled reproduction.",
        collectionMethod: "record_fact update",
        identityId: identity?.id ?? null,
        trafficId: traffic?.id ?? null,
        validationCondition: "Summarize baseline, changed variable, observed differential, and security impact without adding unsupported claims.",
        score: base - 5,
      });
    }
  }

  for (const path of input.paths.filter((item) => item.status !== "validated" && item.status !== "invalidated")) {
    for (const step of path.steps.filter((item) => item.status !== "verified" && item.status !== "refuted")) {
      const traffic = input.traffic.find((item) => item.id === step.trafficId)
        ?? bestTraffic(`${path.title} ${path.objective} ${step.title} ${step.description}`, input.traffic);
      const identity = input.identities.find((item) => item.id === step.identityId)
        ?? input.identities.find((item) => item.id === path.entryIdentityId)
        ?? alternateIdentity(traffic?.identityId, activeIdentities);
      gaps.push({
        id: `gap:${path.id}:${step.id}`,
        source: "attack_path",
        sourceId: path.id,
        requirement: step.factIds.length
          ? `Revalidate step ${step.id} and promote its existing evidence.`
          : `Collect a Fact that verifies step ${step.id}: ${step.title}.`,
        collectionMethod: traffic ? "replay_traffic under the mapped identity" : "capture or http_replay the mapped request",
        identityId: identity?.id ?? null,
        trafficId: traffic?.id ?? null,
        validationCondition: step.validation || path.breakpoint || `Demonstrate ${step.title} with a reproducible request/response observation.`,
        score: Math.round(55 + path.confidence * 20 + (step.status === "blocked" ? 15 : 5)),
      });
    }
  }

  return gaps.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
}

export function formatEvidenceGapPlan(gaps: EvidenceGap[], limit = 6): string {
  if (!gaps.length) return "No explicit evidence gaps are currently derivable from candidate Findings or active Attack Paths.";
  return [
    "Evidence gaps mapped to concrete collection actions:",
    ...gaps.slice(0, limit).map((gap, index) =>
      `${index + 1}. ${gap.id} score=${gap.score} — ${gap.requirement} method=${gap.collectionMethod}; identity=${gap.identityId ?? "select explicitly"}; traffic=${gap.trafficId ?? "capture/select"}; verify=${gap.validationCondition}`),
    "Close a gap only with recorded evidence. Do not mark a Finding or path step verified from reasoning alone.",
  ].join("\n");
}
