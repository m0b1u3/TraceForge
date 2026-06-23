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
  `);
  return drizzle(sqlite);
}

export type Db = ReturnType<typeof createDb>;
