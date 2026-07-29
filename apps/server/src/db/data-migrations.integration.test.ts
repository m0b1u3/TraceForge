import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  applyDataMigrations,
  REMOVE_LEGACY_FAILED_ATTEMPT_FACTS,
} from "./data-migrations.js";

describe("data migrations with real SQLite", () => {
  it("removes legacy failure facts and their derived rows while preserving execution events", () => {
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
      CREATE TABLE agent_events (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        text TEXT NOT NULL
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
      INSERT INTO agent_events (id, kind, text) VALUES
        ('failure_event', 'tool_result', 'command failed');
    `);

    applyDataMigrations(sqlite);
    applyDataMigrations(sqlite);

    expect(sqlite.prepare("SELECT id FROM facts ORDER BY id").all()).toEqual([{ id: "evidence" }]);
    expect(sqlite.prepare("SELECT id FROM knowledge_usage ORDER BY id").all()).toEqual([{ id: "evidence_usage" }]);
    expect(sqlite.prepare("SELECT id FROM timeline ORDER BY id").all()).toEqual([{ id: "evidence_timeline" }]);
    expect(sqlite.prepare("SELECT id FROM agent_events").all()).toEqual([{ id: "failure_event" }]);
    expect(sqlite.prepare("SELECT id FROM app_migrations").all()).toEqual([
      { id: REMOVE_LEGACY_FAILED_ATTEMPT_FACTS },
    ]);

    sqlite.close();
  });
});
