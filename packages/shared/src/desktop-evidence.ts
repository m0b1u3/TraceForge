import { z } from "zod";

export const EVIDENCE_PAGE_BYTES = 65536;
export const EVIDENCE_MAX_BYTES = 4194304;
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const DesktopEvidenceReadSchema = z.object({
  runId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  ref: z.string().min(1).max(256),
  offset: z.number().int().min(0).max(EVIDENCE_MAX_BYTES),
  expectedDigest: digest.optional(),
}).strict();
export const DesktopEvidencePageSchema = z.object({
  runId: z.string(), ref: z.string().max(256), artifactId: z.string().max(256),
  summary: z.string().max(4096), kind: z.string().max(128),
  digest, byteSize: z.number().int().min(0).max(EVIDENCE_MAX_BYTES),
  format: z.enum(["text", "png", "binary"]),
  offset: z.number().int().min(0).max(EVIDENCE_MAX_BYTES),
  nextOffset: z.number().int().min(0).max(EVIDENCE_MAX_BYTES).nullable(),
  bodyBase64: z.string().max(87384),
}).strict();
export type DesktopEvidenceRead = z.infer<typeof DesktopEvidenceReadSchema>;
export type DesktopEvidencePage = z.infer<typeof DesktopEvidencePageSchema>;
