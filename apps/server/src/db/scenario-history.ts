import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import type Database from "better-sqlite3";
import { evolve, type ScenarioEvent, type ScenarioRunState } from "@traceforge/orchestration-core";

export const historyHash = (body: string | Buffer) => createHash("sha256").update(body).digest("hex");
const maximumBytes = 16 * 1024 * 1024, maximumStateBytes = 2 * 1024 * 1024;
const scopes = new WeakMap<Database.Database, string>();
export interface HistoryEventRow {
  run_id: string; sequence: number; command_id: string; event_index: number; event_type: string; payload_json: string; created_at: string;
}
interface Segment {
  run_id: string; first_revision: number; last_revision: number; digest: string; previous_digest: string;
  body_digest: string; payload_digest: string; original_bytes: number; snapshot_digest: string; origin_digest: string;
}
const descriptor = (s: Segment) => JSON.stringify([s.run_id, s.first_revision, s.last_revision, s.previous_digest,
  s.body_digest, s.payload_digest, s.original_bytes, s.snapshot_digest, s.origin_digest]);
const marker = (digest: string) => `run-history:${digest}`;
const columns = "run_id,first_revision,last_revision,digest,previous_digest,body_digest,payload_digest,original_bytes,snapshot_digest,origin_digest";

export function initializeScenarioHistory(sqlite: Database.Database): void {
  sqlite.function("scenario_history_writing", runId => scopes.get(sqlite) === runId ? 1 : 0);
  sqlite.exec(`CREATE TABLE IF NOT EXISTS scenario_history_segments (
    run_id TEXT NOT NULL,first_revision INTEGER NOT NULL,last_revision INTEGER NOT NULL,digest TEXT NOT NULL UNIQUE,previous_digest TEXT NOT NULL,
    body_digest TEXT NOT NULL,payload_digest TEXT NOT NULL,original_bytes INTEGER NOT NULL,snapshot_digest TEXT NOT NULL,origin_digest TEXT NOT NULL,
    payload BLOB NOT NULL,snapshot_json TEXT NOT NULL,PRIMARY KEY(run_id,first_revision));
    CREATE INDEX IF NOT EXISTS scenario_history_end ON scenario_history_segments(run_id,last_revision);
    CREATE TABLE IF NOT EXISTS scenario_history_policy (id INTEGER PRIMARY KEY CHECK(id=1),maximum_bytes INTEGER NOT NULL CHECK(maximum_bytes>0),maximum_records INTEGER NOT NULL CHECK(maximum_records>0));
    INSERT OR IGNORE INTO scenario_history_policy VALUES (1,1073741824,100000);
    CREATE TABLE IF NOT EXISTS scenario_history_usage (id INTEGER PRIMARY KEY CHECK(id=1),bytes INTEGER NOT NULL,records INTEGER NOT NULL);
    INSERT OR IGNORE INTO scenario_history_usage VALUES (1,0,0);
    CREATE TABLE IF NOT EXISTS scenario_lease_history (run_id TEXT NOT NULL,lease_id TEXT NOT NULL,sequence INTEGER NOT NULL,PRIMARY KEY(run_id,lease_id),UNIQUE(run_id,sequence));
    CREATE TABLE IF NOT EXISTS scenario_history_audits (command_id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,audit_hash TEXT NOT NULL,audit_json TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS scenario_history_admit BEFORE INSERT ON scenario_history_segments BEGIN
      SELECT CASE WHEN NEW.first_revision<1 OR NEW.last_revision<NEW.first_revision OR NEW.last_revision-NEW.first_revision>=1000
        OR NEW.original_bytes NOT BETWEEN 1 AND 16777216 OR length(NEW.payload)>16777216 OR length(CAST(NEW.snapshot_json AS BLOB))>2162688
        OR (SELECT count(*) FROM scenario_history_segments WHERE run_id=NEW.run_id)>=1024
        THEN RAISE(ABORT,'Run history segment bounds exceeded') END;
      SELECT CASE WHEN EXISTS(SELECT 1 FROM scenario_history_usage u JOIN scenario_history_policy p USING(id)
        WHERE u.records+1>p.maximum_records OR u.bytes+length(NEW.payload)+length(CAST(NEW.snapshot_json AS BLOB))+4096>p.maximum_bytes)
        THEN RAISE(ABORT,'Run history archive capacity exceeded') END;
      SELECT execution_physical_admit(recovery_floor,maximum_database_bytes,maximum_wal_bytes,
        65536+NEW.original_bytes+length(NEW.payload)+length(CAST(NEW.snapshot_json AS BLOB)),'recovery') FROM execution_physical_policy WHERE id=1;
    END;
    CREATE TRIGGER IF NOT EXISTS scenario_history_account AFTER INSERT ON scenario_history_segments BEGIN
      UPDATE scenario_history_usage SET bytes=bytes+length(NEW.payload)+length(CAST(NEW.snapshot_json AS BLOB))+4096,records=records+1 WHERE id=1;
    END;
    CREATE TRIGGER IF NOT EXISTS scenario_history_audit_admit BEFORE INSERT ON scenario_history_audits BEGIN
      SELECT CASE WHEN (SELECT count(*) FROM scenario_history_audits)>=50000 OR length(CAST(NEW.audit_json AS BLOB))>8192
        THEN RAISE(ABORT,'Run history audit capacity exceeded') END;
      SELECT execution_physical_admit(recovery_floor,maximum_database_bytes,maximum_wal_bytes,16384,'recovery') FROM execution_physical_policy WHERE id=1;
    END;
    CREATE TRIGGER IF NOT EXISTS scenario_history_event_update BEFORE UPDATE ON scenario_events
      WHEN scenario_history_writing(OLD.run_id)=0 AND EXISTS(SELECT 1 FROM scenario_history_segments WHERE run_id=OLD.run_id AND OLD.sequence BETWEEN first_revision AND last_revision)
      BEGIN SELECT RAISE(ABORT,'Archived Run event is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS scenario_history_event_delete BEFORE DELETE ON scenario_events
      WHEN EXISTS(SELECT 1 FROM scenario_history_segments WHERE run_id=OLD.run_id AND OLD.sequence BETWEEN first_revision AND last_revision)
      BEGIN SELECT RAISE(ABORT,'Archived Run event identity is permanent'); END;
    CREATE TRIGGER IF NOT EXISTS scenario_history_command_update BEFORE UPDATE ON scenario_commands
      WHEN EXISTS(SELECT 1 FROM scenario_events e JOIN scenario_history_segments s ON s.run_id=e.run_id AND e.sequence BETWEEN s.first_revision AND s.last_revision
        WHERE e.run_id=OLD.run_id AND e.command_id=OLD.command_id)
      BEGIN SELECT RAISE(ABORT,'Archived Run command is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS scenario_history_command_delete BEFORE DELETE ON scenario_commands
      WHEN EXISTS(SELECT 1 FROM scenario_events e JOIN scenario_history_segments s ON s.run_id=e.run_id AND e.sequence BETWEEN s.first_revision AND s.last_revision
        WHERE e.run_id=OLD.run_id AND e.command_id=OLD.command_id)
      BEGIN SELECT RAISE(ABORT,'Archived Run command is permanent'); END;`);
  for (const table of ["scenario_history_segments", "scenario_history_audits", "scenario_lease_history"]) {
    for (const operation of ["UPDATE", "DELETE"]) sqlite.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_${operation} BEFORE ${operation} ON ${table}
      BEGIN SELECT RAISE(ABORT,'Run history is immutable'); END;`);
  }
}

/** Keep permanent metadata; only bounded body readers interpret the cold representation. */
export function readHistoryRows(sqlite: Database.Database, runId: string, after: number, limit: number, through = Number.MAX_SAFE_INTEGER): HistoryEventRow[] {
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("Invalid Run history page bounds");
  const sizes = sqlite.prepare(`SELECT sequence,length(CAST(payload_json AS BLOB)) bytes FROM scenario_events
    WHERE run_id=? AND sequence>? AND sequence<=? ORDER BY sequence LIMIT ?`).all(runId, after, through, limit) as { sequence: number; bytes: number }[];
  if (sizes.reduce((sum, row) => sum + row.bytes, 0) > maximumBytes) throw new Error("Run event page byte budget exceeded");
  const rows = sqlite.prepare("SELECT * FROM scenario_events WHERE run_id=? AND sequence>? AND sequence<=? ORDER BY sequence LIMIT ?")
    .all(runId, after, through, limit) as HistoryEventRow[];
  let cached: { segment: Segment; rows: HistoryEventRow[] } | undefined, bytes = 0;
  return rows.map(row => {
    let original = row;
    if (row.payload_json.startsWith("run-history:")) {
      const digest = row.payload_json.slice("run-history:".length);
      if (cached?.segment.digest !== digest) {
        const segment = sqlite.prepare(`SELECT ${columns} FROM scenario_history_segments WHERE digest=? AND run_id=?`).get(digest, runId) as Segment | undefined;
        if (!segment) throw new Error("Run history segment is missing");
        cached = { segment, rows: decodeSegment(sqlite, segment) };
      }
      original = cached.rows[row.sequence - cached.segment.first_revision]!;
      if (!original || Object.keys(row).some(key => key !== "payload_json" && row[key as keyof HistoryEventRow] !== original[key as keyof HistoryEventRow])) throw new Error("Run history event identity mismatch");
    }
    bytes += Buffer.byteLength(original.payload_json);
    if (bytes > maximumBytes) throw new Error("Run event page byte budget exceeded");
    const event = JSON.parse(original.payload_json) as ScenarioEvent;
    if (event.type !== row.event_type || (row.sequence === 1) !== (event.type === "run_started")) throw new Error("Run event origin or type mismatch");
    return original;
  });
}

function payload(sqlite: Database.Database, segment: Segment): Buffer {
  const row = sqlite.prepare(`SELECT CASE WHEN length(payload)<=16777216 THEN payload ELSE NULL END payload FROM scenario_history_segments WHERE digest=?`)
    .get(segment.digest) as { payload: Buffer | null } | undefined;
  if (!row?.payload || segment.original_bytes < 1 || segment.original_bytes > maximumBytes || historyHash(descriptor(segment)) !== segment.digest
    || historyHash(row.payload) !== segment.payload_digest) throw new Error("Run history segment integrity mismatch");
  return row.payload;
}
function decodeSegment(sqlite: Database.Database, segment: Segment): HistoryEventRow[] {
  const body = gunzipSync(payload(sqlite, segment), { maxOutputLength: maximumBytes });
  if (body.length !== segment.original_bytes || historyHash(body) !== segment.body_digest) throw new Error("Run history body integrity mismatch");
  const rows = JSON.parse(body.toString("utf8")) as HistoryEventRow[];
  if (!Array.isArray(rows) || rows.length !== segment.last_revision - segment.first_revision + 1
    || rows.some((row, index) => row.run_id !== segment.run_id || row.sequence !== segment.first_revision + index || typeof row.payload_json !== "string")) throw new Error("Run history range mismatch");
  return rows;
}

export function historyRevision(sqlite: Database.Database, runId: string): number {
  return (sqlite.prepare("SELECT revision FROM scenario_event_streams WHERE run_id=?").get(runId) as { revision: number } | undefined)?.revision ?? 0;
}

/** Verifies compressed prefix bytes without deserializing every historical event. No trust grant is issued. */
export function readHistoryState(sqlite: Database.Database, runId: string, through?: number): ScenarioRunState | undefined {
  return sqlite.transaction(() => {
    const revision = historyRevision(sqlite, runId);
    if (!revision) return undefined;
    const end = through ?? revision;
    if (!Number.isSafeInteger(end) || end < 1 || end > revision) throw new Error("Invalid Run replay revision");
    const range = sqlite.prepare("SELECT count(*) n,min(sequence) first,max(sequence) last FROM scenario_events WHERE run_id=?").get(runId) as { n: number; first: number; last: number };
    if (range.n !== revision || range.first !== 1 || range.last !== revision) throw new Error("Run event sequence integrity mismatch");
    const segments = sqlite.prepare(`SELECT ${columns} FROM scenario_history_segments WHERE run_id=? ORDER BY first_revision`).all(runId) as Segment[];
    if (segments.length > 1024) throw new Error("Run history chain budget exceeded");
    let previous = "", position = 0, selected: Segment | undefined;
    for (const segment of segments) {
      if (segment.first_revision !== position + 1 || segment.last_revision > revision || segment.previous_digest !== previous) throw new Error("Run history chain integrity mismatch");
      payload(sqlite, segment);
      const origin = sqlite.prepare("SELECT payload_json FROM scenario_events WHERE run_id=? AND sequence=1").get(runId) as { payload_json: string };
      if (historyHash(origin.payload_json) !== segment.origin_digest) throw new Error("Run history origin integrity mismatch");
      const replaced = sqlite.prepare("SELECT count(*) n FROM scenario_events WHERE run_id=? AND sequence BETWEEN ? AND ? AND sequence!=1 AND payload_json=?")
        .get(runId, segment.first_revision, segment.last_revision, marker(segment.digest)) as { n: number };
      if (replaced.n !== segment.last_revision - segment.first_revision + 1 - (segment.first_revision === 1 ? 1 : 0)) throw new Error("Run history source projection mismatch");
      if (sqlite.prepare(`SELECT 1 FROM scenario_events e WHERE e.run_id=? AND e.sequence BETWEEN ? AND ? AND e.event_type='work_claimed'
        AND NOT EXISTS(SELECT 1 FROM scenario_lease_history l WHERE l.run_id=e.run_id AND l.sequence=e.sequence) LIMIT 1`)
        .get(runId, segment.first_revision, segment.last_revision)) throw new Error("Run history lease identity index is incomplete");
      if (segment.last_revision <= end) selected = segment;
      position = segment.last_revision; previous = segment.digest;
    }
    let state: ScenarioRunState | undefined, start = 0;
    if (selected) {
      const row = sqlite.prepare("SELECT CASE WHEN length(CAST(snapshot_json AS BLOB))<=2162688 THEN snapshot_json ELSE NULL END body FROM scenario_history_segments WHERE digest=?")
        .get(selected.digest) as { body: string | null };
      if (!row.body || historyHash(row.body) !== selected.snapshot_digest) throw new Error("Run history snapshot integrity mismatch");
      const saved = JSON.parse(row.body) as { format: number; reducerVersion: number; runId: string; revision: number; bodyDigest: string; state: ScenarioRunState };
      if (saved.format !== 1 || saved.reducerVersion !== 1 || saved.runId !== runId || saved.revision !== selected.last_revision || saved.bodyDigest !== selected.body_digest
        || saved.state?.id !== runId || saved.state.revision !== saved.revision) throw new Error("Run history snapshot version or binding mismatch");
      state = saved.state; start = saved.revision;
    }
    if (end - start > 5000) throw new Error("Run replay tail budget exceeded; archive earlier ranges first");
    let bytes = 0;
    while (start < end) {
      const rows = readHistoryRows(sqlite, runId, start, Math.min(100, end - start), end);
      if (!rows.length || rows[0]!.sequence !== start + 1) throw new Error("Run replay event missing");
      for (const row of rows) {
        bytes += Buffer.byteLength(row.payload_json);
        if (bytes > maximumBytes) throw new Error("Run replay byte budget exceeded");
        state = evolve(state, JSON.parse(row.payload_json) as ScenarioEvent);
        if (!state || Buffer.byteLength(JSON.stringify(state)) > maximumStateBytes) throw new Error("Run forensic state budget exceeded");
        start = row.sequence;
      }
    }
    if (!state || state.id !== runId || state.revision !== end || Buffer.byteLength(JSON.stringify(state)) > maximumStateBytes) throw new Error("Run snapshot state integrity mismatch");
    if (end === revision) assertHistoryProjection(sqlite, state);
    return state;
  })();
}

function assertHistoryProjection(sqlite: Database.Database, state: ScenarioRunState) {
  const row = sqlite.prepare("SELECT * FROM scenario_event_streams WHERE run_id=?").get(state.id) as Record<string, unknown>;
  if (state.caseId !== row.case_id || state.status !== row.status || state.definitionKind !== row.definition_kind || state.definitionVersion !== row.definition_version
    || (state.scenarioPackage?.id ?? null) !== row.scenario_package_id || (state.scenarioPackage?.version ?? null) !== row.scenario_package_version
    || (state.scenarioPackage?.schemaRevision ?? null) !== row.scenario_schema_revision) throw new Error("Run projection integrity mismatch");
}

export function archiveHistoryRange(sqlite: Database.Database, runId: string, through: number) {
  if (!sqlite.inTransaction) throw new Error("Run history archive requires an atomic control transaction");
  const last = sqlite.prepare("SELECT last_revision,digest FROM scenario_history_segments WHERE run_id=? ORDER BY last_revision DESC LIMIT 1")
    .get(runId) as { last_revision: number; digest: string } | undefined;
  const first = (last?.last_revision ?? 0) + 1;
  if (!Number.isSafeInteger(through) || through < first || through - first >= 1000) throw new Error("Run history archive range must contain 1..1000 events");
  const state = readHistoryState(sqlite, runId, through);
  if (!state) throw new Error("Unknown Run");
  const rows = readHistoryRows(sqlite, runId, first - 1, through - first + 1, through);
  if (rows.length !== through - first + 1) throw new Error("Run archive range incomplete");
  const body = JSON.stringify(rows), originalBytes = Buffer.byteLength(body);
  if (originalBytes > maximumBytes) throw new Error("Run history body budget exceeded");
  const bodyDigest = historyHash(body), compressed = gzipSync(body);
  const snapshot = JSON.stringify({ format: 1, reducerVersion: 1, runId, revision: through, bodyDigest, state });
  const origin = sqlite.prepare("SELECT payload_json FROM scenario_events WHERE run_id=? AND sequence=1").get(runId) as { payload_json: string };
  const segment: Segment = { run_id: runId, first_revision: first, last_revision: through, previous_digest: last?.digest ?? "", body_digest: bodyDigest,
    payload_digest: historyHash(compressed), original_bytes: originalBytes, snapshot_digest: historyHash(snapshot), origin_digest: historyHash(origin.payload_json), digest: "" };
  segment.digest = historyHash(descriptor(segment));
  sqlite.prepare("INSERT INTO scenario_history_segments VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(segment.run_id, first, through, segment.digest, segment.previous_digest,
    bodyDigest, segment.payload_digest, originalBytes, segment.snapshot_digest, segment.origin_digest, compressed, snapshot);
  const insertLease = sqlite.prepare("INSERT OR IGNORE INTO scenario_lease_history VALUES (?,?,?)");
  for (const row of rows) {
    const event = JSON.parse(row.payload_json) as ScenarioEvent;
    if (event.type === "work_claimed") {
      insertLease.run(runId, event.leaseId, row.sequence);
      const saved = sqlite.prepare("SELECT sequence FROM scenario_lease_history WHERE run_id=? AND lease_id=?").get(runId, event.leaseId) as { sequence: number } | undefined;
      if (saved?.sequence !== row.sequence) throw new Error("Run history contains a reused lease identity");
    }
  }
  scopes.set(sqlite, runId);
  try { sqlite.prepare("UPDATE scenario_events SET payload_json=? WHERE run_id=? AND sequence BETWEEN ? AND ? AND sequence!=1")
    .run(marker(segment.digest), runId, first, through); }
  finally { scopes.delete(sqlite); }
  if (JSON.stringify(decodeSegment(sqlite, segment)) !== body) throw new Error("Run archive roundtrip mismatch");
  return { firstRevision: first, throughRevision: through, digest: segment.digest, originalBytes, compressedBytes: compressed.length, snapshotBytes: Buffer.byteLength(snapshot) };
}
