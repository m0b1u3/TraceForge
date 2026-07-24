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

export const IdentityContextSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  name: z.string().min(1),
  kind: z.enum(["guest", "user", "admin", "service", "custom"]),
  status: z.enum(["active", "expired", "revoked"]).default("active"),
  version: z.number().int().positive().default(1),
  credentials: z.record(z.unknown()).default({}),
  headers: z.record(z.string()).default({}),
  cookies: z.array(z.object({
    name: z.string(),
    value: z.string(),
    domain: z.string().optional(),
    path: z.string().optional(),
    url: z.string().optional(),
    expires: z.number().optional(),
    httpOnly: z.boolean().optional(),
    secure: z.boolean().optional(),
    sameSite: z.enum(["Strict", "Lax", "None"]).optional(),
  })).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type IdentityContext = z.infer<typeof IdentityContextSchema>;

export const AttackPathStepSchema = z.object({
  id: z.string(),
  order: z.number().int().nonnegative(),
  kind: z.enum(["access", "identity_transition", "request", "exploit", "privilege", "pivot", "impact"]),
  title: z.string().min(1),
  description: z.string().default(""),
  status: z.enum(["proposed", "observed", "verified", "blocked", "refuted"]).default("proposed"),
  identityId: z.string().nullable().default(null),
  trafficId: z.string().nullable().default(null),
  factIds: z.array(z.string()).default([]),
  taskId: z.string().nullable().default(null),
  actionId: z.string().nullable().default(null),
  prerequisiteStepIds: z.array(z.string()).default([]),
  validation: z.string().default(""),
});
export type AttackPathStep = z.infer<typeof AttackPathStepSchema>;

export const AttackPathSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  title: z.string().min(1),
  objective: z.string().min(1),
  status: z.enum(["exploring", "blocked", "validated", "invalidated"]).default("exploring"),
  confidence: z.number().min(0).max(1).default(0.5),
  sourceRunId: z.string().nullable().default(null),
  lastRunId: z.string().nullable().default(null),
  entryIdentityId: z.string().nullable().default(null),
  targetAssetFactId: z.string().nullable().default(null),
  findingFactIds: z.array(z.string()).default([]),
  hypothesisIds: z.array(z.string()).default([]),
  evidenceRefs: z.array(z.string()).default([]),
  breakpoint: z.string().nullable().default(null),
  steps: z.array(AttackPathStepSchema).min(1),
  version: z.number().int().positive().default(1),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AttackPath = z.infer<typeof AttackPathSchema>;

export const SecurityReportSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  title: z.string().min(1),
  status: z.enum(["draft", "final"]).default("draft"),
  executiveSummary: z.string().min(1),
  scope: z.string().default(""),
  methodology: z.string().default(""),
  limitations: z.array(z.string()).default([]),
  findingFactIds: z.array(z.string()).min(1),
  attackPathIds: z.array(z.string()).default([]),
  evidenceRefs: z.array(z.string()).min(1),
  sourceRunIds: z.array(z.string()).default([]),
  reviewStatus: z.enum(["current", "needs_review"]).default("current"),
  reviewReasons: z.array(z.string()).default([]),
  dependencyVersions: z.record(z.number().int().nonnegative()).default({}),
  version: z.number().int().positive().default(1),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SecurityReport = z.infer<typeof SecurityReportSchema>;

export const SecurityReportDiffSchema = z.object({
  changedFields: z.array(z.string()).default([]),
  addedFindingFactIds: z.array(z.string()).default([]),
  removedFindingFactIds: z.array(z.string()).default([]),
  addedAttackPathIds: z.array(z.string()).default([]),
  removedAttackPathIds: z.array(z.string()).default([]),
  addedEvidenceRefs: z.array(z.string()).default([]),
  removedEvidenceRefs: z.array(z.string()).default([]),
});
export type SecurityReportDiff = z.infer<typeof SecurityReportDiffSchema>;

export const SecurityReportRevisionSchema = z.object({
  id: z.string(),
  reportId: z.string(),
  caseId: z.string(),
  version: z.number().int().positive(),
  changeType: z.enum(["created", "content_updated", "dependency_changed"]),
  snapshot: SecurityReportSchema,
  diff: SecurityReportDiffSchema,
  reviewDecision: z.enum(["pending", "accepted"]).default("pending"),
  reviewedAt: z.string().nullable().default(null),
  createdAt: z.string(),
});
export type SecurityReportRevision = z.infer<typeof SecurityReportRevisionSchema>;

