import { z } from "zod";

export const ArtifactRecoverySchema = z.object({
  id: z.string(),
  caseId: z.string(),
  runId: z.string().nullable(),
  taskId: z.string(),
  artifactId: z.string(),
  analyzerId: z.string(),
  failedAttemptId: z.string().nullable(),
  beforeFingerprint: z.string(),
  afterFingerprint: z.string().nullable(),
  instruction: z.string().min(1),
  result: z.string().nullable(),
  status: z.enum(["planned", "running", "succeeded", "failed", "cancelled"]),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ArtifactRecovery = z.infer<typeof ArtifactRecoverySchema>;
