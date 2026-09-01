import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { canonicalJson } from "@traceforge/orchestration-core";
import { SqliteToolInvocationBindingStore } from "./worker-execution-adapters.js";
import { SqliteProcessExecutionJournal } from "./execution-process-journal.js";
import { ToolInvocationReconciliationControl } from "./tool-invocation-reconciliation.js";
import { ScenarioWorkRetryControl } from "./scenario-work-retry.js";
import { recoveryEvidenceHash } from "./tool-recovery-evidence.js";
import { executionStorageStatus, isExecutionStorageCapacityError, isExecutionStorageWriteError } from "./db/execution-storage.js";

const text = z.string().trim().min(1).max(256);
const requestSchema = z.object({
  commandId: text, actor: text, reason: z.string().trim().min(1).max(1024), idempotencyKey: text,
  resolution: z.enum(["confirmed_result", "confirmed_no_effect"]), evidence: z.unknown(), result: z.unknown().optional(),
  retry: z.object({ expectedRevision: z.number().int().nonnegative() }).strict().optional(),
}).strict().refine((value) => value.evidence !== undefined, "Evidence is required")
  .refine((value) => !value.retry || value.resolution === "confirmed_no_effect", "Existing results must not be repeated as a fresh Work");

/** Durable saga: each stage commits via its existing idempotent, independently authorized control. */
export class ToolExecutionRecoveryControl {
  constructor(
    private readonly sqlite: Database.Database,
    private readonly bindings: SqliteToolInvocationBindingStore,
    private readonly reconciliation: ToolInvocationReconciliationControl,
    private readonly workRetry: ScenarioWorkRetryControl,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly onStage?: (stage: "registered" | "reconciled" | "retried") => void,
  ) {}

  async recover(value: unknown) {
    // Normalize optional undefined values to the same JSON representation used on replay.
    const input = requestSchema.parse(JSON.parse(JSON.stringify(requestSchema.parse(value))));
    const json = canonicalJson(input);
    if (Buffer.byteLength(json) > 512 * 1024) throw new Error("Recovery command exceeds its size limit");
    const fingerprint = recoveryEvidenceHash(input);
    const previous = this.command(input.commandId);
    if (previous && previous.fingerprint !== fingerprint) throw new Error("Recovery command conflicts with its immutable request");
    if (!previous) this.sqlite.prepare("INSERT INTO tool_recovery_commands VALUES (?, ?, ?, ?, ?)")
      .run(input.commandId, fingerprint, input.idempotencyKey, json, this.now());
    this.onStage?.("registered");
    const binding = this.bindings.get(input.idempotencyKey);
    if (!binding) throw new Error("Unknown Tool Invocation");
    const stageId = `recovery:${recoveryEvidenceHash(input.commandId)}`;
    const reconciled = await this.reconciliation.reconcile({ ...input, evidence: input.evidence, commandId: `${stageId}:reconcile` });
    this.onStage?.("reconciled");
    if (!input.retry) return { commandId: input.commandId, outcome: "reconciled" as const, reconciliation: reconciled, retry: null };
    const retry = await this.workRetry.retry({
      commandId: `${stageId}:retry`, actor: input.actor, reason: input.reason,
      runId: binding.attribution.runId, workId: binding.attribution.workId, expectedRevision: input.retry.expectedRevision,
    });
    this.onStage?.("retried");
    return { commandId: input.commandId, outcome: retry.audit.outcome === "queued" ? "retry_queued" as const : "retry_blocked" as const,
      reconciliation: reconciled, retry };
  }

  async resume(commandId: string, actor: string) {
    const saved = this.command(text.parse(commandId));
    if (!saved) throw new Error("Unknown recovery command");
    const request = requestSchema.parse(JSON.parse(saved.request_json));
    if (request.actor !== actor || request.commandId !== commandId || recoveryEvidenceHash(request) !== saved.fingerprint) {
      throw new Error("Recovery command actor or stored request mismatch");
    }
    // Never starts an automatic background retry: the caller explicitly resumes this command.
    return this.recover(request);
  }

  inspect(idempotencyKey: string) {
    const key = text.parse(idempotencyKey);
    const binding = this.bindings.get(key);
    if (!binding) throw new Error("Unknown Tool Invocation");
    const execution = this.bindings.execution(key);
    const observation = new SqliteProcessExecutionJournal(this.sqlite).get(key);
    const commands = this.sqlite.prepare("SELECT command_id, created_at FROM tool_recovery_commands WHERE idempotency_key = ? ORDER BY created_at, command_id LIMIT 100")
      .all(key) as Array<{ command_id: string; created_at: string }>;
    return {
      identity: { idempotencyKey: key, invocationId: binding.invocationId, tool: binding.tool, attribution: binding.attribution },
      execution: execution ? { status: execution.status, ownerId: execution.owner_id, leaseId: execution.lease_id, updatedAt: execution.updated_at } : null,
      hasReceipt: Boolean(this.sqlite.prepare("SELECT 1 FROM worker_tool_receipts WHERE idempotency_key = ?").get(key)),
      process: observation ? { status: observation.status, cleanup: observation.cleanup, identity: observation.identity,
        launch: observation.launch ?? null, requestFingerprint: observation.requestFingerprint, updatedAt: observation.updatedAt,
        historyRetention: observation.historyRetention ?? null } : null,
      // Read model deliberately excludes raw output, environment, credentials and result bodies.
      commands: commands.map((command) => {
        const stageId = `recovery:${recoveryEvidenceHash(command.command_id)}`;
        const reconciliation = this.sqlite.prepare("SELECT outcome FROM tool_invocation_reconciliation_audits WHERE command_id = ?")
          .get(`${stageId}:reconcile`) as { outcome: string } | undefined;
        const retry = readExecutionRow<{ audit_json: string }>(this.sqlite, "retry", `${stageId}:retry`);
        return { commandId: command.command_id, createdAt: command.created_at,
          reconciliation: reconciliation?.outcome ?? "pending", retry: retry ? JSON.parse(retry.audit_json).outcome as string : "pending_or_not_requested" };
      }),
      automaticRetryAllowed: false, // Only the authorized Work retry command may decide this against current state.
    };
  }

