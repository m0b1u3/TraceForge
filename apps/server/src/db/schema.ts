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
