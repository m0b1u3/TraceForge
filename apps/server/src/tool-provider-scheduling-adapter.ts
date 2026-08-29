import type Database from "better-sqlite3";
import type {
  ToolProviderSchedulingAuditRecord,
  ToolProviderSchedulingAuditWriter,
} from "@traceforge/worker-runtime";

export class SqliteToolProviderSchedulingAuditStore implements ToolProviderSchedulingAuditWriter {
  constructor(private readonly sqlite: Database.Database) {}

  write(record: ToolProviderSchedulingAuditRecord): void {
    this.sqlite.prepare(`
      INSERT INTO tool_provider_scheduling_audit
        (id, outcome, reason, provider_id, provider_version, tool_name, case_id, run_id, work_id,
         queued_at, decided_at, wait_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id, record.outcome, record.reason, record.identity.providerId, record.identity.providerVersion,
      record.identity.toolName, record.identity.caseId, record.identity.runId, record.identity.workId,
      record.queuedAt, record.decidedAt, record.waitMs,
    );
  }

  get(id: string): ToolProviderSchedulingAuditRecord | undefined {
    const row = this.sqlite.prepare("SELECT * FROM tool_provider_scheduling_audit WHERE id = ?").get(id) as AuditRow | undefined;
    if (!row) return undefined;
    return {
      schemaVersion: 1,
      id: row.id,
      outcome: row.outcome,
      reason: row.reason,
      identity: {
        providerId: row.provider_id,
        providerVersion: row.provider_version,
        toolName: row.tool_name,
        caseId: row.case_id,
        runId: row.run_id,
        workId: row.work_id,
      },
      queuedAt: row.queued_at,
      decidedAt: row.decided_at,
      waitMs: row.wait_ms,
    };
  }
}

interface AuditRow {
  id: string;
  outcome: ToolProviderSchedulingAuditRecord["outcome"];
  reason: ToolProviderSchedulingAuditRecord["reason"];
  provider_id: string;
  provider_version: string;
  tool_name: string;
  case_id: string;
  run_id: string;
  work_id: string;
  queued_at: string;
  decided_at: string;
  wait_ms: number;
}
