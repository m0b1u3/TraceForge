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

  it("does not recommend failed methods again and reports exhaustion", () => {
    const attempts: ArtifactAnalysisAttempt[] = capabilities.map((capability, index) => ({
      ...successfulAttempt,
      id: `attempt_${index}`,
      analyzerId: capability.analyzerId,
      status: index === 0 ? "succeeded" : "failed",
      coverageDimensions: capability.coverageDimensions,
      analysis: index === 0 ? artifact.analysis : null,
    }));
    expect(planArtifactAnalysis(artifact, capabilities, attempts)).toMatchObject({
      status: "exhausted",
      recommendedAnalyzerId: null,
    });
  });

  it("waits for a running attempt instead of proposing concurrent analysis", () => {
    expect(planArtifactAnalysis(artifact, capabilities, [{ ...successfulAttempt, status: "running", finishedAt: null }])).toMatchObject({
      status: "running",
      recommendedAnalyzerId: null,
    });
  });
});
