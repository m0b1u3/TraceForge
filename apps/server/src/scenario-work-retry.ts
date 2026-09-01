import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  canonicalJson, DurableScenarioRuntime, type ScenarioDefinitionRegistry, type ScenarioRunBindingValidator,
  type ScenarioRunState,
} from "@traceforge/orchestration-core";
import type { BlackboardChangeBus } from "@traceforge/cognitive-runtime";
import { SqliteScenarioEventStore } from "./scenario-event-store.js";
import { isExecutionStorageCapacityError, isExecutionStorageWriteError } from "./db/execution-storage.js";

export interface ScenarioWorkRetryAuthorizer {
  authorize(input: { actor: string; reason: string; workId: string; run: ScenarioRunState }): Promise<
    | { decision: "allowed"; authorizationRef: string; expiresAt: string }
    | { decision: "denied" }
  >;
}

const requestSchema = z.object({
  runId: z.string().trim().min(1).max(256), workId: z.string().trim().min(1).max(256),
  commandId: z.string().trim().min(1).max(256), actor: z.string().trim().min(1).max(256),
  reason: z.string().trim().min(1).max(1024), expectedRevision: z.number().int().nonnegative(),
}).strict();
type RetryRequest = z.infer<typeof requestSchema>;
export interface WorkRetryAudit extends RetryRequest {
  outcome: "queued" | "denied" | "rejected";
  authorizationRef: string | null;
  replacementWorkId: string | null;
  failure: string | null;
  at: string;
}

/** Separate runtime has no pre-commit change notifications: publish only after the outer transaction commits. */
export class ScenarioWorkRetryControl {
  private readonly runtime: DurableScenarioRuntime;
  constructor(
    private readonly sqlite: Database.Database,
    definitions: ScenarioDefinitionRegistry,
    bindingValidator?: ScenarioRunBindingValidator,
    private readonly authorizer: ScenarioWorkRetryAuthorizer = { async authorize() { return { decision: "denied" }; } },
    private readonly changes?: BlackboardChangeBus,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.runtime = new DurableScenarioRuntime(new SqliteScenarioEventStore(sqlite), definitions, bindingValidator);
  }

  async retry(value: unknown): Promise<{ audit: WorkRetryAudit; replayed: boolean }> {
    const input = requestSchema.parse(value);
    const fingerprint = canonicalJson(input);
    const previous = this.replay(input.commandId, fingerprint);
    if (previous) return previous;
    const state = this.runtime.load(input.runId);
    if (!state) throw new Error("Unknown Run");
    let grant: Awaited<ReturnType<ScenarioWorkRetryAuthorizer["authorize"]>>;
    try {
      grant = await this.authorizer.authorize({ actor: input.actor, reason: input.reason, workId: input.workId, run: structuredClone(state) });
      if (grant?.decision !== "allowed" || !grant.authorizationRef?.trim() || !Number.isFinite(Date.parse(grant.expiresAt))) {
        grant = { decision: "denied" };
      }
    } catch { grant = { decision: "denied" }; }
    const raced = this.replay(input.commandId, fingerprint);
    if (raced) return raced;
    if (grant.decision !== "allowed") {
      const audit: WorkRetryAudit = { ...input, outcome: "denied", authorizationRef: null, replacementWorkId: null, failure: "Work retry authorization denied", at: this.now() };
      this.insert(audit, fingerprint);
      return { audit, replayed: false };
    }
    const authorized = grant;
    const replacementWorkId = `retry_${createHash("sha256").update(fingerprint).digest("hex")}`;
    try {
      const result = this.sqlite.transaction(() => {
        const at = this.now();
        if (Date.parse(authorized.expiresAt) <= Date.parse(at)) throw new Error("Work retry authorization expired");
        this.assertNoEffects(input.runId, input.workId);
        const result = this.runtime.execute({
          runId: input.runId, commandId: `work-retry:${input.commandId}`, expectedRevision: input.expectedRevision,
          command: { type: "retry_blocked_work", workId: input.workId, replacementWorkId,
            idempotencyKey: `work:${replacementWorkId}`, authorizationRef: authorized.authorizationRef, reason: input.reason, at },
        });
        // Fence never-started invocations before the replacement can become visible to Workers.
        this.sqlite.prepare(`UPDATE tool_invocation_bindings SET status = 'released', release_reason = 'Original Work superseded by authorized retry', updated_at = ?
          WHERE run_id = ? AND work_id = ? AND status = 'prepared'`).run(at, input.runId, input.workId);
        const audit: WorkRetryAudit = { ...input, outcome: "queued", authorizationRef: authorized.authorizationRef,
          replacementWorkId, failure: null, at };
        this.insert(audit, fingerprint);
        return { result, audit };
      })();
      this.changes?.publish({ kind: "run", runId: input.runId, caseId: result.result.state.caseId,
        revision: result.result.state.revision, eventTypes: result.result.events.map((event) => event.type), at: result.audit.at });
      return { audit: result.audit, replayed: false };
    } catch (error) {
      // A post-commit notifier error cannot change a committed command into a rejected one.
      const committed = this.replay(input.commandId, fingerprint);
      if (committed) return committed;
      if (isExecutionStorageCapacityError(error) || isExecutionStorageWriteError(error)) throw error;
      const audit: WorkRetryAudit = { ...input, outcome: "rejected", authorizationRef: authorized.authorizationRef,
        replacementWorkId: null, failure: (error instanceof Error ? error.message : "Retry failed").slice(0, 1024), at: this.now() };
      this.insert(audit, fingerprint);
      return { audit, replayed: false };
    }
  }

