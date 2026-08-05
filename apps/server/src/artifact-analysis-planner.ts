import { assessArtifactCoverage, type ArtifactAnalysisAttempt, type ArtifactAnalyzerCapability, type ArtifactRecord } from "@traceforge/shared";

export interface ArtifactAnalysisCandidate {
  analyzerId: string;
  coverageGain: ArtifactAnalyzerCapability["coverageDimensions"];
  eligible: boolean;
  reason: string;
}

export interface ArtifactAnalysisPlan {
  artifactId: string;
  status: "complete" | "ready" | "running" | "blocked" | "exhausted";
  missingDimensions: ArtifactAnalyzerCapability["coverageDimensions"];
  recommendedAnalyzerId: string | null;
  candidates: ArtifactAnalysisCandidate[];
  reason: string;
}

export function planArtifactAnalysis(
  artifact: ArtifactRecord,
  capabilities: ArtifactAnalyzerCapability[],
  attempts: ArtifactAnalysisAttempt[],
): ArtifactAnalysisPlan {
  const assessment = assessArtifactCoverage(artifact);
  const missingDimensions = artifact.analysis
    ? assessment.missingDimensions
    : ["metadata", "text", "object_graph"] as ArtifactAnalyzerCapability["coverageDimensions"];
  const running = attempts.find((attempt) => attempt.status === "running");
  if (running) {
    return {
      artifactId: artifact.id,
      status: "running",
      missingDimensions,
      recommendedAnalyzerId: null,
      candidates: [],
      reason: `Analysis attempt ${running.id} is still running with ${running.analyzerId ?? "an unresolved analyzer"}.`,
    };
  }
  if (assessment.quality === "substantial") {
    return {
      artifactId: artifact.id,
      status: "complete",
      missingDimensions: [],
      recommendedAnalyzerId: null,
      candidates: [],
      reason: "All declared coverage dimensions are already satisfied.",
    };
  }

  const latestByAnalyzer = new Map<string, ArtifactAnalysisAttempt>();
  for (const attempt of attempts) {
    if (attempt.analyzerId && !latestByAnalyzer.has(attempt.analyzerId)) latestByAnalyzer.set(attempt.analyzerId, attempt);
  }
  const candidates = capabilities.filter((capability) => capability.compatible).map((capability) => {
    const previous = latestByAnalyzer.get(capability.analyzerId);
    const coverageGain = capability.coverageDimensions.filter((dimension) => missingDimensions.includes(dimension));
    if (previous?.status === "running") {
      return { analyzerId: capability.analyzerId, coverageGain, eligible: false, reason: "already running" };
    }
    if (previous?.status === "failed" || previous?.status === "unsupported") {
      return { analyzerId: capability.analyzerId, coverageGain, eligible: false, reason: `previous attempt ${previous.status}` };
    }
    if (previous?.status === "succeeded") {
      return { analyzerId: capability.analyzerId, coverageGain, eligible: false, reason: "coverage already collected" };
    }
    return {
      analyzerId: capability.analyzerId,
      coverageGain,
      eligible: coverageGain.length > 0 || capability.coverageDimensions.length === 0,
      reason: coverageGain.length > 0 ? `adds ${coverageGain.join(", ")}` : "declared coverage does not close the current gap",
    };
  }).sort((left, right) =>
    Number(right.eligible) - Number(left.eligible)
    || right.coverageGain.length - left.coverageGain.length
    || left.analyzerId.localeCompare(right.analyzerId));
  const recommended = candidates.find((candidate) => candidate.eligible) ?? null;
  if (recommended) {
    return {
      artifactId: artifact.id,
      status: "ready",
      missingDimensions,
      recommendedAnalyzerId: recommended.analyzerId,
      candidates,
      reason: `Run ${recommended.analyzerId} next; it provides the largest untried declared coverage gain.`,
    };
  }
  const compatible = capabilities.some((capability) => capability.compatible);
  return {
    artifactId: artifact.id,
    status: compatible ? "exhausted" : "blocked",
    missingDimensions,
    recommendedAnalyzerId: null,
    candidates,
    reason: compatible
      ? "Every compatible analyzer has already completed or failed; retain the unresolved limitation unless conditions change."
      : "No registered analyzer is compatible with this artifact.",
  };
}
