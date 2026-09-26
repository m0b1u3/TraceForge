import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { BrowserArtifactPort, BrowserSessionOwner } from "@traceforge/browser-runtime";
import type { BrowserArtifactInput } from "./scenario-browser-host.js";
import type { ScenarioArtifactRecord } from "@traceforge/scenario-sdk";

const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
/** Private content in the same database as its evidence index and backup. No
 * filesystem paths or untrusted download filenames are used for storage. */
export class SqliteBrowserArtifactContent implements BrowserArtifactPort {
  constructor(private readonly sqlite: Database.Database) {
    sqlite.exec(`CREATE TABLE IF NOT EXISTS browser_artifact_content (
      ref TEXT PRIMARY KEY, case_id TEXT NOT NULL, run_id TEXT NOT NULL, work_id TEXT NOT NULL,
      session_id TEXT NOT NULL, kind TEXT NOT NULL, digest TEXT NOT NULL, body BLOB NOT NULL, created_at TEXT NOT NULL);
      DROP TRIGGER IF EXISTS browser_content_bound;
      DROP TRIGGER IF EXISTS browser_binding_bound;
      CREATE TRIGGER browser_content_bound BEFORE INSERT ON browser_artifact_content BEGIN
        SELECT CASE WHEN length(NEW.body)>67108864 OR length(NEW.ref)>128 OR length(NEW.case_id)>256
          OR length(NEW.run_id)>256 OR length(NEW.work_id)>256 OR length(NEW.session_id)>256
          OR length(NEW.digest)!=64 OR NEW.kind NOT IN ('dom','screenshot','download')
          THEN RAISE(ABORT,'Browser content capacity exceeded') END;
        SELECT execution_physical_admit(execution_floor,maximum_database_bytes,maximum_wal_bytes,length(NEW.body)+8192,'execution')
          FROM execution_physical_policy WHERE id=1;
      END;
      CREATE TRIGGER IF NOT EXISTS browser_content_immutable BEFORE UPDATE ON browser_artifact_content
        BEGIN SELECT RAISE(ABORT,'Browser content immutable'); END;
      CREATE TABLE IF NOT EXISTS browser_content_bindings (artifact_id TEXT PRIMARY KEY, content_ref TEXT NOT NULL);
      CREATE TRIGGER browser_binding_bound BEFORE INSERT ON browser_content_bindings BEGIN
        SELECT execution_physical_admit(execution_floor,maximum_database_bytes,maximum_wal_bytes,
          length(NEW.artifact_id)+length(NEW.content_ref)+512,'execution') FROM execution_physical_policy WHERE id=1;
      END;`);
  }
  recordObservation(input: Parameters<BrowserArtifactPort["recordObservation"]>[0]) { return this.record(input, input.kind); }
  recordDownload(input: Parameters<BrowserArtifactPort["recordDownload"]>[0]) { return this.record(input, "download"); }
  /** The index callback must synchronously write to this same host database. */
  persistArtifact(kind: "download" | "observation", value: BrowserArtifactInput, index: (saved: { ref: string }) => ScenarioArtifactRecord) {
    return this.sqlite.transaction(() => {
      const saved = kind === "download" ? this.recordDownload(value as Parameters<BrowserArtifactPort["recordDownload"]>[0])
        : this.recordObservation(value as Parameters<BrowserArtifactPort["recordObservation"]>[0]);
      const result: unknown = index(saved);
      if (result && typeof (result as Promise<unknown>).then === "function") {
        void Promise.resolve(result).catch(() => undefined);
        throw new Error("Browser index must be synchronous");
      }
      const id = (result as ScenarioArtifactRecord | undefined)?.id;
      const linked = typeof id === "string" && this.sqlite.prepare("SELECT 1 FROM scenario_artifacts WHERE id=? AND content_ref=? AND case_id=? AND run_id=? AND digest=? AND byte_size=?")
        .get(id, saved.ref, value.owner.caseId, value.owner.runId, `sha256:${value.sha256}`, value.byteSize);
      if (!linked) throw new Error("Browser content requires a matching index");
      if (!this.sqlite.prepare("SELECT 1 FROM browser_content_bindings WHERE artifact_id=? AND content_ref=?").get(id, saved.ref))
        this.sqlite.prepare("INSERT INTO browser_content_bindings VALUES (?,?)").run(id, saved.ref);
      return saved;
    })();
  }
  /** A generic Scenario-created index is not a grant to Browser body bytes. */
  readBound(ref: string, owner: Pick<BrowserSessionOwner, "caseId" | "runId">, artifactId: string) {
    if (!this.sqlite.prepare("SELECT 1 FROM browser_content_bindings WHERE artifact_id=? AND content_ref=?").get(artifactId, ref)) return undefined;
    return this.read(ref, owner);
  }
  /** Only unreferenced legacy/failure content can be reclaimed; evidence remains. */
  pruneUnreferenced() {
    return this.sqlite.transaction(() => {
      const removed = this.sqlite.prepare("DELETE FROM browser_artifact_content WHERE NOT EXISTS (SELECT 1 FROM scenario_artifacts WHERE content_ref=browser_artifact_content.ref)").run().changes;
      this.sqlite.prepare("DELETE FROM browser_content_bindings WHERE NOT EXISTS (SELECT 1 FROM scenario_artifacts WHERE id=browser_content_bindings.artifact_id) OR NOT EXISTS (SELECT 1 FROM browser_artifact_content WHERE ref=browser_content_bindings.content_ref)").run();
      return removed;
    })();
  }
  private record(input: { owner: BrowserSessionOwner; sessionId: string; bodyBase64: string; byteSize: number; sha256: string }, kind: string) {
    if (typeof input.bodyBase64 !== "string" || input.bodyBase64.length > 89478488) throw new Error("Browser content exceeds transfer limit");
    const body = Buffer.from(input.bodyBase64, "base64");
    if (body.toString("base64") !== input.bodyBase64 || body.length !== input.byteSize || sha(body) !== input.sha256) throw new Error("Browser content digest mismatch");
    const { caseId, runId, workId } = input.owner;
    const ref = `browser-content:${sha(JSON.stringify([caseId, runId, workId, input.sessionId, kind, input.sha256]))}`;
    if (this.read(ref, { caseId, runId })) return { ref };
    this.sqlite.prepare("INSERT OR IGNORE INTO browser_artifact_content VALUES (?,?,?,?,?,?,?,?,?)")
      .run(ref, caseId, runId, workId, input.sessionId, kind, input.sha256, body, new Date().toISOString());
    return { ref };
  }
  /** Callers must authorize the case/run before invoking this host-only port. */
  read(ref: string, owner: Pick<BrowserSessionOwner, "caseId" | "runId">): Buffer | undefined {
    const row = this.sqlite.prepare("SELECT body,digest FROM browser_artifact_content WHERE ref=? AND case_id=? AND run_id=?")
      .get(ref, owner.caseId, owner.runId) as { body: Buffer; digest: string } | undefined;
    if (!row) return undefined;
    if (row.body.length > 67108864 || sha(row.body) !== row.digest) throw new Error("Browser content is corrupt");
    return Buffer.from(row.body);
  }
}
