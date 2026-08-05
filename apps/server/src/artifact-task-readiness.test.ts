import { describe, expect, it } from "vitest";
import { ArtifactAnalysisAttemptSchema, ArtifactRecordSchema, FactSchema, TaskSchema } from "@traceforge/shared";
import { evaluateArtifactTaskReadiness } from "./artifact-task-readiness.js";

const now = "2026-08-05T00:00:00.000Z";
const artifact = ArtifactRecordSchema.parse({
  id: "artifact_1", caseId: "case_1", runId: "run_1", sourceUrl: null,
  filename: "evidence.bin", relativePath: "downloads/evidence.bin", byteSize: 32,
  sha256: "a".repeat(64), detectedFormat: "structured-binary", mediaType: null,
  status: "analyzed", analyzerId: "metadata-analyzer",
  analysis: {
    analyzerId: "metadata-analyzer", summary: "Metadata inspected.", findings: [],
    coverage: { metadata: true, text: false, objectGraph: false, limitations: [] },
  },
  error: null, createdAt: now, updatedAt: now,
});
const analysisFact = FactSchema.parse({
  id: "fact_analysis", caseId: "case_1", type: "artifact_analysis", title: "Artifact analyzed",
  value: { artifactId: artifact.id }, source: { type: "artifact_analysis", ref: artifact.id },
  confidence: 1, tags: [], createdAt: now,
});
const task = TaskSchema.parse({
  id: "task_1", caseId: "case_1", runId: "run_1", title: "Inspect acquired evidence",
  status: "running", relatedFacts: [analysisFact.id], hypothesisIds: ["hypothesis_1"], createdAt: now, updatedAt: now,
});
const metadataAttempt = ArtifactAnalysisAttemptSchema.parse({
  id: "attempt_1", caseId: "case_1", runId: "run_1", artifactId: artifact.id,
  analyzerId: "metadata-analyzer", status: "succeeded", coverageDimensions: ["metadata"],
  error: null, analysis: artifact.analysis, startedAt: now, finishedAt: now,
});

describe("artifact-linked Task readiness", () => {
  it("blocks closure when a linked artifact has unresolved cumulative coverage and no positive evidence", () => {
    const result = evaluateArtifactTaskReadiness({ task, facts: [analysisFact], artifacts: [artifact], attempts: [metadataAttempt] });
    expect(result.allowed).toBe(false);
    expect(result.missing).toEqual([expect.stringContaining("text, object_graph")]);
  });

  it("allows a positive conclusion backed by traceable recovered evidence without requiring unrelated coverage", () => {
    const evidence = FactSchema.parse({
      id: "fact_evidence", caseId: "case_1", type: "artifact_evidence", title: "Recovered candidate",
      value: { artifactId: artifact.id, value: "candidate-value" }, source: { type: "artifact_analysis", ref: artifact.id },
      confidence: 0.9, tags: [], validity: "valid", verificationSummary: "Recovered with a source relationship.",
      observations: [{ id: "obs_1", sourceType: "artifact_analysis", sourceRef: artifact.id, summary: "relationship observed", observedAt: now }],
      createdAt: now,
    });
    const result = evaluateArtifactTaskReadiness({
      task: { ...task, relatedFacts: [analysisFact.id, evidence.id] },
      facts: [analysisFact, evidence], artifacts: [artifact], attempts: [metadataAttempt],
    });
    expect(result).toMatchObject({ allowed: true, missing: [] });
    expect(result.artifacts[0]?.hasTraceablePositiveEvidence).toBe(true);
  });

  it("allows closure after multiple attempts cumulatively cover every analysis dimension", () => {
    const second = ArtifactAnalysisAttemptSchema.parse({
      ...metadataAttempt, id: "attempt_2", analyzerId: "content-analyzer", coverageDimensions: ["text", "object_graph"],
      analysis: {
        analyzerId: "content-analyzer", summary: "Content relationships inspected.", findings: [],
        coverage: { metadata: false, text: true, objectGraph: true, limitations: [] },
      },
    });
    expect(evaluateArtifactTaskReadiness({
      task, facts: [analysisFact], artifacts: [artifact], attempts: [metadataAttempt, second],
    })).toMatchObject({ allowed: true, missing: [], artifacts: [{ quality: "substantial" }] });
  });

  it("does not constrain Tasks that are not linked to artifact evidence", () => {
    expect(evaluateArtifactTaskReadiness({
      task: { ...task, relatedFacts: [] }, facts: [analysisFact], artifacts: [artifact], attempts: [metadataAttempt],
    })).toEqual({ allowed: true, missing: [], artifacts: [] });
  });
});
