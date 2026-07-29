import type Database from "better-sqlite3";

export const REMOVE_LEGACY_FAILED_ATTEMPT_FACTS =
  "2026-07-29-remove-legacy-failed-attempt-facts";

type SqliteConnection = Database.Database;

function hasMigration(sqlite: SqliteConnection, id: string): boolean {
  return Boolean(sqlite.prepare("SELECT 1 FROM app_migrations WHERE id = ?").get(id));
}

/**
 * Retires the legacy representation where operational tool failures were
 * stored as security Facts. Agent events remain untouched as the audit source.
 */
export function applyDataMigrations(sqlite: SqliteConnection): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS app_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  if (hasMigration(sqlite, REMOVE_LEGACY_FAILED_ATTEMPT_FACTS)) return;

  sqlite.transaction(() => {
    sqlite.exec(`
      DELETE FROM knowledge_usage
      WHERE knowledge_kind = 'fact'
        AND knowledge_id IN (SELECT id FROM facts WHERE type = 'failed_attempt');

      DELETE FROM timeline
      WHERE ref_id IN (SELECT id FROM facts WHERE type = 'failed_attempt');

      DELETE FROM facts
      WHERE type = 'failed_attempt';
    `);
    sqlite.prepare("INSERT INTO app_migrations (id, applied_at) VALUES (?, ?)")
      .run(REMOVE_LEGACY_FAILED_ATTEMPT_FACTS, new Date().toISOString());
  })();
}
