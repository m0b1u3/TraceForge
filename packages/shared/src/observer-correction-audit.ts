import { z } from "zod";

export const ObserverCorrectionAuditSchema = z.object({
  version: z.literal(1),
  attributed: z.boolean(),
  reason: z.enum([
    "correction_linked_result",
    "execution_recovered",
    "no_linked_result",
    "warning_reobserved",
    "no_novel_strategy",
    "no_tracked_correction",
  ]),
  trigger: z.string().nullable(),
  instruction: z.string(),
  actions: z.array(z.object({
    tool: z.string(),
    outcome: z.enum(["succeeded", "failed"]),
    evidenceRefs: z.array(z.string()),
  })).max(6),
  evidenceRefs: z.array(z.string()).max(12),
  summary: z.string(),
});

export type ObserverCorrectionAudit = z.infer<typeof ObserverCorrectionAuditSchema>;

export function serializeObserverCorrectionAudit(audit: ObserverCorrectionAudit): string {
  return JSON.stringify(ObserverCorrectionAuditSchema.parse(audit));
}

export function parseObserverCorrectionAudit(value: string | null | undefined): ObserverCorrectionAudit | null {
  if (!value?.trim().startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    const result = ObserverCorrectionAuditSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
