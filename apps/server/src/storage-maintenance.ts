import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { canonicalJson } from "@traceforge/orchestration-core";
import { maximumCheckpointBytes, validateWorkerCheckpoint } from "@traceforge/worker-runtime";
import { SqliteScenarioEventStore } from "./scenario-event-store.js";
import { readExecutionRow } from "./db/execution-archive.js";
import { isExecutionStorageCapacityError, isExecutionStorageWriteError } from "./db/execution-storage.js";
import { physicalStorageStatus } from "./db/physical-storage.js";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const text = z.string().trim().min(1).max(256);
const fileName = z.string().regex(/^sha256-[a-f0-9]{64}\.json(?:\.[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.tmp)?$/);
const checkpointName = (name: string) => fileName.parse(name).slice(0, 76);
const requestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("checkpoint_wal"), commandId: text, actor: text, reason: text, mode: z.enum(["PASSIVE", "TRUNCATE"]) }).strict(),
  z.object({ action: z.literal("migrate_checkpoint"), commandId: text, actor: text, reason: text, name: fileName,
    digest: z.string().regex(/^[a-f0-9]{64}$/), retireSource: z.boolean() }).strict(),
]);
type MaintenanceRequest = z.infer<typeof requestSchema>;
export interface StorageMaintenanceAuthorizer {
  authorize(request: MaintenanceRequest): Promise<{ decision: "allowed"; authorizationRef: string; expiresAt: string } | { decision: "denied" }>;
}
type Audit = { commandId: string; fingerprint: string; request: MaintenanceRequest; phase: "prepared" | "imported" | "completed";
  result: Record<string, unknown> | null };

/** Deployment-owned roots must not be writable by untrusted tools or a concurrently running legacy writer. */
export class StorageMaintenanceControl {
  constructor(private readonly sqlite: Database.Database, private readonly root: string,
    private readonly authorizer: StorageMaintenanceAuthorizer = { async authorize() { return { decision: "denied" }; } },
    private readonly now = () => new Date().toISOString(), private readonly retentionMs = 86400000) {
    if (!Number.isSafeInteger(retentionMs) || retentionMs < 0) throw new Error("Invalid checkpoint retirement retention");
    sqlite.exec(`CREATE TABLE IF NOT EXISTS storage_maintenance_commands (
      command_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, request_json TEXT NOT NULL, grant_ref TEXT NOT NULL,
      phase TEXT NOT NULL CHECK(phase IN ('prepared','imported','completed')), result_json TEXT, updated_at TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS storage_maintenance_bounded BEFORE INSERT ON storage_maintenance_commands BEGIN
        SELECT CASE WHEN (SELECT count(*) FROM storage_maintenance_commands)>=10000
          THEN RAISE(ABORT,'Execution storage capacity exhausted: maintenance commands') END;
        SELECT CASE WHEN length(CAST(NEW.request_json AS BLOB))>4096 OR length(CAST(NEW.grant_ref AS BLOB))>1024
          THEN RAISE(ABORT,'Maintenance command exceeds its size limit') END;
        SELECT CASE WHEN EXISTS(SELECT 1 FROM storage_maintenance_commands WHERE command_id=NEW.command_id)
          THEN RAISE(ABORT,'Maintenance command replacement forbidden') END;
      END;
      CREATE TRIGGER IF NOT EXISTS storage_maintenance_identity BEFORE UPDATE ON storage_maintenance_commands BEGIN
        SELECT CASE WHEN NEW.command_id!=OLD.command_id OR NEW.fingerprint!=OLD.fingerprint OR NEW.request_json!=OLD.request_json
          OR NEW.grant_ref!=OLD.grant_ref OR OLD.phase='completed' OR length(CAST(coalesce(NEW.result_json,'') AS BLOB))>4096
          OR (OLD.phase='imported' AND NEW.phase!='completed')
          THEN RAISE(ABORT,'Maintenance command identity is immutable') END;
      END;
      CREATE TRIGGER IF NOT EXISTS storage_maintenance_keep BEFORE DELETE ON storage_maintenance_commands
        BEGIN SELECT RAISE(ABORT,'Maintenance command cannot be deleted'); END;`);
  }

