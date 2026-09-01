import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { canonicalJson, type ScenarioRunState } from "@traceforge/orchestration-core";
import { validateToolProviderResult, validateWorkerCheckpoint } from "@traceforge/worker-runtime";
import { archiveExecutionRow, archiveStores, readExecutionRow, type ArchiveKind } from "./db/execution-archive.js";
import { isExecutionStorageCapacityError, isExecutionStorageWriteError } from "./db/execution-storage.js";
import { SqliteScenarioEventStore } from "./scenario-event-store.js";
import { SqliteProcessExecutionJournal } from "./execution-process-journal.js";

const sha = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const text = z.string().trim().min(1).max(256);
const entrySchema = z.object({ kind: z.enum(["receipt", "process", "command", "evidence", "reconciliation", "retry", "checkpoint"]),
  key: z.string().min(1).refine((value) => Buffer.byteLength(value) <= 1024, "Archive key exceeds its size limit") }).strict();
const requestSchema = z.object({ commandId: text, actor: text, reason: z.string().trim().min(1).max(1024), caseId: text, runId: text,
  expectedRevision: z.number().int().nonnegative(), entries: z.array(entrySchema).min(1).max(32) }).strict()
  .refine((value) => new Set(value.entries.map((entry) => JSON.stringify(entry))).size === value.entries.length, "Duplicate archive entries");
type ArchiveRequest = z.infer<typeof requestSchema>;
export interface ExecutionArchiveAuthorizer {
  authorize(input: ArchiveRequest & { run: ScenarioRunState }): Promise<
    { decision: "allowed"; authorizationRef: string; expiresAt: string } | { decision: "denied" }>;
}
interface ArchiveAudit extends ArchiveRequest {
  outcome: "archived" | "denied" | "rejected"; authorizationRef: string | null; failure: string | null; at: string;
  results: Array<{ kind: ArchiveKind; key: string; originalBytes: number; compressedBytes: number; replayed: boolean }>;
}

export class ExecutionArchiveControl {
  constructor(private readonly sqlite: Database.Database,
    private readonly authorizer: ExecutionArchiveAuthorizer = { async authorize() { return { decision: "denied" }; } },
    private readonly now: () => string = () => new Date().toISOString(), private readonly minimumRetentionMs = 86400000,
  ) {
    if (!Number.isSafeInteger(minimumRetentionMs) || minimumRetentionMs < 0) throw new Error("Invalid archive retention");
  }

  async archive(value: unknown): Promise<{ audit: ArchiveAudit; replayed: boolean }> {
    const input = requestSchema.parse(value); const fingerprint = sha(input);
    const existing = this.replay(input.commandId, fingerprint); if (existing) return existing;
    const run = this.run(input.runId);
    if (run.caseId !== input.caseId) throw new Error("Archive Case/Run mismatch");
    let grant: Awaited<ReturnType<ExecutionArchiveAuthorizer["authorize"]>>;
    try {
      grant = await this.authorizer.authorize({ ...structuredClone(input), run: structuredClone(run) });
      if (grant?.decision !== "allowed" || !grant.authorizationRef?.trim() || !Number.isFinite(Date.parse(grant.expiresAt))) grant = { decision: "denied" };
    } catch { grant = { decision: "denied" }; }
    const raced = this.replay(input.commandId, fingerprint); if (raced) return raced;
    const audit: ArchiveAudit = { ...input, outcome: "denied", authorizationRef: null, failure: "Execution archive authorization denied", at: this.now(), results: [] };
    if (grant.decision !== "allowed") { this.insert(audit, fingerprint); return { audit, replayed: false }; }
    audit.authorizationRef = grant.authorizationRef;
    try {
      this.sqlite.transaction(() => {
        audit.at = this.now();
        if (Date.parse(grant.expiresAt) <= Date.parse(audit.at)) throw new Error("Execution archive authorization expired");
        const current = this.run(input.runId);
        if (current.caseId !== input.caseId || current.revision !== input.expectedRevision) throw new Error("Archive Run revision or attribution changed");
        this.assertClosed(current, audit.at);
        let bytes = 0;
        for (const entry of input.entries) {
          const row = readExecutionRow(this.sqlite, entry.kind, entry.key);
          if (!row) throw new Error("Unknown archive source");
          bytes += Buffer.byteLength(JSON.stringify(row));
          if (bytes > 16 * 1024 * 1024) throw new Error("Archive batch exceeds its 16 MiB input limit");
          this.assertAttribution(entry.kind, entry.key, row, current);
        }
        audit.results = input.entries.map((entry) => ({ ...entry, ...archiveExecutionRow(this.sqlite, entry.kind, entry.key, audit.at) }));
        audit.outcome = "archived"; audit.failure = null;
        this.insert(audit, fingerprint);
      })();
      return { audit, replayed: false };
    } catch (error) {
      const committed = this.replay(input.commandId, fingerprint); if (committed) return committed;
      if (isExecutionStorageCapacityError(error) || isExecutionStorageWriteError(error)) throw error;
      audit.outcome = "rejected"; audit.results = []; audit.failure = (error instanceof Error ? error.message : "Archive failed").slice(0, 1024);
      this.insert(audit, fingerprint); return { audit, replayed: false };
    }
  }

