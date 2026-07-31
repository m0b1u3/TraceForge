import { z } from "zod";

export const ArtifactEvidenceSchema = z.object({
  objectId: z.string().optional(),
  path: z.string().optional(),
  relationship: z.string().optional(),
  detail: z.string().optional(),
});
export type ArtifactEvidence = z.infer<typeof ArtifactEvidenceSchema>;

export const ArtifactFindingSchema = z.object({
  kind: z.enum(["credential", "secret", "configuration", "identifier", "relationship", "metadata", "other"]),
  label: z.string(),
  value: z.string(),
  confidence: z.number().min(0).max(1),
  sensitive: z.boolean().optional(),
  evidence: z.array(ArtifactEvidenceSchema),
});
export type ArtifactFinding = z.infer<typeof ArtifactFindingSchema>;

export const ArtifactAnalysisSchema = z.object({
  analyzerId: z.string(),
  summary: z.string(),
  findings: z.array(ArtifactFindingSchema),
  coverage: z.object({
    metadata: z.boolean(),
    text: z.boolean(),
    objectGraph: z.boolean(),
    limitations: z.array(z.string()),
  }),
});
export type ArtifactAnalysis = z.infer<typeof ArtifactAnalysisSchema>;

export const ArtifactRecordSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  runId: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  filename: z.string(),
  relativePath: z.string(),
  byteSize: z.number().int().nonnegative(),
  sha256: z.string(),
  detectedFormat: z.string(),
  mediaType: z.string().nullable(),
  status: z.enum(["downloaded", "analyzing", "analyzed", "unsupported", "failed"]),
  analyzerId: z.string().nullable(),
  analysis: ArtifactAnalysisSchema.nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ArtifactRecord = z.infer<typeof ArtifactRecordSchema>;
export type ArtifactStatus = ArtifactRecord["status"];