  status() { return physicalStorageStatus(this.sqlite); }

  /** Hard scan bound, including directories/unknown entries. An incomplete scan is never a deletion authorization. */
  inventory() {
    let root: string;
    try { root = this.checkedRoot(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing", scanned: 0, bytes: 0, complete: true, entries: [] };
      throw error;
    }
    const entries: Array<{ name: string; bytes: number; kind: string; ref?: string; imported?: boolean }> = [];
    let scanned = 0, bytes = 0, complete = true;
    const walk = (directory: string, prefix: string, depth: number) => {
      const dir = opendirSync(directory);
      try {
        let item;
        while ((item = dir.readSync())) {
          if (scanned >= 2000) { complete = false; break; }
          scanned++;
          const name = `${prefix}${item.name}`, path = resolve(directory, item.name), stat = lstatSync(path);
          if (stat.isDirectory() && !stat.isSymbolicLink() && depth === 0) { walk(path, `${name}/`, 1); if (!complete) break; continue; }
          if (stat.isFile()) bytes += stat.size;
          const eligible = depth === 0 && stat.isFile() && !stat.isSymbolicLink() && fileName.safeParse(name).success;
          const ref = eligible ? `checkpoint://${checkpointName(name)}` : undefined;
          entries.push({ name, bytes: stat.size, kind: eligible ? name.endsWith(".tmp") ? "candidate_temporary_checkpoint" : "immutable_checkpoint" : stat.isSymbolicLink() ? "symlink_refused"
            : stat.isDirectory() ? "unscanned_directory" : name.endsWith(".tmp") ? "unverified_temporary" : "legacy_or_unknown", ...(ref ? { ref,
              imported: !!this.sqlite.prepare("SELECT 1 FROM worker_checkpoints WHERE ref=?").get(ref) } : {}) });
          if (stat.isDirectory()) complete = false;
        }
      } finally { dir.closeSync(); }
    };
    walk(root, "", 0);
    return { status: "observed", scanned, bytes, complete, entries };
  }

  history(value: unknown) {
    const query = z.object({ after: text.optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).strict().parse(value);
    const rows = this.sqlite.prepare("SELECT command_id AS commandId, phase, updated_at AS updatedAt FROM storage_maintenance_commands WHERE command_id>? ORDER BY command_id LIMIT ?")
      .all(query.after ?? "", query.limit + 1) as Array<{ commandId: string; phase: string; updatedAt: string }>;
    return { entries: rows.slice(0, query.limit), nextCursor: rows.length > query.limit ? rows[query.limit - 1]!.commandId : null };
  }

  async execute(value: unknown) {
    const input = requestSchema.parse(value), fingerprint = hash(canonicalJson(input));
    let existing = this.read(input.commandId, fingerprint);
    if (existing?.phase === "completed") return { ...existing, replayed: true };
    let grant;
    try { grant = await this.authorizer.authorize(structuredClone(input)); }
    catch { throw new Error("Storage maintenance authorization denied"); }
    if (grant?.decision !== "allowed" || typeof grant.authorizationRef !== "string" || !grant.authorizationRef.trim()
      || Buffer.byteLength(grant.authorizationRef) > 1024 || !Number.isFinite(Date.parse(grant.expiresAt))
      || Date.parse(grant.expiresAt) <= Date.parse(this.now())) throw new Error("Storage maintenance authorization denied or expired");
    existing = this.read(input.commandId, fingerprint);
    if (existing?.phase === "completed") return { ...existing, replayed: true };
    // Durable intent precedes nontransactional WAL maintenance or filesystem removal. Pending stages require fresh authorization.
    if (!existing) this.sqlite.prepare("INSERT INTO storage_maintenance_commands VALUES (?, ?, ?, ?, 'prepared', NULL, ?)")
      .run(input.commandId, fingerprint, JSON.stringify(input), grant.authorizationRef, this.now());
    if (input.action === "checkpoint_wal") {
      if (this.sqlite.inTransaction) throw new Error("WAL checkpoint requires an idle connection");
      const oldTimeout = Number(this.sqlite.pragma("busy_timeout", { simple: true }));
      let result;
      try {
        this.sqlite.pragma("busy_timeout=50");
        result = (this.sqlite.pragma(`wal_checkpoint(${input.mode})`) as Array<{ busy: number; log: number; checkpointed: number }>)[0]!;
      } finally { this.sqlite.pragma(`busy_timeout=${oldTimeout}`); }
      if (result.busy || (result.log >= 0 && result.checkpointed < result.log)) {
        throw Object.assign(new Error("WAL checkpoint blocked by active readers; resume the same command after they finish"), { code: "SQLITE_BUSY" });
      }
      this.complete(input.commandId, { mode: input.mode, ...result });
    } else {
      const ref = `checkpoint://${checkpointName(input.name)}`;
      if (checkpointName(input.name) !== `sha256-${input.digest}.json`) throw new Error("Checkpoint filename/digest mismatch");
      if (input.retireSource) this.assertRetirementIdle();
      if (existing?.phase !== "imported") {
        const source = this.readSource(input.name, input.digest);
        const document = validateWorkerCheckpoint(JSON.parse(source.body));
        if (![2, 3].includes(document.version)) throw new Error("Legacy v1 checkpoint needs explicit identity migration");
        const run = new SqliteScenarioEventStore(this.sqlite).loadState(document.runId);
        const work = run?.workItems.find((entry) => entry.id === document.workId);
        if (!run || run.caseId !== document.caseId || work?.idempotencyKey !== document.workKey) throw new Error("Checkpoint migration attribution mismatch");
        if (input.retireSource && Date.parse(this.now()) - source.mtimeMs < this.retentionMs) throw new Error("Checkpoint retirement retention has not elapsed");
        this.sqlite.transaction(() => {
          const stored = readExecutionRow<{ document_json: string }>(this.sqlite, "checkpoint", ref);
          if (stored && stored.document_json !== source.body) throw new Error("Checkpoint migration identity conflict");
          if (!stored) this.sqlite.prepare("INSERT INTO worker_checkpoints VALUES (?, ?, ?, ?, ?, ?)")
            .run(ref, document.caseId, document.runId, document.workId, source.body, document.savedAt);
          this.sqlite.prepare("UPDATE storage_maintenance_commands SET phase='imported', updated_at=? WHERE command_id=?")
            .run(this.now(), input.commandId);
        })();
      }
      const stored = readExecutionRow<{ document_json: string }>(this.sqlite, "checkpoint", ref);
      if (!stored || hash(stored.document_json) !== input.digest) throw new Error("Imported checkpoint is missing or corrupt");
      validateWorkerCheckpoint(JSON.parse(stored.document_json));
      this.sqlite.transaction(() => {
        if (Date.parse(grant.expiresAt) <= Date.parse(this.now())) throw new Error("Storage maintenance authorization expired");
        if (input.retireSource) {
          this.assertRetirementIdle();
          try {
            const source = this.readSource(input.name, input.digest);
            if (Date.parse(this.now()) - source.mtimeMs < this.retentionMs) throw new Error("Checkpoint retirement retention has not elapsed");
            // The write lock fences new leases. Unlink follows a separately committed import, so rollback cannot lose the original ref.
            unlinkSync(source.path);
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        }
        this.complete(input.commandId, { ref, sourceRetired: input.retireSource });
      }).immediate();
    }
    return { ...this.read(input.commandId, fingerprint)!, replayed: false };
  }

  private assertRetirementIdle() {
    if (this.sqlite.prepare("SELECT 1 FROM scenario_work_leases LIMIT 1").get()) throw new Error("Active Work leases prevent legacy file retirement");
  }
  private checkedRoot() {
    const root = resolve(this.root), stat = lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(root) !== root) throw new Error("Unsafe checkpoint storage root");
    return root;
  }
  private readSource(name: string, digest: string) {
    const path = resolve(this.checkedRoot(), fileName.parse(name));
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > maximumCheckpointBytes) throw new Error("Unsafe checkpoint source or size");
      const buffer = Buffer.alloc(maximumCheckpointBytes + 1); let bytes = 0, read: number;
      while (bytes < buffer.length && (read = readSync(fd, buffer, bytes, buffer.length - bytes, null)) > 0) bytes += read;
      const after = fstatSync(fd), current = lstatSync(path);
      if (bytes > maximumCheckpointBytes || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs
        || current.isSymbolicLink() || current.ino !== stat.ino || current.dev !== stat.dev || hash(buffer.subarray(0, bytes)) !== digest) {
        throw new Error("Checkpoint source changed or digest mismatch");
      }
      const body = buffer.subarray(0, bytes).toString("utf8");
      if (hash(body) !== digest) throw new Error("Checkpoint source is not lossless UTF-8");
      return { path, body, mtimeMs: stat.mtimeMs };
    } finally { closeSync(fd); }
  }
  private read(id: string, fingerprint: string): Audit | undefined {
    const row = this.sqlite.prepare("SELECT * FROM storage_maintenance_commands WHERE command_id=?").get(id) as {
      command_id: string; fingerprint: string; request_json: string; phase: Audit["phase"]; result_json: string | null } | undefined;
    if (!row) return undefined;
    if (row.fingerprint !== fingerprint) throw new Error("Storage maintenance command conflict");
    const request = JSON.parse(row.request_json) as MaintenanceRequest;
    if (row.phase === "completed" && request.action === "migrate_checkpoint") {
      const stored = readExecutionRow<{ document_json: string }>(this.sqlite, "checkpoint", `checkpoint://${checkpointName(request.name)}`);
      if (!stored || hash(stored.document_json) !== request.digest) throw new Error("Completed migration checkpoint is missing or corrupt");
    }
    return { commandId: id, fingerprint, request, phase: row.phase, result: row.result_json ? JSON.parse(row.result_json) : null };
  }
  private complete(id: string, result: Record<string, unknown>) {
    this.sqlite.prepare("UPDATE storage_maintenance_commands SET phase='completed', result_json=?, updated_at=? WHERE command_id=?")
      .run(JSON.stringify(result), this.now(), id);
  }
}

export function registerStorageMaintenanceRoutes(app: FastifyInstance, control: StorageMaintenanceControl): void {
  const status = (error: unknown) => isExecutionStorageCapacityError(error) ? 507 : isExecutionStorageWriteError(error) ? 503
    : error instanceof z.ZodError ? 400 : error instanceof Error && error.message.includes("authorization") ? 403 : 409;
  app.get("/api/security-tools/storage/physical", async () => control.status());
  app.get("/api/security-tools/storage/legacy-checkpoints", async (_request, reply) => {
    try { return control.inventory(); } catch { return reply.code(503).send({ error: "Legacy checkpoint inventory unavailable" }); }
  });
  app.get("/api/security-tools/storage/maintenance", async (request, reply) => {
    try { return control.history(request.query); } catch (error) { return reply.code(status(error)).send({ error: "Invalid maintenance history query" }); }
  });
  app.post("/api/security-tools/storage/maintenance", async (request, reply) => {
    try { return await control.execute(request.body); }
    catch (error) { return reply.code(status(error)).send({ error: error instanceof Error ? error.message : "Storage maintenance failed" }); }
  });
}
