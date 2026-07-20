import type { AttackPath, Fact, IdentityContext } from "@traceforge/shared";
import type { SharedKnowledgeContext } from "@traceforge/reasoning-core";

export interface SharedKnowledgeSources {
  facts: Fact[];
  identities: IdentityContext[];
  attackPaths: AttackPath[];
}

const clip = (value: string, max = 180): string => value.length <= max ? value : `${value.slice(0, max)}…`;

export function buildSharedKnowledge(sources: SharedKnowledgeSources, currentRunId: string): SharedKnowledgeContext {
  const excluded = sources.facts.filter((fact) =>
    fact.validity !== "valid" || ["needs_review", "rejected", "stale"].includes(fact.findingStatus ?? ""));
  const verifiedFindings = sources.facts
    .filter((fact) => fact.type === "finding" && fact.validity === "valid" && fact.findingStatus === "verified")
    .sort((a, b) => b.confidence - a.confidence || b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 6);
  const identities = sources.identities
    .filter((identity) => identity.status === "active")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 5);
  const attackPaths = sources.attackPaths
    .filter((path) => path.status !== "invalidated")
    .sort((a, b) => Number(b.status === "validated") - Number(a.status === "validated") || b.confidence - a.confidence)
    .slice(0, 5);
  const failedAttempts = sources.facts
    .filter((fact) => fact.type === "failed_attempt" && fact.validity === "valid" && fact.sourceRunId !== currentRunId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
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
