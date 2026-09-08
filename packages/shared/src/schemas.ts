import { z } from "zod";

export const ScopeRuleSchema = z.object({
  caseId: z.string(),
  allowHosts: z.array(z.string()),
  denyHosts: z.array(z.string()).default([]),
});
export type ScopeRule = z.infer<typeof ScopeRuleSchema>;

export const CaseSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(["active", "paused", "archived"]).default("active"),
  scopeRules: z.array(ScopeRuleSchema),
  createdAt: z.string(),
});
export type Case = z.infer<typeof CaseSchema>;

export const CaseSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(["active", "paused", "archived"]),
  target: z.string().nullable(),
  runStatus: z.enum(["idle", "running", "waiting", "failed", "completed"]),
  trafficCount: z.number().int().nonnegative(),
  findingCount: z.number().int().nonnegative(),
  severityCounts: z.object({ critical: z.number().int().nonnegative(), high: z.number().int().nonnegative(), medium: z.number().int().nonnegative(), low: z.number().int().nonnegative(), info: z.number().int().nonnegative() }),
  pendingApproval: z.boolean(),
  lastActivityAt: z.string(),
  createdAt: z.string(),
});
export type CaseSummary = z.infer<typeof CaseSummarySchema>;
