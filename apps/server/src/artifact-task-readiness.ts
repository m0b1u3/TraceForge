import {
  aggregateArtifactAnalysis,
  type ArtifactAnalysisAttempt,
  type ArtifactRecord,
  type Fact,
  type Task,
} from "@traceforge/shared";
import type { TaskCompletionGateResult } from "@traceforge/extension";

export interface ArtifactTaskReadinessItem {
  artifactId: string;
  quality: ReturnType<typeof aggregateArtifactAnalysis>["quality"];
  missingDimensions: ReturnType<typeof aggregateArtifactAnalysis>["missingDimensions"];
  hasTraceablePositiveEvidence: boolean;
}

export interface ArtifactTaskReadiness extends TaskCompletionGateResult {
  artifacts: ArtifactTaskReadinessItem[];
}

function artifactIdForFact(fact: Fact): string | null {
  if (fact.source.type !== "artifact_analysis") return null;
  return fact.source.ref || null;
}

function isTraceablePositiveArtifactEvidence(fact: Fact, artifactId: string): boolean {
  return fact.source.type === "artifact_analysis"
    && fact.source.ref === artifactId
    && fact.type === "artifact_evidence"
    && fact.validity === "valid"
    && Boolean(fact.verificationSummary?.trim())
    && Boolean(fact.observations?.some((observation) =>
      observation.sourceType === "artifact_analysis" && observation.sourceRef === artifactId));
}

export function evaluateArtifactTaskReadiness(input: {
  task: Pick<Task, "relatedFacts">;
  facts: Fact[];
  artifacts: ArtifactRecord[];
  attempts: ArtifactAnalysisAttempt[];
}): ArtifactTaskReadiness {
  const related = new Set(input.task.relatedFacts);
  const relatedFacts = input.facts.filter((fact) => related.has(fact.id));
  const artifactIds = [...new Set(relatedFacts.flatMap((fact) => {
    const artifactId = artifactIdForFact(fact);
    return artifactId ? [artifactId] : [];
  }))];
  const artifactsById = new Map(input.artifacts.map((artifact) => [artifact.id, artifact]));
  const items: ArtifactTaskReadinessItem[] = [];
  const missing: string[] = [];

  for (const artifactId of artifactIds) {
    const artifact = artifactsById.get(artifactId);
    if (!artifact) {
      missing.push(`Artifact ${artifactId} referenced by the Task is unavailable`);
      continue;
    }
    const aggregate = aggregateArtifactAnalysis(
      artifact,
      input.attempts.filter((attempt) => attempt.artifactId === artifactId),
    );
    const hasTraceablePositiveEvidence = relatedFacts.some((fact) =>
      isTraceablePositiveArtifactEvidence(fact, artifactId));
    items.push({
      artifactId,
      quality: aggregate.quality,
      missingDimensions: aggregate.missingDimensions,
      hasTraceablePositiveEvidence,
    });
    if (aggregate.quality !== "substantial" && !hasTraceablePositiveEvidence) {
      const gap = aggregate.missingDimensions.length > 0
        ? `missing cumulative coverage: ${aggregate.missingDimensions.join(", ")}`
        : `analysis state: ${aggregate.quality}`;
      missing.push(`Artifact ${artifactId} has ${gap}; continue analysis or retain the limitation without asserting absence`);
    }
  }

  return { allowed: missing.length === 0, missing, artifacts: items };
}

export function combineTaskCompletionGates(...results: TaskCompletionGateResult[]): TaskCompletionGateResult {
  const missing = [...new Set(results.flatMap((result) => result.missing))];
  return { allowed: results.every((result) => result.allowed), missing };
}
