import { z } from "zod";
import { ArtifactAnalysisSchema } from "./artifact.js";

export const ArtifactAnalyzerCapabilitySchema = z.object({
  analyzerId: z.string(),
  compatible: z.boolean(),
  coverageDimensions: z.array(z.enum(["metadata", "text", "object_graph"])),
  description: z.string(),
  availability: z.enum(["ready", "degraded", "unavailable"]).optional(),
  availabilityReason: z.string().optional(),
  recoveryHint: z.string().optional(),
  identity: z.string().optional(),
});
export type ArtifactAnalyzerCapability = z.infer<typeof ArtifactAnalyzerCapabilitySchema>;

export const ArtifactAnalysisAttemptSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  runId: z.string().nullable(),
  artifactId: z.string(),
  analyzerId: z.string().nullable(),
  status: z.enum(["running", "succeeded", "failed", "unsupported"]),
  coverageDimensions: z.array(z.enum(["metadata", "text", "object_graph"])),
  preflightFingerprint: z.string().nullable().optional(),
  preflightAvailability: z.enum(["ready", "degraded", "unavailable"]).nullable().optional(),
  preflightReason: z.string().nullable().optional(),
  error: z.string().nullable(),
  analysis: ArtifactAnalysisSchema.nullable().default(null),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type ArtifactAnalysisAttempt = z.infer<typeof ArtifactAnalysisAttemptSchema>;
