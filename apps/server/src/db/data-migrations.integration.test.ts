import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  applyDataMigrations,
  REMOVE_LEGACY_FAILED_ATTEMPT_FACTS,
} from "./data-migrations.js";
import { createDb, getSqliteClient } from "./client.js";

describe("data migrations with real SQLite", () => {
  it("removes legacy failure facts and their derived rows", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE facts (id TEXT PRIMARY KEY, type TEXT NOT NULL);
      CREATE TABLE knowledge_usage (
        id TEXT PRIMARY KEY,
        knowledge_id TEXT NOT NULL,
        knowledge_kind TEXT NOT NULL
      );
      CREATE TABLE timeline (
        id TEXT PRIMARY KEY,
        ref_id TEXT
      );
      INSERT INTO facts (id, type) VALUES
        ('legacy_failure', 'failed_attempt'),
        ('evidence', 'http_observation');
      INSERT INTO knowledge_usage (id, knowledge_id, knowledge_kind) VALUES
        ('legacy_usage', 'legacy_failure', 'fact'),
        ('evidence_usage', 'evidence', 'fact');
      INSERT INTO timeline (id, ref_id) VALUES
        ('legacy_timeline', 'legacy_failure'),
        ('evidence_timeline', 'evidence');
    `);

    applyDataMigrations(sqlite);
    applyDataMigrations(sqlite);

    expect(sqlite.prepare("SELECT id FROM facts ORDER BY id").all()).toEqual([{ id: "evidence" }]);
    expect(sqlite.prepare("SELECT id FROM knowledge_usage ORDER BY id").all()).toEqual([{ id: "evidence_usage" }]);
    expect(sqlite.prepare("SELECT id FROM timeline ORDER BY id").all()).toEqual([{ id: "evidence_timeline" }]);
    expect(sqlite.prepare("SELECT id FROM app_migrations").all()).toEqual([
      { id: REMOVE_LEGACY_FAILED_ATTEMPT_FACTS },
    ]);

    sqlite.close();
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
});
