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

export const TrafficEntrySchema = z.object({
  id: z.string(),
  caseId: z.string(),
  url: z.string(),
  method: z.string(),
  requestHeaders: z.record(z.string()).default({}),
  responseStatus: z.number().nullable().default(null),
  responseBody: z.string().nullable().default(null),
  createdAt: z.string(),
});
export type TrafficEntry = z.infer<typeof TrafficEntrySchema>;
