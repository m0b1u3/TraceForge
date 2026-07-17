import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

export function createDb(path: string) {
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS cases (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL,
      scope_rules_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS traffic_entries (
      id TEXT PRIMARY KEY, case_id TEXT NOT NULL, url TEXT NOT NULL, method TEXT NOT NULL,
      request_headers_json TEXT NOT NULL, request_body TEXT, response_status INTEGER,
      response_headers_json TEXT, response_size INTEGER, content_type TEXT, response_body TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_traffic_case ON traffic_entries(case_id);
    CREATE TABLE IF NOT EXISTS facts (
      id TEXT PRIMARY KEY, case_id TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL,
      value_json TEXT NOT NULL, source_json TEXT NOT NULL, confidence REAL NOT NULL,
      tags_json TEXT NOT NULL, created_at TEXT NOT NULL,
      update_count INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT '', validity TEXT NOT NULL DEFAULT 'valid'
    );
    CREATE INDEX IF NOT EXISTS idx_facts_case ON facts(case_id);
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, case_id TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL,
      reason TEXT NOT NULL, blocked_by_json TEXT NOT NULL, trigger_when_json TEXT NOT NULL,
      related_facts_json TEXT NOT NULL, priority TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      update_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_case ON tasks(case_id);
    CREATE TABLE IF NOT EXISTS timeline (
      id TEXT PRIMARY KEY, case_id TEXT NOT NULL, event_type TEXT NOT NULL,
      ref_id TEXT, detail TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_timeline_case ON timeline(case_id);
    CREATE TABLE IF NOT EXISTS action_cards (
      id TEXT PRIMARY KEY, case_id TEXT NOT NULL, title TEXT NOT NULL, goal TEXT NOT NULL,
      evidence_refs_json TEXT NOT NULL, hypothesis_refs_json TEXT NOT NULL, task_refs_json TEXT NOT NULL,
      reasoning TEXT NOT NULL, steps_json TEXT NOT NULL, expected_results_json TEXT NOT NULL,
      risk_notes_json TEXT NOT NULL, tool TEXT NOT NULL, priority TEXT NOT NULL,
      requires_human_approval INTEGER NOT NULL, status TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_actions_case ON action_cards(case_id);
    CREATE TABLE IF NOT EXISTS decisions (
      id TEXT PRIMARY KEY, case_id TEXT NOT NULL, decision TEXT NOT NULL,
      based_on_json TEXT NOT NULL, reasoning TEXT NOT NULL, action_ref TEXT, result TEXT,
      new_facts_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_decisions_case ON decisions(case_id);
    CREATE TABLE IF NOT EXISTS observer_warnings (
      id TEXT PRIMARY KEY, case_id TEXT NOT NULL, level TEXT NOT NULL,
      title TEXT NOT NULL, description TEXT NOT NULL,
      related_facts_json TEXT NOT NULL, related_tasks_json TEXT NOT NULL,
      suggested_action TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
      related_run_id TEXT, suggested_goal TEXT NOT NULL DEFAULT '',
      evidence TEXT, resolved_at TEXT, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_warnings_case ON observer_warnings(case_id);
    CREATE TABLE IF NOT EXISTS agent_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL, case_id TEXT NOT NULL, kind TEXT NOT NULL,
      text TEXT NOT NULL, tool TEXT, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_events_case ON agent_events(case_id);
    CREATE TABLE IF NOT EXISTS session_state (
      case_id TEXT PRIMARY KEY,
      current_goal TEXT NOT NULL, phase TEXT NOT NULL,
      focus_json TEXT NOT NULL, active_hypothesis_ids_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS hypotheses (
      id TEXT PRIMARY KEY, case_id TEXT NOT NULL, statement TEXT NOT NULL,
      status TEXT NOT NULL, based_on_fact_ids_json TEXT NOT NULL,
      related_task_ids_json TEXT NOT NULL, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, update_count INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_hypotheses_case ON hypotheses(case_id);
    CREATE TABLE IF NOT EXISTS context_summaries (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL, case_id TEXT NOT NULL,
      covers_up_to_event_seq INTEGER NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_context_summaries_case ON context_summaries(case_id);
    CREATE TABLE IF NOT EXISTS agent_runs (
      id TEXT PRIMARY KEY, case_id TEXT NOT NULL, goal TEXT NOT NULL, status TEXT NOT NULL,
      created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
      interrupt_reason TEXT, completion_reason TEXT, error TEXT,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_agent_runs_case ON agent_runs(case_id, created_at);
    CREATE TABLE IF NOT EXISTS agent_run_usage (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, case_id TEXT NOT NULL, turn INTEGER NOT NULL,
      prompt_tokens INTEGER NOT NULL, completion_tokens INTEGER NOT NULL,
      total_tokens INTEGER NOT NULL, currency TEXT,
      input_cost_micros INTEGER, output_cost_micros INTEGER, total_cost_micros INTEGER,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_run_usage_turn ON agent_run_usage(run_id, turn);
    CREATE INDEX IF NOT EXISTS idx_agent_run_usage_case ON agent_run_usage(case_id);
  `);
  const warningColumns = sqlite.prepare("PRAGMA table_info(observer_warnings)").all() as Array<{ name: string }>;
  const hasWarningColumn = (name: string) => warningColumns.some((column) => column.name === name);
  if (!hasWarningColumn("status")) sqlite.exec("ALTER TABLE observer_warnings ADD COLUMN status TEXT NOT NULL DEFAULT 'open'");
  if (!hasWarningColumn("related_run_id")) sqlite.exec("ALTER TABLE observer_warnings ADD COLUMN related_run_id TEXT");
  if (!hasWarningColumn("suggested_goal")) sqlite.exec("ALTER TABLE observer_warnings ADD COLUMN suggested_goal TEXT NOT NULL DEFAULT ''");
  if (!hasWarningColumn("evidence")) sqlite.exec("ALTER TABLE observer_warnings ADD COLUMN evidence TEXT");
  if (!hasWarningColumn("resolved_at")) sqlite.exec("ALTER TABLE observer_warnings ADD COLUMN resolved_at TEXT");
  const trafficColumns = sqlite.prepare("PRAGMA table_info(traffic_entries)").all() as Array<{ name: string }>;
  if (!trafficColumns.some((c) => c.name === "request_body")) sqlite.exec("ALTER TABLE traffic_entries ADD COLUMN request_body TEXT");
  if (!trafficColumns.some((c) => c.name === "response_headers_json")) sqlite.exec("ALTER TABLE traffic_entries ADD COLUMN response_headers_json TEXT");
  if (!trafficColumns.some((c) => c.name === "response_size")) sqlite.exec("ALTER TABLE traffic_entries ADD COLUMN response_size INTEGER");
  if (!trafficColumns.some((c) => c.name === "content_type")) sqlite.exec("ALTER TABLE traffic_entries ADD COLUMN content_type TEXT");
  const usageColumns = sqlite.prepare("PRAGMA table_info(agent_run_usage)").all() as Array<{ name: string }>;
  const hasUsageColumn = (name: string) => usageColumns.some((column) => column.name === name);
  if (!hasUsageColumn("currency")) sqlite.exec("ALTER TABLE agent_run_usage ADD COLUMN currency TEXT");
  if (!hasUsageColumn("input_cost_micros")) sqlite.exec("ALTER TABLE agent_run_usage ADD COLUMN input_cost_micros INTEGER");
  if (!hasUsageColumn("output_cost_micros")) sqlite.exec("ALTER TABLE agent_run_usage ADD COLUMN output_cost_micros INTEGER");
  if (!hasUsageColumn("total_cost_micros")) sqlite.exec("ALTER TABLE agent_run_usage ADD COLUMN total_cost_micros INTEGER");
  return drizzle(sqlite);
}

export type Db = ReturnType<typeof createDb>;
