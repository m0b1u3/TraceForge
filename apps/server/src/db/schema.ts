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
});

export const timeline = sqliteTable("timeline", {
  id: text("id").primaryKey(),
  caseId: text("case_id").notNull(),
  eventType: text("event_type").notNull(),
  refId: text("ref_id"),
  detail: text("detail").notNull(),
  createdAt: text("created_at").notNull(),
});
