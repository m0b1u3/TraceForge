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

export const FactSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  type: z.enum([
    "target", "page", "js_file", "api_endpoint", "login_endpoint", "parameter",
    "credential", "token", "cookie", "session", "file_read", "source_code",
    "config_file", "heapdump", "finding", "ssh_service", "ssh_session",
    "database_connection", "sensitive_path", "note",
  ]),
  title: z.string(),
  value: z.unknown(),
  source: z.object({
    type: z.enum(["browser", "traffic", "js", "terminal", "file_read", "manual", "ai"]),
    ref: z.string(),
  }),
  confidence: z.number().default(1),
  tags: z.array(z.string()).default([]),
  createdAt: z.string(),
});
export type Fact = z.infer<typeof FactSchema>;

export const TaskSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  title: z.string(),
  status: z.enum([
    "open", "blocked", "recheck_candidate", "approved", "running",
    "done", "failed", "rejected", "out_of_scope",
  ]).default("open"),
  reason: z.string().default(""),
  blockedBy: z.array(z.string()).default([]),
  triggerWhen: z.array(z.string()).default([]),
  relatedFacts: z.array(z.string()).default([]),
  priority: z.enum(["low", "medium", "high"]).default("medium"),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Task = z.infer<typeof TaskSchema>;

export const TimelineEntrySchema = z.object({
  id: z.string(),
  caseId: z.string(),
  eventType: z.string(),
  refId: z.string().nullable().default(null),
  detail: z.string(),
  createdAt: z.string(),
});
export type TimelineEntry = z.infer<typeof TimelineEntrySchema>;

// 复用 FactSchema 的 type 枚举，避免重复定义
const FactType = FactSchema.shape.type;

export const CandidateFactSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  type: FactType,
  title: z.string(),
  value: z.unknown(),
  sourceRef: z.string(),
  reasoning: z.string(),
  confidence: z.number().default(0.5),
});
export type CandidateFact = z.infer<typeof CandidateFactSchema>;

export const ActionCardSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  title: z.string(),
  goal: z.string(),
  evidenceRefs: z.array(z.string()),
  hypothesisRefs: z.array(z.string()).default([]),
  taskRefs: z.array(z.string()).default([]),
  reasoning: z.string(),
  steps: z.array(z.string()),
  expectedResults: z.array(z.string()).default([]),
  riskNotes: z.array(z.string()).default([]),
  tool: z.enum(["browser", "traffic", "http_replay", "js_analyzer", "terminal", "artifact", "manual"]),
  priority: z.enum(["low", "medium", "high"]).default("medium"),
  requiresHumanApproval: z.boolean().default(true),
  status: z.enum(["proposed", "approved", "modified", "rejected", "running", "succeeded", "failed"]).default("proposed"),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ActionCard = z.infer<typeof ActionCardSchema>;

export const DecisionSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  decision: z.string(),
  basedOn: z.array(z.string()),
  reasoning: z.string(),
  actionRef: z.string().nullable().default(null),
  result: z.string().nullable().default(null),
  newFacts: z.array(z.string()).default([]),
  createdAt: z.string(),
});
export type Decision = z.infer<typeof DecisionSchema>;