export const TrafficEntrySchema = z.object({
  id: z.string(),
  caseId: z.string(),
  runId: z.string().nullable().optional(),
  identityId: z.string().nullable().optional(),
  identityVersion: z.number().int().positive().nullable().optional(),
  attributionSource: z.enum(["browser", "http_replay", "manual", "agent"]).nullable().optional(),
  parentTrafficId: z.string().nullable().optional(),
  url: z.string(),
  method: z.string(),
  requestHeaders: z.record(z.string()).default({}),
  requestBody: z.string().nullable().default(null),
  responseStatus: z.number().nullable().default(null),
  responseHeaders: z.record(z.string()).optional(),
  responseSize: z.number().int().nonnegative().nullable().optional(),
  contentType: z.string().nullable().optional(),
  responseBody: z.string().nullable().default(null),
  createdAt: z.string(),
});
export type TrafficEntry = z.infer<typeof TrafficEntrySchema>;

// 常见事实类型——仅作 LLM prompt 的参考提示，不是封闭集合。
// LLM 可自由表达枚举外的新类型（如 graphql_endpoint / jwt_secret / s3_bucket / websocket 等），
// 因为漏洞挖掘的事实类型是开放的，不应被 TS 写死限制。
export const COMMON_FACT_TYPES = [
  "target", "page", "js_file", "api_endpoint", "login_endpoint", "parameter",
  "credential", "token", "cookie", "session", "file_read", "source_code",
  "config_file", "heapdump", "finding", "ssh_service", "ssh_session",
  "database_connection", "sensitive_path", "note",
] as const;

// 常见事实来源通道——仅作参考提示，不是封闭集合（MCP/插件可引入新来源）。
export const COMMON_FACT_SOURCES = [
  "browser", "traffic", "js", "terminal", "file_read", "manual", "ai",
] as const;

export const FactSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  sourceRunId: z.string().nullable().optional(),
  // 开放字符串：非空即可，类型由 LLM 决定，TS 不限制可选值
  type: z.string().min(1),
  title: z.string(),
  value: z.unknown(),
  source: z.object({
    // 开放字符串：常见来源见 COMMON_FACT_SOURCES；MCP/插件接入的新来源（如 mcp_xxx、plugin_nuclei）
    // 可自由标注，无需改核心代码。
    type: z.string().min(1),
    ref: z.string(),
  }),
  confidence: z.number().default(1),
  tags: z.array(z.string()).default([]),
  createdAt: z.string(),
  updateCount: z.number().default(0),
  updatedAt: z.string().default(""),
  validity: z.enum(["valid", "conflicted", "superseded"]).default("valid"),
  findingStatus: z.enum(["candidate", "validating", "verified", "needs_review", "rejected", "stale"]).nullable().optional(),
  evidenceRefs: z.array(z.string()).optional(),
  hypothesisIds: z.array(z.string()).optional(),
  taskIds: z.array(z.string()).optional(),
  actionIds: z.array(z.string()).optional(),
  verificationSummary: z.string().nullable().optional(),
  observations: z.array(z.object({
    id: z.string(),
    sourceType: z.string().min(1),
    sourceRef: z.string().min(1),
    runId: z.string().nullable().optional(),
    identityId: z.string().nullable().optional(),
    condition: z.string().default(""),
    summary: z.string(),
    observedAt: z.string(),
  })).optional(),
});
export type Fact = z.infer<typeof FactSchema>;

export const TaskSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  runId: z.string().nullable().optional(),
  title: z.string(),
  status: z.enum([
    "open", "blocked", "recheck_candidate", "approved", "running",
    "done", "failed", "rejected", "out_of_scope",
  ]).default("open"),
  reason: z.string().default(""),
  blockedBy: z.array(z.string()).default([]),
  triggerWhen: z.array(z.string()).default([]),
  relatedFacts: z.array(z.string()).default([]),
  hypothesisIds: z.array(z.string()).optional(),
  priority: z.enum(["low", "medium", "high"]).default("medium"),
  createdAt: z.string(),
  updatedAt: z.string(),
  updateCount: z.number().default(0),
});
export type Task = z.infer<typeof TaskSchema>;

export const TimelineEntrySchema = z.object({
  id: z.string(),
  caseId: z.string(),
  runId: z.string().nullable().optional(),
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

// 常见动作工具——仅作 LLM prompt 参考提示，不是封闭集合。
export const COMMON_ACTION_TOOLS = [
  "browser", "traffic", "http_replay", "js_analyzer", "terminal", "artifact", "manual",
] as const;

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
  // 开放字符串：常见工具见 COMMON_ACTION_TOOLS，但 LLM 可表达新工具，TS 不限制
  tool: z.string().min(1),
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

export const ObserverWarningSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  level: z.enum(["info", "warning", "critical"]),
  title: z.string(),
  description: z.string(),
  relatedFacts: z.array(z.string()).default([]),
  relatedTasks: z.array(z.string()).default([]),
  suggestedAction: z.string(),
  status: z.enum([
    "open", "accepted", "dismissed", "converted_to_task",
    "detected", "correcting", "resolved", "escalated",
  ]).default("open"),
  fingerprint: z.string().default(""),
  occurrenceCount: z.number().int().positive().default(1),
  lastObservedAt: z.string().default(""),
  escalationReason: z.string().nullable().default(null),
  relatedRunId: z.string().nullable().default(null),
  suggestedGoal: z.string().default(""),
  evidence: z.string().optional(),
  resolvedAt: z.string().nullable().default(null),
  createdAt: z.string(),
});
export type ObserverWarning = z.infer<typeof ObserverWarningSchema>;

