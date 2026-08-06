import { describe, expect, it } from "vitest";
import type { ArtifactAnalysisAttempt, ArtifactAnalyzerCapability, ArtifactRecord } from "@traceforge/shared";
import { planArtifactAnalysis } from "./artifact-analysis-planner.js";

const artifact: ArtifactRecord = {
  id: "artifact_1", caseId: "case_1", runId: "run_1", sourceUrl: null,
  filename: "evidence.bin", relativePath: "downloads/evidence.bin", byteSize: 32,
  sha256: "a".repeat(64), detectedFormat: "structured-binary", mediaType: null,
  status: "analyzed", analyzerId: "metadata-analyzer",
  analysis: {
    analyzerId: "metadata-analyzer", summary: "Metadata inspected.", findings: [],
    coverage: { metadata: true, text: false, objectGraph: false, limitations: ["Other layers remain uninspected."] },
  },
  error: null, createdAt: "now", updatedAt: "now",
};
const capabilities: ArtifactAnalyzerCapability[] = [
  { analyzerId: "metadata-analyzer", compatible: true, coverageDimensions: ["metadata"], description: "Metadata" },
  { analyzerId: "text-analyzer", compatible: true, coverageDimensions: ["text"], description: "Text" },
  { analyzerId: "graph-analyzer", compatible: true, coverageDimensions: ["metadata", "object_graph"], description: "Graph" },
];
const successfulAttempt: ArtifactAnalysisAttempt = {
  id: "attempt_1", caseId: "case_1", runId: "run_1", artifactId: "artifact_1",
  analyzerId: "metadata-analyzer", status: "succeeded", coverageDimensions: ["metadata"],
  error: null, analysis: artifact.analysis, startedAt: "a", finishedAt: "b",
};

describe("artifact analysis planner", () => {
  it("recommends exactly one untried analyzer with the largest missing coverage gain", () => {
    const plan = planArtifactAnalysis(artifact, capabilities, [successfulAttempt]);
    expect(plan).toMatchObject({ status: "ready", recommendedAnalyzerId: "graph-analyzer" });
    expect(plan.candidates.filter((candidate) => candidate.eligible)).toHaveLength(2);
    expect(plan.candidates[0]).toMatchObject({ analyzerId: "graph-analyzer", coverageGain: ["object_graph"] });
  });

  it("does not treat failed execution as exhausted analysis", () => {
    const attempts: ArtifactAnalysisAttempt[] = capabilities.map((capability, index) => ({
      ...successfulAttempt,
      id: `attempt_${index}`,
      analyzerId: capability.analyzerId,
      status: index === 0 ? "succeeded" : "failed",
      coverageDimensions: capability.coverageDimensions,
      analysis: index === 0 ? artifact.analysis : null,
    }));
    expect(planArtifactAnalysis(artifact, capabilities, attempts)).toMatchObject({
      status: "recovery_required",
      recommendedAnalyzerId: null,
    });
  });

  it("requires dependency recovery when a compatible analyzer fails preflight", () => {
    const plan = planArtifactAnalysis(artifact, [{
      analyzerId: "object-analyzer", compatible: true, coverageDimensions: ["object_graph"],
      description: "Object relationships", availability: "unavailable",
      availabilityReason: "Required executable is not installed.",
      recoveryHint: "Install the analyzer dependency and re-plan.",
    }], [successfulAttempt]);

    expect(plan).toMatchObject({
      status: "recovery_required", recommendedAnalyzerId: null,
      candidates: [{ analyzerId: "object-analyzer", availability: "unavailable", requiresRecovery: true, eligible: false }],
    });
    expect(plan.reason).toContain("Install the analyzer dependency");
  });

  it("reports exhaustion only after compatible paths ended as unsupported", () => {
    const attempts: ArtifactAnalysisAttempt[] = capabilities.map((capability, index) => ({
      ...successfulAttempt, id: `unsupported_${index}`, analyzerId: capability.analyzerId,
      status: "unsupported", coverageDimensions: capability.coverageDimensions, analysis: null,
    }));
    expect(planArtifactAnalysis(artifact, capabilities, attempts)).toMatchObject({
      status: "exhausted", recommendedAnalyzerId: null,
    });
  });

  it("waits for a running attempt instead of proposing concurrent analysis", () => {
    expect(planArtifactAnalysis(artifact, capabilities, [{ ...successfulAttempt, status: "running", finishedAt: null }])).toMatchObject({
      status: "running",
      recommendedAnalyzerId: null,
    });
  });

  it("completes from cumulative attempt coverage even when the latest artifact result is partial", () => {
    const textAnalysis = {
      analyzerId: "text-analyzer", summary: "Text inspected.", findings: [],
      coverage: { metadata: false, text: true, objectGraph: false, limitations: [] },
    };
    const graphAnalysis = {
      analyzerId: "graph-analyzer", summary: "Graph inspected.", findings: [],
      coverage: { metadata: false, text: false, objectGraph: true, limitations: [] },
    };
    const latestArtifact = { ...artifact, analyzerId: "graph-analyzer", analysis: graphAnalysis };
    const attempts: ArtifactAnalysisAttempt[] = [
      successfulAttempt,
      { ...successfulAttempt, id: "attempt_2", analyzerId: "text-analyzer", coverageDimensions: ["text"], analysis: textAnalysis },
      { ...successfulAttempt, id: "attempt_3", analyzerId: "graph-analyzer", coverageDimensions: ["object_graph"], analysis: graphAnalysis },
    ];

    expect(planArtifactAnalysis(latestArtifact, capabilities, attempts)).toMatchObject({
      status: "complete",
      missingDimensions: [],
      recommendedAnalyzerId: null,
    });
  });
});