  history(value: unknown) {
    const input = z.object({ caseId: text, runId: text, after: text.optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).strict().parse(value);
    const rows = this.sqlite.prepare(`SELECT command_id, audit_json FROM execution_archive_commands
      WHERE json_extract(audit_json, '$.caseId') = ? AND json_extract(audit_json, '$.runId') = ? AND command_id > ? ORDER BY command_id LIMIT ?`)
      .all(input.caseId, input.runId, input.after ?? "", input.limit + 1) as Array<{ command_id: string; audit_json: string }>;
    return { entries: rows.slice(0, input.limit).map((row) => {
      const audit = JSON.parse(row.audit_json) as ArchiveAudit;
      return { commandId: audit.commandId, outcome: audit.outcome, at: audit.at, entries: audit.entries, results: audit.results };
    }), nextCursor: rows.length > input.limit ? rows[input.limit - 1]!.command_id : null };
  }

  candidates(value: unknown) {
    const input = z.object({ caseId: text, runId: text, kind: entrySchema.shape.kind,
      after: z.string().max(1024).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).strict().parse(value);
    const run = this.run(input.runId);
    if (run.caseId !== input.caseId) throw new Error("Archive Case/Run mismatch");
    this.assertClosed(run, this.now());
    const store = archiveStores[input.kind];
    let join = ""; let scope: string;
    if (input.kind === "checkpoint") scope = "s.case_id = ? AND s.run_id = ?";
    else if (input.kind === "retry") scope = "json_extract(CASE WHEN json_valid(s.audit_json) THEN s.audit_json ELSE '{}' END, '$.runId') = ?";
    else if (input.kind === "evidence") scope = "json_extract(CASE WHEN json_valid(s.envelope_json) THEN s.envelope_json ELSE '{}' END, '$.assertion.identity.attribution.caseId') = ? AND json_extract(CASE WHEN json_valid(s.envelope_json) THEN s.envelope_json ELSE '{}' END, '$.assertion.identity.attribution.runId') = ?";
    else { join = "JOIN tool_invocation_bindings b ON b.idempotency_key = s.idempotency_key"; scope = "b.case_id = ? AND b.run_id = ?"; }
    const rows = this.sqlite.prepare(`SELECT s.${store.key} AS entry_key FROM ${store.table} s ${join}
      WHERE ${scope} AND s.${store.key} > ? AND NOT EXISTS (
        SELECT 1 FROM execution_archives a WHERE a.kind = ? AND a.entry_key = s.${store.key}) ORDER BY s.${store.key} LIMIT ?`)
      .all(...(input.kind === "retry" ? [input.runId] : [input.caseId, input.runId]), input.after ?? "", input.kind, input.limit + 1) as Array<{ entry_key: string }>;
    return { expectedRevision: run.revision, entries: rows.slice(0, input.limit).map((row) => ({ kind: input.kind, key: row.entry_key })),
      nextCursor: rows.length > input.limit ? rows[input.limit - 1]!.entry_key : null };
  }

  private assertClosed(run: ScenarioRunState, at: string): void {
    if (!["completed", "cancelled"].includes(run.status)) throw new Error("Only terminal Runs can be archived");
    if (Date.parse(at) - Date.parse(run.updatedAt) < this.minimumRetentionMs) throw new Error("Run archive retention has not elapsed");
    if (this.sqlite.prepare("SELECT 1 FROM scenario_work_leases WHERE run_id = ? LIMIT 1").get(run.id)) throw new Error("Active leases prevent archive");
    const unresolved = this.sqlite.prepare(`SELECT 1 FROM tool_invocation_bindings b LEFT JOIN tool_invocation_executions e USING(idempotency_key)
      WHERE b.run_id = ? AND (e.idempotency_key IS NULL OR e.status IN ('executing','uncertain')
        OR (e.status = 'prepared' AND b.status != 'released')
        OR (e.status = 'completed' AND NOT EXISTS(SELECT 1 FROM worker_tool_receipts r WHERE r.idempotency_key = b.idempotency_key)
          AND NOT EXISTS(SELECT 1 FROM tool_invocation_reconciliation_audits a WHERE a.idempotency_key = b.idempotency_key
            AND a.outcome = 'resolved' AND a.requested_resolution = 'confirmed_no_effect'))) LIMIT 1`).get(run.id);
    if (unresolved) throw new Error("Unresolved invocation prevents Run archive");
  }

  private assertAttribution(kind: ArchiveKind, key: string, row: Record<string, string | number | null>, run: ScenarioRunState): void {
    let caseId: unknown; let runId: unknown; let workId: unknown;
    if (kind === "checkpoint") {
      const body = String(row.document_json); const document = validateWorkerCheckpoint(JSON.parse(body));
      if (key !== `checkpoint://sha256-${createHash("sha256").update(body).digest("hex")}.json`) throw new Error("Checkpoint digest mismatch");
      caseId = document.caseId; runId = document.runId; workId = document.workId;
      if (caseId !== row.case_id || runId !== row.run_id || workId !== row.work_id) throw new Error("Checkpoint index mismatch");
    } else if (kind === "retry") {
      const audit = JSON.parse(String(row.audit_json)); caseId = run.caseId; runId = audit.runId; workId = audit.workId;
    } else if (kind === "evidence") {
      const envelope = JSON.parse(String(row.envelope_json));
      if (key !== `recovery-evidence:${sha(envelope)}`) throw new Error("Evidence digest mismatch");
      ({ caseId, runId, workId } = envelope.assertion.identity.attribution);
    } else {
      const invocationKey = kind === "receipt" || kind === "process" ? key : String(row.idempotency_key);
      const binding = this.sqlite.prepare("SELECT case_id, run_id, work_id FROM tool_invocation_bindings WHERE idempotency_key = ?")
        .get(invocationKey) as { case_id: string; run_id: string; work_id: string } | undefined;
      if (!binding) throw new Error("Archive source has no invocation binding");
      caseId = binding.case_id; runId = binding.run_id; workId = binding.work_id;
      if (kind === "receipt") validateToolProviderResult(JSON.parse(String(row.result_json)));
      if (kind === "process") {
        const observation = new SqliteProcessExecutionJournal(this.sqlite).get(key)!;
        if (observation.status === "claimed") throw new Error("Unsettled process observation cannot be archived");
        if (observation.identity.caseId !== caseId || observation.identity.runId !== runId || observation.identity.workId !== workId) throw new Error("Process attribution mismatch");
      }
      if (kind === "command") {
        const request = JSON.parse(String(row.request_json)); const stage = `recovery:${sha(key)}`;
        if (request.commandId !== key || request.idempotencyKey !== invocationKey || sha(request) !== row.fingerprint) throw new Error("Recovery command integrity mismatch");
        if (!this.sqlite.prepare("SELECT 1 FROM tool_invocation_reconciliation_audits WHERE command_id = ?").get(`${stage}:reconcile`)
          || (request.retry && !this.sqlite.prepare("SELECT 1 FROM scenario_work_retry_audits WHERE command_id = ?").get(`${stage}:retry`))) {
          throw new Error("Unfinished recovery command cannot be archived");
        }
      }
    }
    if (caseId !== run.caseId || runId !== run.id || !run.workItems.some((work) => work.id === workId)) throw new Error("Archive source attribution mismatch");
  }

  private run(id: string): ScenarioRunState {
    const run = new SqliteScenarioEventStore(this.sqlite).loadState(id);
    if (!run) throw new Error("Unknown archive Run"); return run;
  }
  private replay(id: string, fingerprint: string) {
    const row = this.sqlite.prepare("SELECT fingerprint, audit_json FROM execution_archive_commands WHERE command_id = ?").get(id) as { fingerprint: string; audit_json: string } | undefined;
    if (!row) return undefined;
    if (row.fingerprint !== fingerprint) throw new Error("Archive command conflicts with its recorded request");
    const audit = JSON.parse(row.audit_json) as ArchiveAudit;
    if (audit.outcome === "archived") for (const entry of audit.entries) {
      if (!readExecutionRow(this.sqlite, entry.kind, entry.key)) throw new Error("Archived command source is missing");
    }
    return { audit, replayed: true };
  }
  private insert(audit: ArchiveAudit, fingerprint: string) {
    const json = JSON.stringify(audit);
    if (Buffer.byteLength(json) > 65536) throw new Error("Archive audit exceeds its size limit");
    this.sqlite.prepare("INSERT INTO execution_archive_commands VALUES (?, ?, ?)").run(audit.commandId, fingerprint, json);
  }
}

export function registerExecutionArchiveRoutes(app: FastifyInstance, control: ExecutionArchiveControl): void {
  app.get("/api/security-tools/storage/archive-candidates", async (request, reply) => {
    try { return control.candidates(request.query); }
    catch (error) { return reply.code(status(error)).send({ error: error instanceof Error ? error.message : "Archive candidates failed" }); }
  });
  app.post("/api/security-tools/storage/archive", async (request, reply) => {
    try { const result = await control.archive(request.body);
      return reply.code(result.audit.outcome === "archived" ? 200 : result.audit.outcome === "denied" ? 403 : 409).send(result);
    } catch (error) { return reply.code(status(error)).send({ error: error instanceof Error ? error.message : "Archive failed" }); }
  });
  app.get("/api/security-tools/storage/archives", async (request, reply) => {
    try { return control.history(request.query); }
    catch (error) { return reply.code(status(error)).send({ error: error instanceof Error ? error.message : "Archive history failed" }); }
  });
}
function status(error: unknown) { return isExecutionStorageCapacityError(error) ? 507 : isExecutionStorageWriteError(error) ? 503 : error instanceof z.ZodError ? 400 : 409; }