  processHistory(value: unknown) {
    const query = z.object({ caseId: text, runId: text, after: text.optional(),
      limit: z.coerce.number().int().min(1).max(100).optional() }).strict().parse(value);
    const journal = new SqliteProcessExecutionJournal(this.sqlite);
    return { ...journal.history(query), capacity: journal.usage() };
  }

  storageStatus() { return executionStorageStatus(this.sqlite); }

  commandHistory(value: unknown) {
    const query = z.object({ caseId: text, runId: text, after: text.optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50) }).strict().parse(value);
    const rows = this.sqlite.prepare(`SELECT c.command_id, c.created_at, c.idempotency_key FROM tool_recovery_commands c
      JOIN tool_invocation_bindings b USING(idempotency_key)
      WHERE b.case_id = ? AND b.run_id = ? AND c.command_id > ? ORDER BY c.command_id LIMIT ?`)
      .all(query.caseId, query.runId, query.after ?? "", query.limit + 1) as Array<{ command_id: string; created_at: string; idempotency_key: string }>;
    return { entries: rows.slice(0, query.limit).map((row) => {
      const stageId = `recovery:${recoveryEvidenceHash(row.command_id)}`;
      const reconciliation = this.sqlite.prepare("SELECT outcome FROM tool_invocation_reconciliation_audits WHERE command_id = ?")
        .get(`${stageId}:reconcile`) as { outcome: string } | undefined;
      const retry = readExecutionRow<{ audit_json: string }>(this.sqlite, "retry", `${stageId}:retry`);
      return { commandId: row.command_id, idempotencyKey: row.idempotency_key, createdAt: row.created_at,
        reconciliation: reconciliation?.outcome ?? "pending", retry: retry ? JSON.parse(retry.audit_json).outcome as string : "pending_or_not_requested" };
    }), nextCursor: rows.length > query.limit ? rows[query.limit - 1]!.command_id : null };
  }

  private command(commandId: string) {
    return readExecutionRow<{ fingerprint: string; request_json: string }>(this.sqlite, "command", commandId);
  }
}

export function registerToolExecutionRecoveryRoutes(app: FastifyInstance, control: ToolExecutionRecoveryControl): void {
  app.get("/api/security-tools/storage", async () => control.storageStatus());
  app.get("/api/security-tools/recovery/commands", async (request, reply) => {
    try { return control.commandHistory(request.query); }
    catch (error) { return reply.code(status(error)).send({ error: error instanceof Error ? error.message : "Recovery history query failed" }); }
  });
  app.get("/api/security-tools/execution-history", async (request, reply) => {
    try { return control.processHistory(request.query); }
    catch (error) { return reply.code(status(error)).send({ error: error instanceof Error ? error.message : "Process history query failed" }); }
  });
  app.get("/api/security-tools/invocations/:idempotencyKey/recovery", async (request, reply) => {
    try { return control.inspect((request.params as { idempotencyKey: string }).idempotencyKey); }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : "Recovery query failed" }); }
  });
  app.post("/api/security-tools/invocations/:idempotencyKey/recover", async (request, reply) => {
    try { return await control.recover({ ...(request.body as object), ...(request.params as object) }); }
    catch (error) { return reply.code(status(error)).send({ error: error instanceof Error ? error.message : "Recovery failed" }); }
  });
  app.post("/api/security-tools/recovery/commands/:commandId/resume", async (request, reply) => {
    try {
      const { actor } = z.object({ actor: text }).strict().parse(request.body);
      return await control.resume((request.params as { commandId: string }).commandId, actor);
    } catch (error) { return reply.code(status(error)).send({ error: error instanceof Error ? error.message : "Recovery resume failed" }); }
  });
}
function status(error: unknown): number {
  if (isExecutionStorageCapacityError(error)) return 507;
  if (isExecutionStorageWriteError(error)) return 503;
  if (error instanceof z.ZodError) return 400;
  if (error && typeof error === "object" && "statusCode" in error && typeof error.statusCode === "number") return error.statusCode;
  return 409;
}
import { readExecutionRow } from "./db/execution-archive.js";
