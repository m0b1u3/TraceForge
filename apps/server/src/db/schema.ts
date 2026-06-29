import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const cases = sqliteTable("cases", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  status: text("status").notNull(),
  scopeRulesJson: text("scope_rules_json").notNull(),
  createdAt: text("created_at").notNull(),
});

export const trafficEntries = sqliteTable("traffic_entries", {
  id: text("id").primaryKey(),
  caseId: text("case_id").notNull(),
  url: text("url").notNull(),
  method: text("method").notNull(),
  requestHeadersJson: text("request_headers_json").notNull(),
  responseStatus: integer("response_status"),
  responseBody: text("response_body"),
  createdAt: text("created_at").notNull(),
});

export const facts = sqliteTable("facts", {
  id: text("id").primaryKey(),
  caseId: text("case_id").notNull(),
  type: text("type").notNull(),
  title: text("title").notNull(),
  valueJson: text("value_json").notNull(),
  sourceJson: text("source_json").notNull(),
  confidence: integer("confidence", { mode: "number" }).notNull(),
  tagsJson: text("tags_json").notNull(),
  createdAt: text("created_at").notNull(),
  updateCount: integer("update_count", { mode: "number" }).notNull().default(0),
  updatedAt: text("updated_at").notNull().default(""),
  validity: text("validity").notNull().default("valid"),
});

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  caseId: text("case_id").notNull(),
  title: text("title").notNull(),
  status: text("status").notNull(),
  reason: text("reason").notNull(),
  blockedByJson: text("blocked_by_json").notNull(),
  triggerWhenJson: text("trigger_when_json").notNull(),
  relatedFactsJson: text("related_facts_json").notNull(),
  priority: text("priority").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  updateCount: integer("update_count", { mode: "number" }).notNull().default(0),
});

export const timeline = sqliteTable("timeline", {
  id: text("id").primaryKey(),
  caseId: text("case_id").notNull(),
  eventType: text("event_type").notNull(),
  refId: text("ref_id"),
  detail: text("detail").notNull(),
  createdAt: text("created_at").notNull(),
});

export const actionCards = sqliteTable("action_cards", {
  id: text("id").primaryKey(),
  caseId: text("case_id").notNull(),
  title: text("title").notNull(),
  goal: text("goal").notNull(),
  evidenceRefsJson: text("evidence_refs_json").notNull(),
  hypothesisRefsJson: text("hypothesis_refs_json").notNull(),
  taskRefsJson: text("task_refs_json").notNull(),
  reasoning: text("reasoning").notNull(),
  stepsJson: text("steps_json").notNull(),
  expectedResultsJson: text("expected_results_json").notNull(),
  riskNotesJson: text("risk_notes_json").notNull(),
  tool: text("tool").notNull(),
  priority: text("priority").notNull(),
  requiresHumanApproval: integer("requires_human_approval").notNull(),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const decisions = sqliteTable("decisions", {
  id: text("id").primaryKey(),
  caseId: text("case_id").notNull(),
  decision: text("decision").notNull(),
  basedOnJson: text("based_on_json").notNull(),
  reasoning: text("reasoning").notNull(),
  actionRef: text("action_ref"),
  result: text("result"),
  newFactsJson: text("new_facts_json").notNull(),
  createdAt: text("created_at").notNull(),
});

export const agentEvents = sqliteTable("agent_events", {
  seq: integer("seq").primaryKey({ autoIncrement: true }),
  id: text("id").notNull(),
  caseId: text("case_id").notNull(),
  kind: text("kind").notNull(),
  text: text("text").notNull(),
  tool: text("tool"),
  createdAt: text("created_at").notNull(),
});

export const observerWarnings = sqliteTable("observer_warnings", {
  id: text("id").primaryKey(),
  caseId: text("case_id").notNull(),
  level: text("level").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  relatedFactsJson: text("related_facts_json").notNull(),
  relatedTasksJson: text("related_tasks_json").notNull(),
  suggestedAction: text("suggested_action").notNull(),
  createdAt: text("created_at").notNull(),
});

export const sessionState = sqliteTable("session_state", {
  caseId: text("case_id").primaryKey(),
  currentGoal: text("current_goal").notNull(),
  phase: text("phase").notNull(),
  focusJson: text("focus_json").notNull(),
  activeHypothesisIdsJson: text("active_hypothesis_ids_json").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const hypotheses = sqliteTable("hypotheses", {
  id: text("id").primaryKey(),
  caseId: text("case_id").notNull(),
  statement: text("statement").notNull(),
  status: text("status").notNull(),
  basedOnFactIdsJson: text("based_on_fact_ids_json").notNull(),
  relatedTaskIdsJson: text("related_task_ids_json").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  updateCount: integer("update_count").notNull(),
});

export const contextSummaries = sqliteTable("context_summaries", {
  seq: integer("seq").primaryKey({ autoIncrement: true }),
  id: text("id").notNull(),
  caseId: text("case_id").notNull(),
  coversUpToEventSeq: integer("covers_up_to_event_seq").notNull(),
  content: text("content").notNull(),
  createdAt: text("created_at").notNull(),
});