export const AgentEventSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  kind: z.enum(["user", "started", "text", "reasoning", "tool_call", "tool_result", "validation", "done", "error"]),
  text: z.string(),
  tool: z.string().nullable().default(null),
  createdAt: z.string(),
});
export type AgentEvent = z.infer<typeof AgentEventSchema>;

export const SessionStateSchema = z.object({
  caseId: z.string(),
  runId: z.string().nullable().optional(),
  currentGoal: z.string().default(""),
  phase: z.enum(["scope", "discover", "map", "test", "validate", "chain", "report"]).default("discover"),
  focus: z.object({
    host: z.string().optional(),
    url: z.string().optional(),
    note: z.string().optional(),
  }).default({}),
  activeHypothesisIds: z.array(z.string()).default([]),
  updatedAt: z.string(),
});
export type SessionState = z.infer<typeof SessionStateSchema>;

export const HypothesisTransitionSchema = z.object({
  id: z.string(),
  kind: z.enum([
    "created", "promoted", "demoted", "scored", "confirmed", "refuted", "archived", "updated",
    "relationship_blocked", "relationship_unblocked",
  ]),
  fromStatus: z.enum(["candidate", "active", "confirmed", "refuted", "archived"]).nullable(),
  toStatus: z.enum(["candidate", "active", "confirmed", "refuted", "archived"]),
  previousScore: z.number().min(0).max(100).nullable(),
  nextScore: z.number().min(0).max(100).nullable(),
  reason: z.string().min(1),
  evidenceFactIds: z.array(z.string()).default([]),
  createdAt: z.string(),
});
export type HypothesisTransition = z.infer<typeof HypothesisTransitionSchema>;

export const HypothesisRelationsSchema = z.object({
  prerequisiteIds: z.array(z.string()).default([]),
  conflictIds: z.array(z.string()).default([]),
  supportIds: z.array(z.string()).default([]),
  derivedFromIds: z.array(z.string()).default([]),
}).default({});
export type HypothesisRelations = z.infer<typeof HypothesisRelationsSchema>;

export const HypothesisSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  runId: z.string().nullable().optional(),
  statement: z.string().min(1),
  status: z.enum(["candidate", "active", "confirmed", "refuted", "archived"]).default("candidate"),
  priorityScore: z.number().min(0).max(100).optional(),
  scoreFactors: z.object({
    impact: z.number().min(0).max(100),
    evidenceStrength: z.number().min(0).max(100),
    verificationCost: z.number().min(0).max(100),
    operationRisk: z.number().min(0).max(100),
    pathRelevance: z.number().min(0).max(100),
    freshness: z.number().min(0).max(100),
  }).optional(),
  basedOnFactIds: z.array(z.string()),
  relatedTaskIds: z.array(z.string()).default([]),
  relations: HypothesisRelationsSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  updateCount: z.number().default(0),
  auditTrail: z.array(HypothesisTransitionSchema).default([]),
});
export type Hypothesis = z.infer<typeof HypothesisSchema>;

export const ContextSummarySchema = z.object({
  id: z.string(),
  caseId: z.string(),
  coversUpToEventSeq: z.number(),
  content: z.string(),
  createdAt: z.string(),
});
export type ContextSummary = z.infer<typeof ContextSummarySchema>;

export const AgentRunStatusSchema = z.enum([
  "queued",
  "running",
  "interrupting",
  "interrupted",
  "needs_continuation",
  "completed",
  "failed",
]);
export type AgentRunStatus = z.infer<typeof AgentRunStatusSchema>;

export const AgentRunSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  goal: z.string(),
  status: AgentRunStatusSchema,
  createdAt: z.string(),
  startedAt: z.string().nullable().default(null),
  finishedAt: z.string().nullable().default(null),
  interruptReason: z.string().nullable().default(null),
  completionReason: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
  promptTokens: z.number().default(0),
  completionTokens: z.number().default(0),
  totalTokens: z.number().default(0),
});
export type AgentRun = z.infer<typeof AgentRunSchema>;

export const AgentRunUsageSchema = z.object({
  id: z.string(),
  runId: z.string(),
  caseId: z.string(),
  turn: z.number().int().positive(),
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  source: z.enum(["agent", "observer"]).default("agent"),
  currency: z.string().regex(/^[A-Z]{3}$/).nullable().default(null),
  inputCostMicros: z.number().int().nonnegative().nullable().default(null),
  outputCostMicros: z.number().int().nonnegative().nullable().default(null),
  totalCostMicros: z.number().int().nonnegative().nullable().default(null),
  createdAt: z.string(),
});
export type AgentRunUsage = z.infer<typeof AgentRunUsageSchema>;
