import type { AttackPath, Fact, IdentityContext } from "@traceforge/shared";
import { keywordScore, type SharedKnowledgeContext } from "@traceforge/reasoning-core";

export interface SharedKnowledgeSources {
  facts: Fact[];
  identities: IdentityContext[];
  attackPaths: AttackPath[];
}

export interface SharedKnowledgeFocus {
  goal: string;
  phase?: "scope" | "discover" | "map" | "test" | "validate" | "chain" | "report";
  host?: string;
  url?: string;
  note?: string;
}

const clip = (value: string, max = 180): string => value.length <= max ? value : `${value.slice(0, max)}…`;

function focusScore(text: string, focus: SharedKnowledgeFocus): number {
  const queries = [focus.goal, focus.host, focus.url, focus.note].filter((value): value is string => Boolean(value?.trim()));
  return queries.reduce((score, query) => score + keywordScore(query, text) * 8, 0)
    + (focus.host && text.toLowerCase().includes(focus.host.toLowerCase()) ? 40 : 0)
    + (focus.url && text.toLowerCase().includes(focus.url.toLowerCase()) ? 30 : 0);
}

function freshness(updatedAt: string): number {
  const ageDays = Math.max(0, (Date.now() - new Date(updatedAt).getTime()) / 86_400_000);
  return Math.max(0, 5 - ageDays * 0.1);
}

export function buildSharedKnowledge(sources: SharedKnowledgeSources, currentRunId: string, focus: SharedKnowledgeFocus = { goal: "" }): SharedKnowledgeContext {
  const excluded = sources.facts.filter((fact) =>
    fact.validity !== "valid" || ["needs_review", "rejected", "stale"].includes(fact.findingStatus ?? ""));
  const pathScores = new Map(sources.attackPaths.map((path) => [path.id, focusScore(`${path.title} ${path.objective} ${path.breakpoint ?? ""} ${path.steps.map((step) => `${step.title} ${step.description} ${step.validation}`).join(" ")}`, focus)]));
  const linkedFindingBoost = new Map<string, number>();
  const linkedIdentityBoost = new Map<string, number>();
  for (const path of sources.attackPaths) {
    const score = pathScores.get(path.id) ?? 0;
    for (const id of path.findingFactIds) linkedFindingBoost.set(id, Math.max(linkedFindingBoost.get(id) ?? 0, score * 0.5));
    if (path.entryIdentityId) linkedIdentityBoost.set(path.entryIdentityId, Math.max(linkedIdentityBoost.get(path.entryIdentityId) ?? 0, score * 0.4));
    for (const step of path.steps) if (step.identityId) linkedIdentityBoost.set(step.identityId, Math.max(linkedIdentityBoost.get(step.identityId) ?? 0, score * 0.3));
  }
  const phase = focus.phase ?? "discover";
  const verifiedFindings = sources.facts
    .filter((fact) => fact.type === "finding" && fact.validity === "valid" && fact.findingStatus === "verified")
    .sort((a, b) => {
      const score = (fact: Fact) => focusScore(`${fact.type} ${fact.title} ${JSON.stringify(fact.value)} ${fact.tags.join(" ")} ${fact.verificationSummary ?? ""}`, focus)
        + (linkedFindingBoost.get(fact.id) ?? 0) + fact.confidence * 10 + freshness(fact.updatedAt)
        + (["validate", "chain", "report"].includes(phase) ? 15 : 0);
      return score(b) - score(a) || b.updatedAt.localeCompare(a.updatedAt);
    })
    .slice(0, 6);
  const identities = sources.identities
    .filter((identity) => identity.status === "active")
    .sort((a, b) => {
      const score = (identity: IdentityContext) => focusScore(`${identity.name} ${identity.kind} ${JSON.stringify(identity.credentials)} ${Object.keys(identity.headers).join(" ")}`, focus)
        + (linkedIdentityBoost.get(identity.id) ?? 0) + freshness(identity.updatedAt)
        + (["test", "validate", "chain"].includes(phase) ? 10 : 0);
      return score(b) - score(a) || b.updatedAt.localeCompare(a.updatedAt);
    })
    .slice(0, 5);
  const attackPaths = sources.attackPaths
    .filter((path) => path.status !== "invalidated")
    .sort((a, b) => {
      const score = (path: AttackPath) => (pathScores.get(path.id) ?? 0) + path.confidence * 10
        + (path.status === "validated" ? 20 : 0) + (["chain", "validate", "report"].includes(phase) ? 15 : 0) + freshness(path.updatedAt);
      return score(b) - score(a) || b.updatedAt.localeCompare(a.updatedAt);
    })
    .slice(0, 5);
  const failedAttempts = sources.facts
    .filter((fact) => fact.type === "failed_attempt" && fact.validity === "valid" && fact.sourceRunId !== currentRunId)
    .sort((a, b) => {
      const score = (fact: Fact) => focusScore(`${fact.title} ${JSON.stringify(fact.value)}`, focus) + freshness(fact.updatedAt)
        + (["test", "validate"].includes(phase) ? 8 : 0);
      return score(b) - score(a) || b.updatedAt.localeCompare(a.updatedAt);
    })
    .slice(0, 5);

  return {
    verifiedFindings: verifiedFindings.map((fact) => `${fact.id} ${fact.title} — ${clip(fact.verificationSummary ?? JSON.stringify(fact.value))}`),
    identities: identities.map((identity) => {
      const credentials = Object.keys(identity.credentials).length ? ` credentials=${clip(JSON.stringify(identity.credentials), 120)}` : "";
      return `${identity.id} [${identity.kind}] ${identity.name} v${identity.version}${credentials}`;
    }),
    attackPaths: attackPaths.map((path) => `${path.id} [${path.status}] ${path.title}; objective=${clip(path.objective)}${path.breakpoint ? `; breakpoint=${clip(path.breakpoint)}` : ""}`),
    failedAttempts: failedAttempts.map((fact) => `${fact.id} ${clip(JSON.stringify(fact.value))}`),
    excludedConflictCount: excluded.length,
    injectedFactIds: [...verifiedFindings.map((fact) => fact.id), ...failedAttempts.map((fact) => fact.id)],
  };
}
