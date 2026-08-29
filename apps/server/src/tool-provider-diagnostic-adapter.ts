import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ToolProviderDiagnosticRecord, ToolProviderDiagnosticWriter } from "@traceforge/worker-runtime";

export interface ToolProviderDiagnosticSummary extends Omit<ToolProviderDiagnosticRecord, "detail"> {
  detailRetained: boolean;
  detailPurgedAt: string | null;
}

export interface ToolProviderDiagnosticDetailAuthorizer {
  authorize(input: {
    actor: string;
    purpose: string;
    diagnostic: ToolProviderDiagnosticSummary;
  }): Promise<{ decision: "allowed" | "denied"; reason: string }>;
}

export interface ToolProviderDiagnosticRetentionPolicy {
  retentionMs?: number;
  maximumRetainedRecords?: number;
  maximumRetainedDetailBytes?: number;
  cleanupBatchSize?: number;
}

export interface ToolProviderDiagnosticCleanupReport {
  id: string;
  trigger: string;
  cutoffAt: string;
  purgedRecords: number;
  reclaimedBytes: number;
  remainingRecords: number;
  remainingBytes: number;
  capacitySatisfied: boolean;
  completedAt: string;
}

export type ToolProviderDiagnosticDetailResult =
  | { status: "allowed"; diagnostic: ToolProviderDiagnosticSummary; detail: string }
  | { status: "denied" | "not_found" | "detail_purged"; reason: string };

const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_MAXIMUM_RECORDS = 10_000;
const DEFAULT_MAXIMUM_DETAIL_BYTES = 64 * 1024 * 1024;
const DEFAULT_CLEANUP_BATCH_SIZE = 100;

export class SqliteToolProviderDiagnosticStore implements ToolProviderDiagnosticWriter {
  private readonly retentionMs: number;
  private readonly maximumRetainedRecords: number;
  private readonly maximumRetainedDetailBytes: number;
  private readonly cleanupBatchSize: number;

  constructor(
    private readonly sqlite: Database.Database,
    policy: ToolProviderDiagnosticRetentionPolicy = {},
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.retentionMs = positive(policy.retentionMs ?? DEFAULT_RETENTION_MS, "retentionMs");
    this.maximumRetainedRecords = positive(policy.maximumRetainedRecords ?? DEFAULT_MAXIMUM_RECORDS, "maximumRetainedRecords");
    this.maximumRetainedDetailBytes = positive(policy.maximumRetainedDetailBytes ?? DEFAULT_MAXIMUM_DETAIL_BYTES, "maximumRetainedDetailBytes");
    this.cleanupBatchSize = positive(policy.cleanupBatchSize ?? DEFAULT_CLEANUP_BATCH_SIZE, "cleanupBatchSize");
    this.cleanup(this.now(), "startup");
  }

  write(record: ToolProviderDiagnosticRecord): void {
    this.sqlite.transaction(() => {
      this.sqlite.prepare(`
        INSERT INTO tool_provider_diagnostics
          (id, provider_id, provider_version, generation, category, summary, detail, detail_bytes,
           omitted_detail_bytes, case_id, run_id, work_id, detail_retained, detail_purged_at,
           detail_purge_reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, NULL, ?)
      `).run(
        record.id, record.provider?.id ?? null, record.provider?.version ?? null, record.provider?.generation ?? null,
        record.category, record.summary, record.detail, record.detailBytes, record.omittedDetailBytes,
        record.attribution?.caseId ?? null, record.attribution?.runId ?? null, record.attribution?.workId ?? null,
        record.createdAt,
      );
      let report = this.cleanup(this.now(), "write_enforcement");
      while (!report.capacitySatisfied && report.purgedRecords > 0) {
        report = this.cleanup(this.now(), "write_enforcement");
      }
      if (!report.capacitySatisfied) throw new Error("Tool Provider diagnostic retained-detail capacity could not be enforced");
    })();
  }

  getSummary(id: string): ToolProviderDiagnosticSummary | undefined {
    this.cleanup(this.now(), "read_enforcement");
    const row = this.row(required(id, "diagnostic id"));
    return row ? summary(row) : undefined;
  }

