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
    CREATE TABLE IF NOT EXISTS identity_contexts (
      id TEXT PRIMARY KEY, case_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
      status TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
      credentials_json TEXT NOT NULL DEFAULT '{}', headers_json TEXT NOT NULL DEFAULT '{}',
      cookies_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_identity_contexts_case ON identity_contexts(case_id);
    CREATE TABLE IF NOT EXISTS attack_paths (
      id TEXT PRIMARY KEY, case_id TEXT NOT NULL, title TEXT NOT NULL, objective TEXT NOT NULL,
      status TEXT NOT NULL, confidence REAL NOT NULL, source_run_id TEXT, last_run_id TEXT,
      entry_identity_id TEXT, target_asset_fact_id TEXT,
      finding_fact_ids_json TEXT NOT NULL DEFAULT '[]',
      hypothesis_ids_json TEXT NOT NULL DEFAULT '[]', evidence_refs_json TEXT NOT NULL DEFAULT '[]',
      breakpoint TEXT, steps_json TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_attack_paths_case ON attack_paths(case_id, updated_at);
    CREATE TABLE IF NOT EXISTS security_reports (
      id TEXT PRIMARY KEY, case_id TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL,
      executive_summary TEXT NOT NULL, scope TEXT NOT NULL, methodology TEXT NOT NULL,
      limitations_json TEXT NOT NULL DEFAULT '[]', finding_fact_ids_json TEXT NOT NULL,
      attack_path_ids_json TEXT NOT NULL DEFAULT '[]', evidence_refs_json TEXT NOT NULL,
      source_run_ids_json TEXT NOT NULL DEFAULT '[]', review_status TEXT NOT NULL DEFAULT 'current',
      review_reasons_json TEXT NOT NULL DEFAULT '[]', dependency_versions_json TEXT NOT NULL DEFAULT '{}',
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_security_reports_case ON security_reports(case_id, updated_at);
    CREATE TABLE IF NOT EXISTS security_report_revisions (
      id TEXT PRIMARY KEY, report_id TEXT NOT NULL, case_id TEXT NOT NULL, version INTEGER NOT NULL,
      change_type TEXT NOT NULL, snapshot_json TEXT NOT NULL, diff_json TEXT NOT NULL,
      review_decision TEXT NOT NULL DEFAULT 'pending', reviewed_at TEXT, created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_security_report_revisions_version ON security_report_revisions(report_id, version);
    CREATE INDEX IF NOT EXISTS idx_security_report_revisions_case ON security_report_revisions(case_id, created_at);
    CREATE TABLE IF NOT EXISTS traffic_entries (
      id TEXT PRIMARY KEY, case_id TEXT NOT NULL, url TEXT NOT NULL, method TEXT NOT NULL,
      run_id TEXT, identity_id TEXT, identity_version INTEGER, attribution_source TEXT, parent_traffic_id TEXT,
      request_headers_json TEXT NOT NULL, request_body TEXT, response_status INTEGER,
      response_headers_json TEXT, response_size INTEGER, content_type TEXT, response_body TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_traffic_case ON traffic_entries(case_id);
    CREATE TABLE IF NOT EXISTS facts (
      id TEXT PRIMARY KEY, case_id TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL,
      source_run_id TEXT,
      value_json TEXT NOT NULL, source_json TEXT NOT NULL, confidence REAL NOT NULL,
      tags_json TEXT NOT NULL, created_at TEXT NOT NULL,
      update_count INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT '', validity TEXT NOT NULL DEFAULT 'valid',
      finding_status TEXT, evidence_refs_json TEXT NOT NULL DEFAULT '[]',
      hypothesis_ids_json TEXT NOT NULL DEFAULT '[]', task_ids_json TEXT NOT NULL DEFAULT '[]',
      action_ids_json TEXT NOT NULL DEFAULT '[]', verification_summary TEXT,
      observations_json TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX IF NOT EXISTS idx_facts_case ON facts(case_id);
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, case_id TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL,
      run_id TEXT,
      reason TEXT NOT NULL, blocked_by_json TEXT NOT NULL, trigger_when_json TEXT NOT NULL,
      related_facts_json TEXT NOT NULL, hypothesis_ids_json TEXT NOT NULL DEFAULT '[]',
      relationship_gate_json TEXT NOT NULL DEFAULT 'null', priority TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      update_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_case ON tasks(case_id);
    CREATE TABLE IF NOT EXISTS timeline (
      id TEXT PRIMARY KEY, case_id TEXT NOT NULL, event_type TEXT NOT NULL,
      run_id TEXT, ref_id TEXT, detail TEXT NOT NULL, created_at TEXT NOT NULL
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
    CREATE TABLE IF NOT EXISTS knowledge_usage (
      id TEXT PRIMARY KEY, case_id TEXT NOT NULL, run_id TEXT NOT NULL,
      knowledge_id TEXT NOT NULL, knowledge_kind TEXT NOT NULL,
      injected_count INTEGER NOT NULL DEFAULT 0, used_count INTEGER NOT NULL DEFAULT 0,
      positive_outcome_score REAL NOT NULL DEFAULT 0,
      negative_outcome_score REAL NOT NULL DEFAULT 0,
      first_injected_at TEXT NOT NULL, last_injected_at TEXT NOT NULL, last_used_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_knowledge_usage_case ON knowledge_usage(case_id, knowledge_id);
    CREATE TABLE IF NOT EXISTS validation_conclusions (
      id TEXT PRIMARY KEY, case_id TEXT NOT NULL, run_id TEXT NOT NULL,
      finding_id TEXT NOT NULL, gap_id TEXT NOT NULL, verdict TEXT NOT NULL,
      confidence REAL NOT NULL, baseline_traffic_id TEXT NOT NULL,
      variant_traffic_id TEXT NOT NULL, confirmation_traffic_id TEXT,
      identity_id TEXT, assessment_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_validation_conclusions_case ON validation_conclusions(case_id, created_at);
    CREATE TABLE IF NOT EXISTS validation_consensus (
      finding_id TEXT PRIMARY KEY, case_id TEXT NOT NULL, status TEXT NOT NULL,
      independent_supports INTEGER NOT NULL, independent_refutes INTEGER NOT NULL,
      inconclusive_count INTEGER NOT NULL, duplicates_excluded INTEGER NOT NULL,
      confidence REAL NOT NULL, recommendation TEXT NOT NULL,
      result_json TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_validation_consensus_case ON validation_consensus(case_id, updated_at);
    CREATE TABLE IF NOT EXISTS observer_warnings (
      id TEXT PRIMARY KEY, case_id TEXT NOT NULL, level TEXT NOT NULL,
      title TEXT NOT NULL, description TEXT NOT NULL,
      related_facts_json TEXT NOT NULL, related_tasks_json TEXT NOT NULL,
      suggested_action TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
      fingerprint TEXT NOT NULL DEFAULT '',
      occurrence_count INTEGER NOT NULL DEFAULT 1,
      last_observed_at TEXT NOT NULL DEFAULT '',
      escalation_reason TEXT,
      related_run_id TEXT, suggested_goal TEXT NOT NULL DEFAULT '',
      evidence TEXT, resolved_at TEXT, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_warnings_case ON observer_warnings(case_id);
    CREATE TABLE IF NOT EXISTS agent_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL, case_id TEXT NOT NULL, kind TEXT NOT NULL,
      text TEXT NOT NULL, tool TEXT, refs_json TEXT, run_id TEXT, execution_id TEXT,
      outcome TEXT, recovered_by_execution_id TEXT, failure_diagnostic_json TEXT, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_events_case ON agent_events(case_id);
    CREATE TABLE IF NOT EXISTS hypotheses (
      id TEXT PRIMARY KEY, case_id TEXT NOT NULL, statement TEXT NOT NULL,
      run_id TEXT, status TEXT NOT NULL, priority_score INTEGER NOT NULL DEFAULT 50,
      score_factors_json TEXT NOT NULL DEFAULT '{}', based_on_fact_ids_json TEXT NOT NULL,
      related_task_ids_json TEXT NOT NULL, relations_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL,
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
    CREATE TABLE IF NOT EXISTS run_cognitive_state (
      run_id TEXT PRIMARY KEY, case_id TEXT NOT NULL,
      current_goal TEXT NOT NULL, phase TEXT NOT NULL,
      focus_json TEXT NOT NULL, active_hypothesis_ids_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_run_cognitive_state_case ON run_cognitive_state(case_id);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_case ON agent_runs(case_id, created_at);
    CREATE TABLE IF NOT EXISTS agent_run_usage (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, case_id TEXT NOT NULL, turn INTEGER NOT NULL,
      prompt_tokens INTEGER NOT NULL, completion_tokens INTEGER NOT NULL,
      total_tokens INTEGER NOT NULL, source TEXT NOT NULL DEFAULT 'agent', currency TEXT,
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
  if (!hasWarningColumn("fingerprint")) sqlite.exec("ALTER TABLE observer_warnings ADD COLUMN fingerprint TEXT NOT NULL DEFAULT ''");
  if (!hasWarningColumn("occurrence_count")) sqlite.exec("ALTER TABLE observer_warnings ADD COLUMN occurrence_count INTEGER NOT NULL DEFAULT 1");
  if (!hasWarningColumn("last_observed_at")) sqlite.exec("ALTER TABLE observer_warnings ADD COLUMN last_observed_at TEXT NOT NULL DEFAULT ''");
  if (!hasWarningColumn("escalation_reason")) sqlite.exec("ALTER TABLE observer_warnings ADD COLUMN escalation_reason TEXT");
  sqlite.exec("CREATE INDEX IF NOT EXISTS idx_warnings_fingerprint ON observer_warnings(case_id, fingerprint)");
  const trafficColumns = sqlite.prepare("PRAGMA table_info(traffic_entries)").all() as Array<{ name: string }>;
  if (!trafficColumns.some((c) => c.name === "request_body")) sqlite.exec("ALTER TABLE traffic_entries ADD COLUMN request_body TEXT");
  if (!trafficColumns.some((c) => c.name === "response_headers_json")) sqlite.exec("ALTER TABLE traffic_entries ADD COLUMN response_headers_json TEXT");
  if (!trafficColumns.some((c) => c.name === "response_size")) sqlite.exec("ALTER TABLE traffic_entries ADD COLUMN response_size INTEGER");
  if (!trafficColumns.some((c) => c.name === "content_type")) sqlite.exec("ALTER TABLE traffic_entries ADD COLUMN content_type TEXT");
  if (!trafficColumns.some((c) => c.name === "run_id")) sqlite.exec("ALTER TABLE traffic_entries ADD COLUMN run_id TEXT");
  if (!trafficColumns.some((c) => c.name === "identity_id")) sqlite.exec("ALTER TABLE traffic_entries ADD COLUMN identity_id TEXT");
  if (!trafficColumns.some((c) => c.name === "identity_version")) sqlite.exec("ALTER TABLE traffic_entries ADD COLUMN identity_version INTEGER");
  if (!trafficColumns.some((c) => c.name === "attribution_source")) sqlite.exec("ALTER TABLE traffic_entries ADD COLUMN attribution_source TEXT");
  if (!trafficColumns.some((c) => c.name === "parent_traffic_id")) sqlite.exec("ALTER TABLE traffic_entries ADD COLUMN parent_traffic_id TEXT");
  const ensureColumns = (table: string, columns: Array<{ name: string; definition: string }>) => {
    const existing = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    for (const column of columns) {
      if (!existing.some((item) => item.name === column.name)) sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column.name} ${column.definition}`);
    }
  };
  ensureColumns("knowledge_usage", [
    { name: "positive_outcome_score", definition: "REAL NOT NULL DEFAULT 0" },
    { name: "negative_outcome_score", definition: "REAL NOT NULL DEFAULT 0" },
  ]);
  ensureColumns("agent_events", [
    { name: "refs_json", definition: "TEXT" },
    { name: "run_id", definition: "TEXT" },
    { name: "execution_id", definition: "TEXT" },
    { name: "outcome", definition: "TEXT" },
    { name: "recovered_by_execution_id", definition: "TEXT" },
    { name: "failure_diagnostic_json", definition: "TEXT" },
  ]);
  sqlite.exec("CREATE INDEX IF NOT EXISTS idx_agent_events_execution ON agent_events(case_id, execution_id)");
  ensureColumns("facts", [
    { name: "source_run_id", definition: "TEXT" },
    { name: "finding_status", definition: "TEXT" },
    { name: "evidence_refs_json", definition: "TEXT NOT NULL DEFAULT '[]'" },
    { name: "hypothesis_ids_json", definition: "TEXT NOT NULL DEFAULT '[]'" },
    { name: "task_ids_json", definition: "TEXT NOT NULL DEFAULT '[]'" },
    { name: "action_ids_json", definition: "TEXT NOT NULL DEFAULT '[]'" },
    { name: "verification_summary", definition: "TEXT" },
    { name: "observations_json", definition: "TEXT NOT NULL DEFAULT '[]'" },
  ]);
  ensureColumns("security_reports", [
    { name: "review_status", definition: "TEXT NOT NULL DEFAULT 'current'" },
    { name: "review_reasons_json", definition: "TEXT NOT NULL DEFAULT '[]'" },
    { name: "dependency_versions_json", definition: "TEXT NOT NULL DEFAULT '{}'" },
  ]);
  ensureColumns("tasks", [
    { name: "run_id", definition: "TEXT" },
    { name: "hypothesis_ids_json", definition: "TEXT NOT NULL DEFAULT '[]'" },
    { name: "relationship_gate_json", definition: "TEXT NOT NULL DEFAULT 'null'" },
  ]);
  ensureColumns("timeline", [{ name: "run_id", definition: "TEXT" }]);
  ensureColumns("hypotheses", [
    { name: "run_id", definition: "TEXT" },
    { name: "priority_score", definition: "INTEGER NOT NULL DEFAULT 50" },
    { name: "score_factors_json", definition: "TEXT NOT NULL DEFAULT '{}'" },
    { name: "relations_json", definition: "TEXT NOT NULL DEFAULT '{}'" },
    { name: "audit_trail_json", definition: "TEXT NOT NULL DEFAULT '[]'" },
  ]);
  const usageColumns = sqlite.prepare("PRAGMA table_info(agent_run_usage)").all() as Array<{ name: string }>;
  const hasUsageColumn = (name: string) => usageColumns.some((column) => column.name === name);
  if (!hasUsageColumn("currency")) sqlite.exec("ALTER TABLE agent_run_usage ADD COLUMN currency TEXT");
  if (!hasUsageColumn("input_cost_micros")) sqlite.exec("ALTER TABLE agent_run_usage ADD COLUMN input_cost_micros INTEGER");
  if (!hasUsageColumn("output_cost_micros")) sqlite.exec("ALTER TABLE agent_run_usage ADD COLUMN output_cost_micros INTEGER");
  if (!hasUsageColumn("total_cost_micros")) sqlite.exec("ALTER TABLE agent_run_usage ADD COLUMN total_cost_micros INTEGER");
  if (!hasUsageColumn("source")) sqlite.exec("ALTER TABLE agent_run_usage ADD COLUMN source TEXT NOT NULL DEFAULT 'agent'");
  return drizzle(sqlite);
}

export type Db = ReturnType<typeof createDb>;
