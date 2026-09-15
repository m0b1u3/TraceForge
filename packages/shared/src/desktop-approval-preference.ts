import { z } from "zod";

export const ApprovalPreferenceSchema = z.object({
  revision: z.number().int().nonnegative().safe(),
  routineApprovalRequired: z.boolean(),
}).strict();
export const ApprovalPreferenceUpdateSchema = z.object({
  expectedRevision: z.number().int().nonnegative().safe(),
  routineApprovalRequired: z.boolean(),
}).strict();
