import { z } from "zod";

export const ArtifactRetryAuthorizationSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  runId: z.string().nullable(),
  artifactId: z.string(),
  analyzerId: z.string(),
  failedAttemptId: z.string(),
  preflightFingerprint: z.string(),
  reason: z.string().min(1),
  status: z.enum(["authorized", "consumed", "revoked"]),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ArtifactRetryAuthorization = z.infer<typeof ArtifactRetryAuthorizationSchema>;
