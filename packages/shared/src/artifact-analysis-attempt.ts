import { z } from "zod";

export const ArtifactAnalyzerCapabilitySchema = z.object({
  analyzerId: z.string(),
  compatible: z.boolean(),
  coverageDimensions: z.array(z.enum(["metadata", "text", "object_graph"])),
  description: z.string(),
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
  error: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type ArtifactAnalysisAttempt = z.infer<typeof ArtifactAnalysisAttemptSchema>;
