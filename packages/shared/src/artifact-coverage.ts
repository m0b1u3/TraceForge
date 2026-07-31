import { z } from "zod";
import type { ArtifactRecord } from "./artifact.js";

const ArtifactCoverageDimensionSchema = z.enum(["metadata", "text", "object_graph"]);

export const ArtifactCoverageAssessmentSchema = z.object({
  artifactId: z.string(),
  quality: z.enum(["pending", "incomplete", "substantial", "unavailable"]),
  coveredDimensions: z.array(ArtifactCoverageDimensionSchema),
  missingDimensions: z.array(ArtifactCoverageDimensionSchema),
  limitations: z.array(z.string()),
  findingCount: z.number().int().nonnegative(),
  followUpRequired: z.boolean(),
  negativeConclusionSupported: z.boolean(),
  nextAction: z.string(),
});

export type ArtifactCoverageAssessment = z.infer<typeof ArtifactCoverageAssessmentSchema>;

export function assessArtifactCoverage(artifact: ArtifactRecord): ArtifactCoverageAssessment {
  const base = {
    artifactId: artifact.id,
    coveredDimensions: [] as ArtifactCoverageAssessment["coveredDimensions"],
    missingDimensions: [] as ArtifactCoverageAssessment["missingDimensions"],
    limitations: [] as string[],
    findingCount: artifact.analysis?.findings.length ?? 0,
    negativeConclusionSupported: false,
  };
  if (artifact.status === "downloaded") {
    return {
      ...base,
      quality: "pending",
      followUpRequired: true,
      nextAction: "Run a compatible structured analyzer before drawing content conclusions.",
    };
  }
  if (artifact.status === "analyzing") {
    return {
      ...base,
      quality: "pending",
      followUpRequired: false,
      nextAction: "Wait for the active analysis to finish.",
    };
  }
  if (artifact.status === "unsupported" || artifact.status === "failed" || !artifact.analysis) {
    return {
      ...base,
      quality: "unavailable",
      limitations: artifact.error ? [artifact.error] : ["No compatible analysis result is available."],
      followUpRequired: true,
      nextAction: artifact.status === "failed"
        ? "Resolve the analyzer failure or use another compatible analysis method."
        : "Use a compatible analyzer or record the unresolved analysis limitation.",
    };
  }

  const coverage = artifact.analysis.coverage;
  const coveredDimensions: ArtifactCoverageAssessment["coveredDimensions"] = [];
  const missingDimensions: ArtifactCoverageAssessment["missingDimensions"] = [];
  for (const [dimension, covered] of [
    ["metadata", coverage.metadata],
    ["text", coverage.text],
    ["object_graph", coverage.objectGraph],
  ] as const) {
    (covered ? coveredDimensions : missingDimensions).push(dimension);
  }
  const incomplete = missingDimensions.length > 0 || coverage.limitations.length > 0;
  return {
    ...base,
    quality: incomplete ? "incomplete" : "substantial",
    coveredDimensions,
    missingDimensions,
    limitations: coverage.limitations,
    followUpRequired: incomplete,
    nextAction: incomplete
      ? "Address the missing coverage with another compatible method or retain the limitation in the Task conclusion."
      : "Review the recovered evidence in the current Task.",
  };
}