  listSummaries(input: { providerId?: string; runId?: string; limit?: number } = {}): ToolProviderDiagnosticSummary[] {
    this.cleanup(this.now(), "read_enforcement");
    const limit = positive(input.limit ?? 100, "summary limit");
    if (limit > 200) throw new Error("Tool Provider diagnostic summary limit cannot exceed 200");
    const clauses: string[] = [];
    const parameters: Array<string | number> = [];
    if (input.providerId) { clauses.push("provider_id = ?"); parameters.push(required(input.providerId, "provider id")); }
    if (input.runId) { clauses.push("run_id = ?"); parameters.push(required(input.runId, "run id")); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.sqlite.prepare(`
      SELECT * FROM tool_provider_diagnostics ${where} ORDER BY created_at DESC, id DESC LIMIT ?
    `).all(...parameters, limit) as DiagnosticRow[];
    return rows.map(summary);
  }

  async readDetail(
    id: string,
    access: { actor: string; purpose: string },
    authorizer: ToolProviderDiagnosticDetailAuthorizer,
  ): Promise<ToolProviderDiagnosticDetailResult> {
    const diagnosticId = required(id, "diagnostic id");
    const actor = required(access.actor, "actor");
    const purpose = required(access.purpose, "access purpose");
    this.cleanup(this.now(), "read_enforcement");
    const initial = this.row(diagnosticId);
    if (!initial) {
      this.auditAccess(diagnosticId, actor, purpose, "not_found", "Diagnostic does not exist");
      return { status: "not_found", reason: "Diagnostic does not exist" };
    }
    if (!initial.detail_retained) {
      this.auditAccess(diagnosticId, actor, purpose, "detail_purged", "Diagnostic detail is no longer retained");
      return { status: "detail_purged", reason: "Diagnostic detail is no longer retained" };
    }
    let authorization: { decision: "allowed" | "denied"; reason: string };
    try {
      authorization = await authorizer.authorize({ actor, purpose, diagnostic: summary(initial) });
      if (!(["allowed", "denied"] as const).includes(authorization.decision)) throw new Error("invalid authorization decision");
      required(authorization.reason, "authorization reason");
    } catch {
      const reason = "Diagnostic detail authorization failed closed";
      this.auditAccess(diagnosticId, actor, purpose, "denied", reason);
      return { status: "denied", reason };
    }
    const authorizationReason = authorization.reason.trim();
    if (authorization.decision !== "allowed") {
      this.auditAccess(diagnosticId, actor, purpose, "denied", authorizationReason);
      return { status: "denied", reason: authorizationReason };
    }
    return this.sqlite.transaction(() => {
      const current = this.row(diagnosticId);
      if (!current?.detail_retained) {
        const reason = "Diagnostic detail was purged before authorized read completed";
        this.auditAccess(diagnosticId, actor, purpose, "detail_purged", reason);
        return { status: "detail_purged", reason } as const;
      }
      this.auditAccess(diagnosticId, actor, purpose, "allowed", authorizationReason);
      return { status: "allowed", diagnostic: summary(current), detail: current.detail } as const;
    })();
  }

  cleanup(at = this.now(), trigger = "scheduled"): ToolProviderDiagnosticCleanupReport {
    const completedAt = validTimestamp(at, "cleanup timestamp");
    const cutoffAt = new Date(Date.parse(completedAt) - this.retentionMs).toISOString();
    return this.sqlite.transaction(() => {
      const retained = this.sqlite.prepare(`
        SELECT id, detail_bytes, created_at FROM tool_provider_diagnostics
        WHERE detail_retained = 1 ORDER BY created_at ASC, id ASC
      `).all() as Array<{ id: string; detail_bytes: number; created_at: string }>;
      let remainingRecords = retained.length;
      let remainingBytes = retained.reduce((total, row) => total + row.detail_bytes, 0);
      const selected = new Map<string, { bytes: number; reason: "expired" | "capacity" }>();
      for (const row of retained) {
        if (selected.size >= this.cleanupBatchSize) break;
        if (row.created_at <= cutoffAt) {
          selected.set(row.id, { bytes: row.detail_bytes, reason: "expired" });
          remainingRecords -= 1;
          remainingBytes -= row.detail_bytes;
        }
      }
      for (const row of retained) {
        if (selected.size >= this.cleanupBatchSize) break;
        if (remainingRecords <= this.maximumRetainedRecords && remainingBytes <= this.maximumRetainedDetailBytes) break;
        if (selected.has(row.id)) continue;
        selected.set(row.id, { bytes: row.detail_bytes, reason: "capacity" });
        remainingRecords -= 1;
        remainingBytes -= row.detail_bytes;
      }
      const purge = this.sqlite.prepare(`
        UPDATE tool_provider_diagnostics
        SET detail = '', detail_retained = 0, detail_purged_at = ?, detail_purge_reason = ?
        WHERE id = ? AND detail_retained = 1
      `);
      let purgedRecords = 0;
      let reclaimedBytes = 0;
      for (const [id, candidate] of selected) {
        if (purge.run(completedAt, candidate.reason, id).changes === 1) {
          purgedRecords += 1;
          reclaimedBytes += candidate.bytes;
        }
      }
      const capacitySatisfied = remainingRecords <= this.maximumRetainedRecords
        && remainingBytes <= this.maximumRetainedDetailBytes;
      const report: ToolProviderDiagnosticCleanupReport = {
        id: randomUUID(), trigger: required(trigger, "cleanup trigger"), cutoffAt, purgedRecords, reclaimedBytes,
        remainingRecords, remainingBytes, capacitySatisfied, completedAt,
      };
      if (purgedRecords > 0 || !capacitySatisfied || trigger === "scheduled") this.auditCleanup(report);
      return report;
    })();
  }

  listAccessAudit(diagnosticId: string): DiagnosticAccessAuditRow[] {
    return this.sqlite.prepare(`
      SELECT id, diagnostic_id, actor, purpose, decision, decision_reason, requested_at
      FROM tool_provider_diagnostic_access_audit WHERE diagnostic_id = ? ORDER BY requested_at, rowid
    `).all(required(diagnosticId, "diagnostic id")) as DiagnosticAccessAuditRow[];
  }

  private row(id: string): DiagnosticRow | undefined {
    return this.sqlite.prepare("SELECT * FROM tool_provider_diagnostics WHERE id = ?").get(id) as DiagnosticRow | undefined;
  }

  private auditAccess(diagnosticId: string, actor: string, purpose: string, decision: DiagnosticAccessAuditRow["decision"], reason: string): void {
    this.sqlite.prepare(`
      INSERT INTO tool_provider_diagnostic_access_audit
        (id, diagnostic_id, actor, purpose, decision, decision_reason, requested_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), diagnosticId, actor, purpose, decision, reason, this.now());
  }

  private auditCleanup(report: ToolProviderDiagnosticCleanupReport): void {
    this.sqlite.prepare(`
      INSERT INTO tool_provider_diagnostic_cleanup_audit
        (id, trigger, cutoff_at, purged_records, reclaimed_bytes, remaining_records,
         remaining_bytes, capacity_satisfied, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      report.id, report.trigger, report.cutoffAt, report.purgedRecords, report.reclaimedBytes,
      report.remainingRecords, report.remainingBytes, report.capacitySatisfied ? 1 : 0, report.completedAt,
    );
  }
}

interface DiagnosticRow {
  id: string;
  provider_id: string | null;
  provider_version: string | null;
  generation: number | null;
  category: ToolProviderDiagnosticRecord["category"];
  summary: string;
  detail: string;
  detail_bytes: number;
  omitted_detail_bytes: number;
  case_id: string | null;
  run_id: string | null;
  work_id: string | null;
  detail_retained: 0 | 1;
  detail_purged_at: string | null;
  detail_purge_reason: string | null;
  created_at: string;
}

export interface DiagnosticAccessAuditRow {
  id: string;
  diagnostic_id: string;
  actor: string;
  purpose: string;
  decision: "allowed" | "denied" | "not_found" | "detail_purged";
  decision_reason: string;
  requested_at: string;
}

function summary(row: DiagnosticRow): ToolProviderDiagnosticSummary {
  return {
    schemaVersion: 1, id: row.id,
    provider: row.provider_id && row.provider_version && row.generation !== null
      ? { id: row.provider_id, version: row.provider_version, generation: row.generation } : null,
    category: row.category, summary: row.summary, detailBytes: row.detail_bytes,
    omittedDetailBytes: row.omitted_detail_bytes,
    attribution: row.case_id && row.run_id && row.work_id
      ? { caseId: row.case_id, runId: row.run_id, workId: row.work_id } : null,
    detailRetained: Boolean(row.detail_retained), detailPurgedAt: row.detail_purged_at, createdAt: row.created_at,
  };
}

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`Tool Provider diagnostic ${label} is required`);
  return normalized;
}

function positive(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Tool Provider diagnostic ${label} must be a positive integer`);
  return value;
}

function validTimestamp(value: string, label: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`Tool Provider diagnostic ${label} must be an ISO timestamp`);
  return new Date(timestamp).toISOString();
}
