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
  validity: z.enum(["valid", "superseded"]).default("valid"),
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
  updateCount: z.number().default(0),
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
  createdAt: z.string(),
});
export type ObserverWarning = z.infer<typeof ObserverWarningSchema>;
