import { z } from "zod";

export const ArtifactConsumptionSchema = z.object({
  caseId: z.string(),
  runId: z.string().nullable(),
  artifactId: z.string(),
  taskId: z.string(),
  factIds: z.array(z.string()),
  status: z.enum(["pending", "consumed", "replan_requested", "closed"]),
  usedByTool: z.string().nullable(),
  missedActions: z.number().int().nonnegative(),
  updatedAt: z.string(),
  lastEventId: z.string(),
});

export type ArtifactConsumption = z.infer<typeof ArtifactConsumptionSchema>;
