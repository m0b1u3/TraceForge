import { describe, expect, it } from "vitest";
import type { ArtifactAnalysis, ArtifactAnalysisAttempt, ArtifactRecord } from "./index.js";
import { aggregateArtifactAnalysis } from "./artifact-analysis-aggregate.js";

const metadataAnalysis: ArtifactAnalysis = {
  analyzerId: "metadata-analyzer",
  summary: "Metadata inspected.",
  findings: [{
    kind: "identifier",
    label: "First candidate",
    value: "candidate-value",
    confidence: 0.6,
    evidence: [{ path: "metadata.path" }],
  }],
  coverage: { metadata: true, text: false, objectGraph: false, limitations: ["Text was not inspected."] },
};

const artifact: ArtifactRecord = {
  id: "artifact_1", caseId: "case_1", runId: "run_1", sourceUrl: null,
  filename: "evidence.bin", relativePath: "downloads/evidence.bin", byteSize: 32,
  sha256: "a".repeat(64), detectedFormat: "structured-binary", mediaType: null,
  status: "analyzed", analyzerId: metadataAnalysis.analyzerId, analysis: metadataAnalysis,
  error: null, createdAt: "now", updatedAt: "now",
};

function attempt(id: string, analysis: ArtifactAnalysis): ArtifactAnalysisAttempt {
  return {
    id, caseId: artifact.caseId, runId: artifact.runId, artifactId: artifact.id,
    analyzerId: analysis.analyzerId, status: "succeeded",
    coverageDimensions: [], error: null, analysis, startedAt: id, finishedAt: `${id}-done`,
  };
}

describe("artifact analysis aggregation", () => {
  it("unions coverage from successful analyzer attempts without losing earlier work", () => {
    const textAnalysis: ArtifactAnalysis = {
      analyzerId: "text-analyzer", summary: "Text inspected.", findings: [],
      coverage: { metadata: false, text: true, objectGraph: false, limitations: [] },
    };
    const graphAnalysis: ArtifactAnalysis = {
      analyzerId: "graph-analyzer", summary: "Relationships inspected.", findings: [],
      coverage: { metadata: false, text: false, objectGraph: true, limitations: [] },
    };

    expect(aggregateArtifactAnalysis(artifact, [
      attempt("attempt_1", metadataAnalysis),
      attempt("attempt_2", textAnalysis),
      attempt("attempt_3", graphAnalysis),
    ])).toMatchObject({
      quality: "substantial",
      coveredDimensions: ["metadata", "text", "object_graph"],
      missingDimensions: [],
      analyzerIds: ["metadata-analyzer", "text-analyzer", "graph-analyzer"],
      followUpRequired: false,
      negativeConclusionSupported: false,
    });
  });

  it("deduplicates equivalent findings while retaining evidence and analyzer provenance", () => {
    const corroborating: ArtifactAnalysis = {
      analyzerId: "text-analyzer", summary: "Candidate corroborated.",
      findings: [{
        ...metadataAnalysis.findings[0],
        confidence: 0.9,
        evidence: [{ path: "text.path" }, { path: "metadata.path" }],
      }],
      coverage: { metadata: false, text: true, objectGraph: false, limitations: ["Graph was not inspected."] },
    };
    const result = aggregateArtifactAnalysis(artifact, [
      attempt("attempt_1", metadataAnalysis),
      attempt("attempt_2", corroborating),
    ]);

    expect(result.findings).toEqual([expect.objectContaining({
      label: "First candidate",
      confidence: 0.9,
      analyzerIds: ["metadata-analyzer", "text-analyzer"],
      attemptIds: ["attempt_1", "attempt_2"],
      evidence: [{ path: "metadata.path" }, { path: "text.path" }],
    })]);
    expect(result.limitations).toEqual([
      expect.objectContaining({ analyzerId: "metadata-analyzer", detail: "Text was not inspected." }),
      expect.objectContaining({ analyzerId: "text-analyzer", detail: "Graph was not inspected." }),
    ]);
  });

  it("uses the current artifact analysis for records created before attempt tracking", () => {
    expect(aggregateArtifactAnalysis(artifact, [])).toMatchObject({
      quality: "incomplete",
      coveredDimensions: ["metadata"],
      analyzerIds: ["metadata-analyzer"],
      attemptIds: [],
    });
  });

  it("ignores failed attempts as evidence", () => {
    const failed = { ...attempt("attempt_failed", metadataAnalysis), status: "failed" as const, analysis: null };
    const legacyFreeArtifact = { ...artifact, status: "failed" as const, analysis: null, analyzerId: null, error: "Analyzer failed." };
    expect(aggregateArtifactAnalysis(legacyFreeArtifact, [failed])).toMatchObject({
      quality: "unavailable",
      coveredDimensions: [],
      findings: [],
      limitations: [expect.objectContaining({ detail: "Analyzer failed." })],
    });
  });
});
