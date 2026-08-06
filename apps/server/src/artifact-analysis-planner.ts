import { aggregateArtifactAnalysis, type ArtifactAnalysisAttempt, type ArtifactAnalyzerCapability, type ArtifactRecord } from "@traceforge/shared";

export interface ArtifactAnalysisCandidate {
  analyzerId: string;
  coverageGain: ArtifactAnalyzerCapability["coverageDimensions"];
  eligible: boolean;
  availability: "ready" | "degraded" | "unavailable";
  requiresRecovery: boolean;
  recoveryHint: string | null;
  reason: string;
}

export interface ArtifactAnalysisPlan {
  artifactId: string;
  status: "complete" | "ready" | "running" | "blocked" | "recovery_required" | "exhausted";
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
  const aggregate = aggregateArtifactAnalysis(artifact, attempts);
  const missingDimensions = aggregate.missingDimensions;
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
  if (aggregate.quality === "substantial") {
    return {
      artifactId: artifact.id,
      status: "complete",
      missingDimensions: [],
      recommendedAnalyzerId: null,
      candidates: [],
      reason: "All cumulative coverage dimensions are already satisfied across successful analysis attempts.",
    };
  }

  const latestByAnalyzer = new Map<string, ArtifactAnalysisAttempt>();
  for (const attempt of attempts) {
    if (attempt.analyzerId && !latestByAnalyzer.has(attempt.analyzerId)) latestByAnalyzer.set(attempt.analyzerId, attempt);
  }
  const candidates = capabilities.filter((capability) => capability.compatible).map((capability) => {
    const previous = latestByAnalyzer.get(capability.analyzerId);
    const coverageGain = capability.coverageDimensions.filter((dimension) => missingDimensions.includes(dimension));
    const availability = capability.availability ?? "ready";
    const recoveryHint = capability.recoveryHint ?? null;
    if (availability === "unavailable") {
      return {
        analyzerId: capability.analyzerId, coverageGain, eligible: false, availability,
        requiresRecovery: true, recoveryHint,
        reason: `preflight unavailable: ${capability.availabilityReason ?? "required analyzer dependency is unavailable"}`,
      };
    }
    if (previous?.status === "running") {
      return { analyzerId: capability.analyzerId, coverageGain, eligible: false, availability, requiresRecovery: false, recoveryHint, reason: "already running" };
    }
    if (previous?.status === "failed") {
      return {
        analyzerId: capability.analyzerId, coverageGain, eligible: false, availability,
        requiresRecovery: true, recoveryHint,
        reason: `previous attempt failed: ${previous.error ?? "execution did not complete"}; confirm changed conditions before retrying`,
      };
    }
    if (previous?.status === "unsupported") {
      return { analyzerId: capability.analyzerId, coverageGain, eligible: false, availability, requiresRecovery: false, recoveryHint, reason: "previous attempt was unsupported" };
    }
    if (previous?.status === "succeeded") {
      return { analyzerId: capability.analyzerId, coverageGain, eligible: false, availability, requiresRecovery: false, recoveryHint, reason: "coverage already collected" };
    }
    return {
      analyzerId: capability.analyzerId,
      coverageGain,
      availability,
      requiresRecovery: false,
      recoveryHint,
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
  const recoverable = candidates.filter((candidate) => candidate.requiresRecovery);
  if (recoverable.length > 0) {
    return {
      artifactId: artifact.id,
      status: "recovery_required",
      missingDimensions,
      recommendedAnalyzerId: null,
      candidates,
      reason: `Analyzer execution is not exhausted: ${recoverable.map((candidate) => `${candidate.analyzerId}: ${candidate.reason}${candidate.recoveryHint ? `; recovery=${candidate.recoveryHint}` : ""}`).join(" | ")}`,
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
