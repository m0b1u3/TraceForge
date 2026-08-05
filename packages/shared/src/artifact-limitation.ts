import { z } from "zod";

export const ArtifactLimitationDispositionSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  runId: z.string().nullable(),
  taskId: z.string(),
  artifactId: z.string(),
  status: z.enum(["accepted", "revoked"]),
  missingDimensions: z.array(z.enum(["metadata", "text", "object_graph"])),
  attemptIds: z.array(z.string()),
  rationale: z.string().min(1),
  prohibitedConclusion: z.literal("This limitation does not prove content absence and cannot verify or reject a security finding."),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ArtifactLimitationDisposition = z.infer<typeof ArtifactLimitationDispositionSchema>;
