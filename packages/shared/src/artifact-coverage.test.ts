import { describe, expect, it } from "vitest";
import type { ArtifactRecord } from "./artifact.js";
import { assessArtifactCoverage } from "./artifact-coverage.js";

function artifact(patch: Partial<ArtifactRecord> = {}): ArtifactRecord {
  return {
    id: "artifact_1",
    caseId: "case_1",
    runId: "run_1",
    sourceUrl: null,
    filename: "evidence.bin",
    relativePath: "downloads/evidence.bin",
    byteSize: 32,
    sha256: "a".repeat(64),
    detectedFormat: "structured-binary",
    mediaType: "application/octet-stream",
    status: "analyzed",
    analyzerId: "structured-analyzer",
    analysis: {
      analyzerId: "structured-analyzer",
      summary: "Analysis completed.",
      findings: [],
      coverage: { metadata: true, text: false, objectGraph: true, limitations: ["Text layer was not inspected."] },
    },
    error: null,
    createdAt: "now",
    updatedAt: "now",
    ...patch,
  };
}

describe("artifact coverage assessment", () => {
  it("keeps a partial no-match result unresolved without inventing a negative conclusion", () => {
    expect(assessArtifactCoverage(artifact())).toEqual(expect.objectContaining({
      quality: "incomplete",
      coveredDimensions: ["metadata", "object_graph"],
      missingDimensions: ["text"],
      followUpRequired: true,
      negativeConclusionSupported: false,
    }));
  });

  it("distinguishes substantial coverage from unavailable analysis", () => {
    expect(assessArtifactCoverage(artifact({
      analysis: {
        analyzerId: "structured-analyzer",
        summary: "All declared layers inspected.",
        findings: [],
        coverage: { metadata: true, text: true, objectGraph: true, limitations: [] },
      },
    }))).toMatchObject({ quality: "substantial", followUpRequired: false });

    expect(assessArtifactCoverage(artifact({
      status: "failed",
      analysis: null,
      error: "Analyzer process exited.",
    }))).toMatchObject({
      quality: "unavailable",
      limitations: ["Analyzer process exited."],
      followUpRequired: true,
    });
  });
});
