import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { applyDataMigrations } from "./data-migrations.js";

export function createDb(path: string) {
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  const scenarioStreamColumns = sqlite.prepare("PRAGMA table_info(scenario_event_streams)").all() as Array<{ name: string }>;
  if (scenarioStreamColumns.length > 0 && !scenarioStreamColumns.some((column) => column.name === "case_id")) {
    sqlite.exec(`
      DROP TABLE IF EXISTS scenario_work_leases;
      DROP TABLE IF EXISTS scenario_events;
      DROP TABLE IF EXISTS scenario_commands;
      DROP TABLE IF EXISTS scenario_event_streams;
      DROP TABLE IF EXISTS scenario_workers;
      DROP TABLE IF EXISTS scenario_authorizations;
    `);
  }
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
    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY, case_id TEXT NOT NULL, run_id TEXT, source_url TEXT,
      filename TEXT NOT NULL, relative_path TEXT NOT NULL, byte_size INTEGER NOT NULL,
      sha256 TEXT NOT NULL, detected_format TEXT NOT NULL, media_type TEXT,
      status TEXT NOT NULL, analyzer_id TEXT, analysis_json TEXT, error TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS scenario_event_streams (
      run_id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL,
      definition_kind TEXT NOT NULL,
      definition_version INTEGER NOT NULL,
      status TEXT NOT NULL,
      active_phase_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS scenario_commands (
      run_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      resulting_revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (run_id, command_id)
    );
    CREATE TABLE IF NOT EXISTS scenario_events (
      run_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      command_id TEXT NOT NULL,
      event_index INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (run_id, sequence),
      UNIQUE (run_id, command_id, event_index)
    );
    CREATE INDEX IF NOT EXISTS idx_scenario_events_command ON scenario_events(run_id, command_id, event_index);
    CREATE TABLE IF NOT EXISTS scenario_work_leases (
      run_id TEXT NOT NULL,
      work_id TEXT NOT NULL,
      worker_id TEXT NOT NULL,
      lease_id TEXT NOT NULL UNIQUE,
      lease_expires_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (run_id, work_id)
    );
    CREATE INDEX IF NOT EXISTS idx_scenario_work_leases_worker ON scenario_work_leases(worker_id);
    CREATE TABLE IF NOT EXISTS scenario_workers (
      id TEXT PRIMARY KEY,
      roles_json TEXT NOT NULL,
      capabilities_json TEXT NOT NULL,
      max_concurrent_work INTEGER NOT NULL,
      status TEXT NOT NULL,
      heartbeat_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS scenario_authorizations (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL,
      scenario_kind TEXT NOT NULL,
      scope_json TEXT NOT NULL,
      approved_by TEXT NOT NULL,
      status TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_scenario_authorizations_case ON scenario_authorizations(case_id, status, expires_at);
    CREATE TABLE IF NOT EXISTS worker_tool_receipts (
      idempotency_key TEXT PRIMARY KEY,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS scenario_work_approvals (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      case_id TEXT NOT NULL,
      work_id TEXT NOT NULL,
      action_key TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      risk TEXT NOT NULL,
      rationale TEXT NOT NULL,
      input_ref TEXT NOT NULL,
      status TEXT NOT NULL,
      requested_by_worker_id TEXT NOT NULL,
      resolution_reason TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_scenario_work_approvals_status ON scenario_work_approvals(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_scenario_work_approvals_case ON scenario_work_approvals(case_id, created_at);
    CREATE TABLE IF NOT EXISTS scenario_observer_evaluations (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      case_id TEXT NOT NULL,
      observed_run_revision INTEGER NOT NULL,
      observed_graph_revision INTEGER NOT NULL,
      decision_json TEXT NOT NULL,
      applied INTEGER NOT NULL DEFAULT 0,
      resulting_run_revision INTEGER,
      created_at TEXT NOT NULL,
      applied_at TEXT,
      UNIQUE (run_id, observed_run_revision, observed_graph_revision)
    );
    CREATE INDEX IF NOT EXISTS idx_scenario_observer_evaluations_run ON scenario_observer_evaluations(run_id, created_at);
    CREATE TABLE IF NOT EXISTS scenario_observer_cursors (
      run_id TEXT PRIMARY KEY,
      run_revision INTEGER NOT NULL,
      graph_revision INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS scenario_planner_evaluations (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      case_id TEXT NOT NULL,
      input_fingerprint TEXT NOT NULL,
      observed_run_revision INTEGER NOT NULL,
      observed_graph_revision INTEGER NOT NULL,
      observed_phase_id TEXT NOT NULL,
      decision_json TEXT NOT NULL,
      applied INTEGER NOT NULL DEFAULT 0,
      resulting_run_revision INTEGER,
      created_at TEXT NOT NULL,
      applied_at TEXT,
      UNIQUE (run_id, input_fingerprint)
    );
    CREATE INDEX IF NOT EXISTS idx_scenario_planner_evaluations_run ON scenario_planner_evaluations(run_id, created_at);
    CREATE TABLE IF NOT EXISTS scenario_planner_cursors (
      run_id TEXT PRIMARY KEY,
      input_fingerprint TEXT NOT NULL,
      run_revision INTEGER NOT NULL,
      graph_revision INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS scenario_cognitive_context_cursors (
      consumer TEXT NOT NULL,
      run_id TEXT NOT NULL,
      semantic_fingerprint TEXT NOT NULL,
      source_run_revision INTEGER NOT NULL,
      source_graph_revision INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (consumer, run_id)
    );
    CREATE TABLE IF NOT EXISTS scenario_cognitive_snapshots (
      id TEXT PRIMARY KEY,
      parent_snapshot_id TEXT,
      consumer TEXT NOT NULL,
      run_id TEXT NOT NULL,
      case_id TEXT NOT NULL,
      work_id TEXT,
      evaluation_id TEXT,
      source_run_revision INTEGER NOT NULL,
      source_graph_revision INTEGER,
      semantic_fingerprint TEXT,
      request_fingerprint TEXT NOT NULL,
      request_json TEXT NOT NULL,
      context_manifest_json TEXT NOT NULL,
      status TEXT NOT NULL,
      output_json TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_scenario_cognitive_snapshots_run
      ON scenario_cognitive_snapshots(run_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_scenario_cognitive_snapshots_work
      ON scenario_cognitive_snapshots(work_id, created_at);
    CREATE TABLE IF NOT EXISTS scenario_model_calls (
      id TEXT PRIMARY KEY,
      snapshot_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      case_id TEXT NOT NULL,
      work_id TEXT,
      role TEXT NOT NULL,
      route_id TEXT NOT NULL,
      route_attempt INTEGER NOT NULL,
      status TEXT NOT NULL,
      reserved_tokens INTEGER NOT NULL,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      started_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_scenario_model_calls_run
      ON scenario_model_calls(run_id, started_at);
    CREATE TABLE IF NOT EXISTS scenario_model_circuits (
      role TEXT NOT NULL,
      route_id TEXT NOT NULL,
      consecutive_failures INTEGER NOT NULL,
      open_until TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (role, route_id)
    );
    CREATE TABLE IF NOT EXISTS scenario_model_admissions (
      id TEXT PRIMARY KEY,
      snapshot_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      case_id TEXT NOT NULL,
      work_id TEXT,
      role TEXT NOT NULL,
      priority INTEGER NOT NULL,
      status TEXT NOT NULL,
      outcome TEXT,
      queued_at TEXT NOT NULL,
      admitted_at TEXT,
      released_at TEXT,
      queue_wait_ms INTEGER,
      reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_scenario_model_admissions_run
      ON scenario_model_admissions(run_id, queued_at);
    CREATE INDEX IF NOT EXISTS idx_scenario_model_admissions_status
      ON scenario_model_admissions(status, queued_at);
    CREATE TABLE IF NOT EXISTS scenario_agent_event_streams (
      run_id TEXT PRIMARY KEY,
      last_sequence INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS scenario_agent_protocol_events (
      run_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      id TEXT NOT NULL UNIQUE,
      case_id TEXT NOT NULL,
      work_id TEXT,
      turn_id TEXT NOT NULL,
      role TEXT NOT NULL,
      method TEXT NOT NULL,
      item_id TEXT,
      event_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (run_id, sequence)
    );
    CREATE INDEX IF NOT EXISTS idx_scenario_agent_protocol_case
      ON scenario_agent_protocol_events(case_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_scenario_agent_protocol_item
      ON scenario_agent_protocol_events(run_id, item_id, method);
    CREATE TABLE IF NOT EXISTS execution_identities (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      version INTEGER NOT NULL,
      status TEXT NOT NULL,
      secret_ref TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_execution_identities_case ON execution_identities(case_id, status, updated_at);
    CREATE TABLE IF NOT EXISTS execution_sessions (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      scope_ref TEXT NOT NULL,
      identity_id TEXT,
      identity_version INTEGER,
      state_secret_ref TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      last_worker_id TEXT,
      last_work_id TEXT,
      last_lease_id TEXT,
      last_lease_expires_at TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_execution_sessions_run ON execution_sessions(run_id, status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_execution_sessions_scope ON execution_sessions(scope_ref, status, updated_at);
    CREATE TABLE IF NOT EXISTS encrypted_secret_entries (
      ref TEXT PRIMARY KEY,
      nonce BLOB NOT NULL,
      ciphertext BLOB NOT NULL,
      auth_tag BLOB NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS evidence_graph_streams (
      case_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS evidence_graph_commands (
      case_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      resulting_revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (case_id, command_id)
    );
    CREATE TABLE IF NOT EXISTS evidence_graph_events (
      case_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      command_id TEXT NOT NULL,
      event_index INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (case_id, sequence),
      UNIQUE (case_id, command_id, event_index)
    );
    CREATE INDEX IF NOT EXISTS idx_evidence_graph_events_command ON evidence_graph_events(case_id, command_id, event_index);
    CREATE TABLE IF NOT EXISTS evidence_graph_nodes (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL,
      run_id TEXT,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      status TEXT NOT NULL,
      confidence REAL NOT NULL,
      properties_json TEXT NOT NULL,
      source_json TEXT,
      version INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      invalidated_at TEXT,
      invalidation_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_evidence_graph_nodes_case ON evidence_graph_nodes(case_id, kind, status, updated_at);
    CREATE TABLE IF NOT EXISTS evidence_graph_edges (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      relation TEXT NOT NULL,
      rationale TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_evidence_graph_edges_case ON evidence_graph_edges(case_id, relation, source_id, target_id);
    CREATE INDEX IF NOT EXISTS idx_artifacts_case ON artifacts(case_id, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_artifacts_case_sha ON artifacts(case_id, sha256);
    CREATE TABLE IF NOT EXISTS artifact_analysis_attempts (
      id TEXT PRIMARY KEY, case_id TEXT NOT NULL, run_id TEXT, artifact_id TEXT NOT NULL,
      analyzer_id TEXT, status TEXT NOT NULL, coverage_dimensions_json TEXT NOT NULL DEFAULT '[]',
      preflight_fingerprint TEXT, preflight_availability TEXT, preflight_reason TEXT,
      error TEXT, analysis_json TEXT, started_at TEXT NOT NULL, finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_artifact_analysis_attempts_artifact ON artifact_analysis_attempts(artifact_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_artifact_analysis_attempts_case ON artifact_analysis_attempts(case_id, started_at);
    CREATE TABLE IF NOT EXISTS artifact_retry_authorizations (
      id TEXT PRIMARY KEY, case_id TEXT NOT NULL, run_id TEXT, artifact_id TEXT NOT NULL,
      analyzer_id TEXT NOT NULL, failed_attempt_id TEXT NOT NULL, preflight_fingerprint TEXT NOT NULL,
      reason TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_artifact_retry_authorizations_case ON artifact_retry_authorizations(case_id, updated_at);
      CREATE INDEX IF NOT EXISTS idx_artifact_retry_authorizations_artifact ON artifact_retry_authorizations(artifact_id, analyzer_id);
      CREATE TABLE IF NOT EXISTS artifact_recoveries (
        id TEXT PRIMARY KEY, case_id TEXT NOT NULL, run_id TEXT, task_id TEXT NOT NULL,
        artifact_id TEXT NOT NULL, analyzer_id TEXT NOT NULL, failed_attempt_id TEXT,
        before_fingerprint TEXT NOT NULL, after_fingerprint TEXT, instruction TEXT NOT NULL,
        result TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_artifact_recoveries_case ON artifact_recoveries(case_id, updated_at);
      CREATE INDEX IF NOT EXISTS idx_artifact_recoveries_artifact ON artifact_recoveries(artifact_id, analyzer_id);
    CREATE TABLE IF NOT EXISTS artifact_limitation_dispositions (
      id TEXT PRIMARY KEY, case_id TEXT NOT NULL, run_id TEXT, task_id TEXT NOT NULL, artifact_id TEXT NOT NULL,
      status TEXT NOT NULL, missing_dimensions_json TEXT NOT NULL DEFAULT '[]', attempt_ids_json TEXT NOT NULL DEFAULT '[]',
      rationale TEXT NOT NULL, prohibited_conclusion TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_artifact_limitations_case ON artifact_limitation_dispositions(case_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_artifact_limitations_task ON artifact_limitation_dispositions(task_id, artifact_id);
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
      issue_type TEXT NOT NULL DEFAULT 'other', subject TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL, description TEXT NOT NULL,
      related_facts_json TEXT NOT NULL, related_tasks_json TEXT NOT NULL,
      suggested_action TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
      fingerprint TEXT NOT NULL DEFAULT '',
      occurrence_count INTEGER NOT NULL DEFAULT 1,
      last_observed_at TEXT NOT NULL DEFAULT '',
      correction_count INTEGER NOT NULL DEFAULT 0,
      correction_resolved_count INTEGER NOT NULL DEFAULT 0,
      correction_failed_count INTEGER NOT NULL DEFAULT 0,
      correction_outcome TEXT NOT NULL DEFAULT 'none',
      correction_evidence TEXT,
      last_correction_at TEXT, last_correction_trigger TEXT,
      recovery_strategy_refs_json TEXT NOT NULL DEFAULT '[]',
      escalation_reason TEXT,
      related_run_id TEXT, suggested_goal TEXT NOT NULL DEFAULT '',
      evidence TEXT, resolved_at TEXT, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_warnings_case ON observer_warnings(case_id);
    CREATE TABLE IF NOT EXISTS observer_strategy_audits (
      id TEXT PRIMARY KEY, case_id TEXT NOT NULL, run_id TEXT NOT NULL,
      trigger TEXT NOT NULL, offered_candidates_json TEXT NOT NULL,
      adoptions_json TEXT NOT NULL, ignored_strategy_ids_json TEXT NOT NULL,
      context_characters INTEGER NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_observer_strategy_audits_case
      ON observer_strategy_audits(case_id, created_at);
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
    CREATE TABLE IF NOT EXISTS semantic_documents (
      id TEXT PRIMARY KEY, case_id TEXT, kind TEXT NOT NULL, source_id TEXT NOT NULL,
      text_hash TEXT NOT NULL, content TEXT NOT NULL, model TEXT NOT NULL,
      dimensions INTEGER NOT NULL, vector_json TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_semantic_source ON semantic_documents(kind, source_id);
    CREATE INDEX IF NOT EXISTS idx_semantic_case_kind ON semantic_documents(case_id, kind);
    CREATE TABLE IF NOT EXISTS experience_entries (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, applicability TEXT NOT NULL,
      procedure_json TEXT NOT NULL, expected_signals_json TEXT NOT NULL,
      failure_modes_json TEXT NOT NULL, evidence_requirements_json TEXT NOT NULL,
      source_case_id TEXT NOT NULL, source_run_id TEXT, source_task_id TEXT NOT NULL,
      evidence_fact_ids_json TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL,
      success_count INTEGER NOT NULL DEFAULT 0, failure_count INTEGER NOT NULL DEFAULT 0,
      tags_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_experience_status ON experience_entries(status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_experience_source ON experience_entries(source_case_id, source_task_id);
    CREATE TABLE IF NOT EXISTS network_search_runs (
      id TEXT PRIMARY KEY, case_id TEXT NOT NULL, grant_id TEXT NOT NULL, query TEXT NOT NULL,
      allowed_domains_json TEXT NOT NULL, results_json TEXT NOT NULL, status TEXT NOT NULL,
      error TEXT, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_network_search_case ON network_search_runs(case_id, created_at);
    CREATE TABLE IF NOT EXISTS run_cognitive_state (
      run_id TEXT PRIMARY KEY, case_id TEXT NOT NULL,
      current_goal TEXT NOT NULL, phase TEXT NOT NULL,
      focus_json TEXT NOT NULL, active_hypothesis_ids_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_run_cognitive_state_case ON run_cognitive_state(case_id);
  `);
  const warningColumns = sqlite.prepare("PRAGMA table_info(observer_warnings)").all() as Array<{ name: string }>;
  const hasWarningColumn = (name: string) => warningColumns.some((column) => column.name === name);
  if (!hasWarningColumn("status")) sqlite.exec("ALTER TABLE observer_warnings ADD COLUMN status TEXT NOT NULL DEFAULT 'open'");
  if (!hasWarningColumn("issue_type")) sqlite.exec("ALTER TABLE observer_warnings ADD COLUMN issue_type TEXT NOT NULL DEFAULT 'other'");
  if (!hasWarningColumn("subject")) sqlite.exec("ALTER TABLE observer_warnings ADD COLUMN subject TEXT NOT NULL DEFAULT ''");
  if (!hasWarningColumn("related_run_id")) sqlite.exec("ALTER TABLE observer_warnings ADD COLUMN related_run_id TEXT");
  if (!hasWarningColumn("suggested_goal")) sqlite.exec("ALTER TABLE observer_warnings ADD COLUMN suggested_goal TEXT NOT NULL DEFAULT ''");
  if (!hasWarningColumn("evidence")) sqlite.exec("ALTER TABLE observer_warnings ADD COLUMN evidence TEXT");
  if (!hasWarningColumn("resolved_at")) sqlite.exec("ALTER TABLE observer_warnings ADD COLUMN resolved_at TEXT");
  if (!hasWarningColumn("fingerprint")) sqlite.exec("ALTER TABLE observer_warnings ADD COLUMN fingerprint TEXT NOT NULL DEFAULT ''");
  if (!hasWarningColumn("occurrence_count")) sqlite.exec("ALTER TABLE observer_warnings ADD COLUMN occurrence_count INTEGER NOT NULL DEFAULT 1");
  if (!hasWarningColumn("last_observed_at")) sqlite.exec("ALTER TABLE observer_warnings ADD COLUMN last_observed_at TEXT NOT NULL DEFAULT ''");
  if (!hasWarningColumn("correction_count")) sqlite.exec("ALTER TABLE observer_warnings ADD COLUMN correction_count INTEGER NOT NULL DEFAULT 0");
  if (!hasWarningColumn("correction_resolved_count")) sqlite.exec("ALTER TABLE observer_warnings ADD COLUMN correction_resolved_count INTEGER NOT NULL DEFAULT 0");
  if (!hasWarningColumn("correction_failed_count")) sqlite.exec("ALTER TABLE observer_warnings ADD COLUMN correction_failed_count INTEGER NOT NULL DEFAULT 0");
  if (!hasWarningColumn("correction_outcome")) sqlite.exec("ALTER TABLE observer_warnings ADD COLUMN correction_outcome TEXT NOT NULL DEFAULT 'none'");
  if (!hasWarningColumn("correction_evidence")) sqlite.exec("ALTER TABLE observer_warnings ADD COLUMN correction_evidence TEXT");
  if (!hasWarningColumn("last_correction_at")) sqlite.exec("ALTER TABLE observer_warnings ADD COLUMN last_correction_at TEXT");
  if (!hasWarningColumn("last_correction_trigger")) sqlite.exec("ALTER TABLE observer_warnings ADD COLUMN last_correction_trigger TEXT");
  if (!hasWarningColumn("recovery_strategy_refs_json")) sqlite.exec("ALTER TABLE observer_warnings ADD COLUMN recovery_strategy_refs_json TEXT NOT NULL DEFAULT '[]'");
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
  ensureColumns("artifact_analysis_attempts", [
    { name: "analysis_json", definition: "TEXT" },
    { name: "preflight_fingerprint", definition: "TEXT" },
    { name: "preflight_availability", definition: "TEXT" },
    { name: "preflight_reason", definition: "TEXT" },
  ]);
  ensureColumns("hypotheses", [
    { name: "run_id", definition: "TEXT" },
    { name: "priority_score", definition: "INTEGER NOT NULL DEFAULT 50" },
    { name: "score_factors_json", definition: "TEXT NOT NULL DEFAULT '{}'" },
    { name: "relations_json", definition: "TEXT NOT NULL DEFAULT '{}'" },
    { name: "audit_trail_json", definition: "TEXT NOT NULL DEFAULT '[]'" },
  ]);
  sqlite.exec(`
    DROP TABLE IF EXISTS agent_run_usage;
    DROP TABLE IF EXISTS solver_work_items;
    DROP TABLE IF EXISTS agent_runs;
    DROP TABLE IF EXISTS agent_events;
  `);
  applyDataMigrations(sqlite);
  return drizzle(sqlite);
}

export type Db = ReturnType<typeof createDb>;

export function getSqliteClient(db: Db): Database.Database {
  return db.$client;
}
