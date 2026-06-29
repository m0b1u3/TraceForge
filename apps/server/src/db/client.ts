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
      request_headers_json TEXT NOT NULL, response_status INTEGER, response_body TEXT,
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
      suggested_action TEXT NOT NULL, created_at TEXT NOT NULL
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
  `);
  return drizzle(sqlite);
}

export type Db = ReturnType<typeof createDb>;
