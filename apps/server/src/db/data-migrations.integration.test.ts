import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDb, getSqliteClient } from "./client.js";

describe("data migrations with real SQLite", () => {
  it("does not recreate abandoned application tables", () => {
    const sqlite = getSqliteClient(createDb(":memory:"));
    try {
      const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
      const names = new Set(tables.map(row => row.name));
      for (const name of ["identity_contexts", "attack_paths", "security_reports", "security_report_revisions",
        "artifacts", "artifact_analysis_attempts", "artifact_retry_authorizations", "artifact_recoveries",
        "artifact_limitation_dispositions", "facts", "tasks", "timeline", "action_cards", "decisions",
        "knowledge_usage", "validation_conclusions", "validation_consensus", "observer_warnings",
        "observer_strategy_audits", "hypotheses", "context_summaries", "semantic_documents",
        "experience_entries", "network_search_runs", "run_cognitive_state", "app_migrations"]) {
        expect(names.has(name), name).toBe(false);
      }
      for (const name of ["desktop_conversations", "scenario_artifacts", "traffic_entries", "execution_identities", "evidence_graph_nodes"]) {
        expect(names.has(name), name).toBe(true);
      }
    } finally { sqlite.close(); }
  });

  it("leaves existing historical data untouched instead of deleting it during startup", () => {
    const directory = mkdtempSync(join(tmpdir(), "traceforge-retirement-"));
    const path = join(directory, "history.sqlite");
    const old = new Database(path);
    old.exec("CREATE TABLE facts (id TEXT PRIMARY KEY, type TEXT); INSERT INTO facts VALUES ('retained', 'failed_attempt')");
    old.close();
    const current = getSqliteClient(createDb(path));
    try {
      expect(current.prepare("SELECT * FROM facts").all()).toEqual([{ id: "retained", type: "failed_attempt" }]);
    } finally { current.close(); rmSync(directory, { recursive: true, force: true }); }
  });


  it("does not recreate retired chat and solver tables", () => {
    const sqlite = getSqliteClient(createDb(":memory:"));
    const retired = sqlite.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table'
        AND name IN ('agent_events', 'agent_runs', 'agent_run_usage', 'solver_work_items')
      ORDER BY name
    `).all();

    expect(retired).toEqual([]);
    expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'scenario_event_streams'").get())
      .toEqual({ name: "scenario_event_streams" });
    sqlite.close();
  });

  it("adds nullable Scenario Package binding columns without inventing a binding for legacy Runs", () => {
    const directory = mkdtempSync(join(tmpdir(), "traceforge-package-binding-"));
    const path = join(directory, "legacy.sqlite");
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE scenario_event_streams (
        run_id TEXT PRIMARY KEY, case_id TEXT NOT NULL, definition_kind TEXT NOT NULL,
        definition_version INTEGER NOT NULL, status TEXT NOT NULL, active_phase_id TEXT NOT NULL,
        revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO scenario_event_streams
        (run_id, case_id, definition_kind, definition_version, status, active_phase_id, revision, created_at, updated_at)
      VALUES ('legacy_run', 'case_1', 'first_scenario', 1, 'paused', 'first_phase', 1,
        '2026-08-28T00:00:00.000Z', '2026-08-28T00:00:00.000Z');
    `);
    legacy.close();

    const migrated = getSqliteClient(createDb(path));
    const columns = migrated.prepare("PRAGMA table_info(scenario_event_streams)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "scenario_package_id", "scenario_package_version", "scenario_schema_revision",
    ]));
    expect(migrated.prepare(`
      SELECT scenario_package_id, scenario_package_version, scenario_schema_revision
      FROM scenario_event_streams WHERE run_id = 'legacy_run'
    `).get()).toEqual({
      scenario_package_id: null,
      scenario_package_version: null,
      scenario_schema_revision: null,
    });
    migrated.close();
    rmSync(directory, { recursive: true, force: true });
  });
});