  private assertNoEffects(runId: string, workId: string): void {
    if (this.sqlite.prepare("SELECT 1 FROM scenario_work_leases WHERE run_id = ? AND work_id = ?").get(runId, workId)) throw new Error("Active Work lease prevents retry");
    const unresolved = this.sqlite.prepare(`SELECT 1 FROM tool_invocation_bindings b
      LEFT JOIN tool_invocation_executions e ON e.idempotency_key = b.idempotency_key
      WHERE b.run_id = ? AND b.work_id = ? AND (
        e.idempotency_key IS NULL OR e.status IN ('executing', 'uncertain')
        OR EXISTS (SELECT 1 FROM worker_tool_receipts r WHERE r.idempotency_key = b.idempotency_key)
        OR (e.status = 'completed' AND NOT EXISTS (
          SELECT 1 FROM tool_invocation_reconciliation_audits a WHERE a.idempotency_key = b.idempotency_key
          AND a.outcome = 'resolved' AND a.requested_resolution = 'confirmed_no_effect'))
      ) LIMIT 1`).get(runId, workId);
    if (unresolved) throw new Error("Retry requires every started invocation to be confirmed free of external effects; existing results cannot be repeated");
  }

  private replay(commandId: string, fingerprint: string) {
    const row = readExecutionRow<{ fingerprint: string; audit_json: string }>(this.sqlite, "retry", commandId);
    if (!row) return undefined;
    if (row.fingerprint !== fingerprint) throw new Error("Work retry command conflicts with its recorded request");
    return { audit: JSON.parse(row.audit_json) as WorkRetryAudit, replayed: true };
  }
  private insert(audit: WorkRetryAudit, fingerprint: string): void {
    this.sqlite.prepare("INSERT INTO scenario_work_retry_audits VALUES (?, ?, ?)").run(audit.commandId, fingerprint, JSON.stringify(audit));
  }
}

export function registerScenarioWorkRetryRoutes(app: FastifyInstance, control: ScenarioWorkRetryControl): void {
  app.post("/api/scenarios/runs/:runId/work/:workId/retry", async (request, reply) => {
    try {
      const result = await control.retry({ ...(request.body as object), ...(request.params as object) });
      return reply.code(result.audit.outcome === "queued" ? 200 : result.audit.outcome === "denied" ? 403 : 409).send(result);
    } catch (error) {
      return reply.code(isExecutionStorageCapacityError(error) ? 507 : isExecutionStorageWriteError(error) ? 503 : error instanceof z.ZodError ? 400 : 409).send({ error: error instanceof Error ? error.message : "Work retry failed" });
    }
  });
}
import { readExecutionRow } from "./db/execution-archive.js";
