import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { ScenarioAuthorizationPort } from "@traceforge/scenario-sdk";
import type {
  ProviderCapabilityApprovalPort,
  ProviderCapabilityReceipt,
  ProviderCapabilityReceiptPort,
  ProviderCapabilityScopeAuthorizationPort,
} from "@traceforge/worker-runtime";

const receiptSchema = z.object({
  id: z.string().min(1),
  provider: z.object({ id: z.string().min(1), version: z.string().min(1), generation: z.number().int().min(1) }).strict(),
  parentRequestId: z.string().min(1),
  capability: z.string().min(1),
  action: z.string().min(1),
  idempotencyKey: z.string().min(1),
  inputFingerprint: z.string().min(1),
  attribution: z.object({
    workerId: z.string().min(1), runId: z.string().min(1), workId: z.string().min(1),
    caseId: z.string().min(1), scopeRef: z.string().min(1), leaseId: z.string().min(1),
    leaseExpiresAt: z.string().min(1), idempotencyKey: z.string().min(1),
  }).strict(),
  status: z.enum(["succeeded", "failed", "rejected", "approval_required"]),
  authorizationRef: z.string().min(1).optional(),
  approvalRef: z.string().min(1).optional(),
  reason: z.string().optional(),
  output: z.unknown().optional(),
  refs: z.array(z.string().min(1)),
  requestBytes: z.number().int().min(0),
  responseBytes: z.number().int().min(0),
  retryable: z.boolean(),
  startedAt: z.string().min(1),
  completedAt: z.string().min(1),
  replayed: z.boolean().optional(),
}).strict();

export class SqliteProviderCapabilityReceiptStore implements ProviderCapabilityReceiptPort {
  constructor(private readonly sqlite: Database.Database) {}

  async get(providerId: string, idempotencyKey: string): Promise<ProviderCapabilityReceipt | undefined> {
    const row = this.sqlite.prepare(`
      SELECT receipt_json FROM provider_capability_receipts
      WHERE provider_id = ? AND idempotency_key = ?
      ORDER BY completed_at DESC, rowid DESC LIMIT 1
    `).get(providerId, idempotencyKey) as { receipt_json: string } | undefined;
    return row ? receiptSchema.parse(JSON.parse(row.receipt_json)) as ProviderCapabilityReceipt : undefined;
  }

  async put(receipt: ProviderCapabilityReceipt): Promise<void> {
    const durable = receiptSchema.parse(receipt) as ProviderCapabilityReceipt;
    this.sqlite.prepare(`
      INSERT INTO provider_capability_receipts
        (id, provider_id, provider_version, provider_generation, idempotency_key, input_fingerprint,
         status, case_id, run_id, work_id, worker_id, scope_ref, lease_id, capability, action,
         receipt_json, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      durable.id, durable.provider.id, durable.provider.version, durable.provider.generation,
      durable.idempotencyKey, durable.inputFingerprint, durable.status,
      durable.attribution.caseId, durable.attribution.runId, durable.attribution.workId,
      durable.attribution.workerId, durable.attribution.scopeRef, durable.attribution.leaseId,
      durable.capability, durable.action, JSON.stringify(durable), durable.completedAt,
    );
  }
}

export class ScenarioProviderCapabilityScopeAuthorizer implements ProviderCapabilityScopeAuthorizationPort {
  constructor(private readonly authorizations: ScenarioAuthorizationPort) {}

  async authorize(input: Parameters<ProviderCapabilityScopeAuthorizationPort["authorize"]>[0]) {
    try {
      const authorization = this.authorizations.requireAction(
        input.invocation.attribution.scopeRef,
        input.invocation.attribution.caseId,
        input.invocation.action,
      );
      return { decision: "approved" as const, authorizationRef: authorization.id };
    } catch (error) {
      return {
        decision: "rejected" as const,
        reason: error instanceof Error ? error.message : "Scenario scope rejected Provider capability",
      };
    }
  }
}

interface ApprovalRow {
  id: string;
  status: "pending" | "approved" | "rejected" | "cancelled";
  resolution_reason: string | null;
}

/** Reads the existing Work approval lifecycle; it never writes projection rows directly. */
export class SqliteProviderCapabilityApprovalReader implements ProviderCapabilityApprovalPort {
  constructor(private readonly sqlite: Database.Database) {}

  async authorize(input: Parameters<ProviderCapabilityApprovalPort["authorize"]>[0]) {
    const { invocation } = input;
    const approvalId = this.approvalId(
      invocation.provider.id,
      invocation.attribution.runId,
      invocation.attribution.workId,
      invocation.idempotencyKey,
    );
    const row = this.sqlite.prepare(`
      SELECT id, status, resolution_reason FROM scenario_work_approvals
      WHERE id = ? AND run_id = ? AND work_id = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(
      approvalId,
      invocation.attribution.runId,
      invocation.attribution.workId,
    ) as ApprovalRow | undefined;
    if (!row) {
      return {
        decision: "pending" as const,
        approvalRef: approvalId,
        reason: `Provider capability ${invocation.capability} requires durable Work approval`,
      };
    }
    if (row.status === "approved") return { decision: "approved" as const, approvalRef: row.id };
    if (row.status === "pending") return { decision: "pending" as const, approvalRef: row.id };
    return {
      decision: "rejected" as const,
      approvalRef: row.id,
      reason: row.resolution_reason ?? `Provider capability approval ${row.status}`,
    };
  }

  private approvalId(providerId: string, runId: string, workId: string, idempotencyKey: string): string {
    const digest = createHash("sha256").update(`${providerId}\0${runId}\0${workId}\0${idempotencyKey}`).digest("hex");
    return `provider-capability-approval:${digest}`;
  }
}
