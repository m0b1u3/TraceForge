import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { canonicalJson, DurableScenarioRuntime, type ScenarioDefinitionRegistry, type ScenarioRunBindingValidator,
  type ScenarioRunState } from "@traceforge/orchestration-core";
import { defaultWorkerRuntimeOptions, toolInvocationInputFingerprint, validateWorkerCheckpoint, workerCheckpointJournal, type WorkerAssignment,
  type WorkerCheckpointStore } from "@traceforge/worker-runtime";
import type { BlackboardChangeBus } from "@traceforge/cognitive-runtime";
import { SqliteScenarioEventStore } from "./scenario-event-store.js";
import { SqliteToolInvocationBindingStore } from "./worker-execution-adapters.js";
import { ExecutionStorageWriteError, isExecutionStorageCapacityError, isExecutionStorageWriteError } from "./db/execution-storage.js";

export interface ScenarioWorkContinuationAuthorizer {
  authorize(input: { actor: string; reason: string; workId: string; checkpointRef: string; run: ScenarioRunState }): Promise<
    { decision: "allowed"; authorizationRef: string; expiresAt: string } | { decision: "denied" }
  >;
}
const requestSchema = z.object({
  runId: z.string().trim().min(1).max(256), workId: z.string().trim().min(1).max(256),
  commandId: z.string().trim().min(1).max(256), actor: z.string().trim().min(1).max(256),
  reason: z.string().trim().min(1).max(1024), expectedRevision: z.number().int().nonnegative(),
  checkpointRef: z.string().regex(/^checkpoint:\/\/sha256-[a-f0-9]{64}\.json$/),
}).strict();
type ContinuationRequest = z.infer<typeof requestSchema>;
export interface WorkContinuationAudit extends ContinuationRequest {
  operation: "continue"; outcome: "queued" | "denied" | "rejected";
  authorizationRef: string | null; failure: string | null; at: string;
}

/** Same Work/key, unlike whole-Work retry. Audit shares the bounded immutable Work-recovery ledger. */
export class ScenarioWorkContinuationControl {
  private readonly runtime: DurableScenarioRuntime;
  private readonly bindings: SqliteToolInvocationBindingStore;
  constructor(
    private readonly sqlite: Database.Database,
    definitions: ScenarioDefinitionRegistry,
    private readonly checkpoints: WorkerCheckpointStore,
    bindingValidator?: ScenarioRunBindingValidator,
    private readonly authorizer: ScenarioWorkContinuationAuthorizer = { async authorize() { return { decision: "denied" }; } },
    private readonly changes?: BlackboardChangeBus,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.runtime = new DurableScenarioRuntime(new SqliteScenarioEventStore(sqlite), definitions, bindingValidator);
    this.bindings = new SqliteToolInvocationBindingStore(sqlite, now);
  }

  async continue(value: unknown): Promise<{ audit: WorkContinuationAudit; replayed: boolean }> {
    const input = requestSchema.parse(value);
    const fingerprint = canonicalJson({ operation: "continue", ...input });
    const previous = this.replay(input.commandId, fingerprint);
    if (previous) return previous;
    const state = this.runtime.load(input.runId);
    if (!state) throw new Error("Unknown Run");
    let grant: Awaited<ReturnType<ScenarioWorkContinuationAuthorizer["authorize"]>>;
    try {
      grant = await this.authorizer.authorize({ actor: input.actor, reason: input.reason, workId: input.workId,
        checkpointRef: input.checkpointRef, run: structuredClone(state) });
      if (grant?.decision !== "allowed" || !grant.authorizationRef?.trim() || !Number.isFinite(Date.parse(grant.expiresAt))) grant = { decision: "denied" };
    } catch { grant = { decision: "denied" }; }
    const raced = this.replay(input.commandId, fingerprint);
    if (raced) return raced;
    const audit: WorkContinuationAudit = { ...input, operation: "continue", outcome: "denied", authorizationRef: null,
      failure: "Work continuation authorization denied", at: this.now() };
    if (grant.decision !== "allowed") { this.insert(audit, fingerprint); return { audit, replayed: false }; }
    audit.authorizationRef = grant.authorizationRef;
    try {
      const checkpoint = validateWorkerCheckpoint(await this.checkpoints.load(input.checkpointRef));
      const afterRead = this.replay(input.commandId, fingerprint);
      if (afterRead) return afterRead;
      const result = this.sqlite.transaction(() => {
        const at = this.now();
        if (Date.parse(grant.expiresAt) <= Date.parse(at)) throw new Error("Work continuation authorization expired");
        const current = this.runtime.load(input.runId)!;
        const work = current.workItems.find((candidate) => candidate.id === input.workId);
        if (!work || work.latestCheckpoint?.payloadRef !== input.checkpointRef) throw new Error("Continuation checkpoint changed or is missing");
        if (![2, 3].includes(checkpoint.version) || checkpoint.runId !== current.id || checkpoint.workId !== work.id
          || checkpoint.caseId !== current.caseId || checkpoint.workKey !== work.idempotencyKey) throw new Error("Continuation requires a matching current checkpoint");
        const journal = workerCheckpointJournal(checkpoint);
        if (journal.turn >= defaultWorkerRuntimeOptions.maxTurns || journal.consecutiveFailures >= defaultWorkerRuntimeOptions.repeatedFailureLimit) {
          throw new Error("Continuation cannot reset exhausted execution budgets");
        }
        if (this.sqlite.prepare("SELECT 1 FROM scenario_work_leases WHERE run_id = ? AND work_id = ?").get(input.runId, input.workId)) {
          throw new Error("Active Work lease prevents continuation");
        }
        const assignment: WorkerAssignment = { runId: current.id, leaseId: checkpoint.leaseId,
          leaseExpiresAt: at, runRevision: current.revision, work,
          runContext: { caseId: current.caseId, goal: current.goal, scopeRef: current.scopeRef, activePhaseId: current.activePhaseId, directives: current.directives } };
        this.bindings.validateCheckpoint(assignment, checkpoint);
        const pending = checkpoint.pendingInvocation;
        if (pending) {
          const key = `${work.idempotencyKey}:${pending.invocation.id}`;
          const binding = this.bindings.get(key);
          if (binding && binding.tool.contractFingerprint !== pending.contractFingerprint) throw new Error("Pending invocation contract mismatch");
          // Terminal Work releases prepared bindings. Only explicit continuation may reopen a proven never-started one.
          this.sqlite.prepare(`UPDATE tool_invocation_bindings SET status = 'prepared', release_reason = NULL, updated_at = ?
            WHERE idempotency_key = ? AND status = 'released' AND EXISTS (
              SELECT 1 FROM tool_invocation_executions e WHERE e.idempotency_key = ? AND e.status = 'prepared')`)
            .run(at, key, key);
          this.bindings.inspectRecovery({ idempotencyKey: key, invocationId: pending.invocation.id, toolName: pending.invocation.tool,
            inputFingerprint: toolInvocationInputFingerprint(pending.invocation.tool, pending.invocation.input),
            attribution: { caseId: current.caseId, runId: current.id, workId: work.id } });
        }
        const result = this.runtime.execute({ runId: input.runId, commandId: `work-continue:${input.commandId}`, expectedRevision: input.expectedRevision,
          command: { type: "continue_work", workId: input.workId, checkpointRef: input.checkpointRef,
            authorizationRef: audit.authorizationRef!, reason: input.reason, at } });
        audit.outcome = "queued"; audit.failure = null; audit.at = at;
        this.insert(audit, fingerprint);
        return result;
      })();
      this.changes?.publish({ kind: "run", runId: input.runId, caseId: result.state.caseId,
        revision: result.state.revision, eventTypes: result.events.map((event) => event.type), at: audit.at });
      return { audit, replayed: false };
    } catch (error) {
      const committed = this.replay(input.commandId, fingerprint);
      if (committed) return committed;
      if (isExecutionStorageCapacityError(error) || isExecutionStorageWriteError(error)) throw error;
      if (error instanceof Error && "code" in error && ["EIO", "ENOSPC", "EMFILE", "ENFILE"].includes(String(error.code))) {
        throw new ExecutionStorageWriteError(error);
      }
      audit.outcome = "rejected"; audit.failure = (error instanceof Error ? error.message : "Continuation failed").slice(0, 1024);
      this.insert(audit, fingerprint);
      return { audit, replayed: false };
    }
  }

  private replay(commandId: string, fingerprint: string) {
    const row = readExecutionRow<{ fingerprint: string; audit_json: string }>(this.sqlite, "retry", commandId);
    if (!row) return undefined;
    if (row.fingerprint !== fingerprint) throw new Error("Work recovery command conflicts with its recorded request");
    return { audit: JSON.parse(row.audit_json) as WorkContinuationAudit, replayed: true };
  }
  private insert(audit: WorkContinuationAudit, fingerprint: string): void {
    this.sqlite.prepare("INSERT INTO scenario_work_retry_audits VALUES (?, ?, ?)").run(audit.commandId, fingerprint, JSON.stringify(audit));
  }
}

export function registerScenarioWorkContinuationRoutes(app: FastifyInstance, control: ScenarioWorkContinuationControl): void {
  app.post("/api/scenarios/runs/:runId/work/:workId/continue", async (request, reply) => {
    try {
      const result = await control.continue({ ...(request.body as object), ...(request.params as object) });
      return reply.code(result.audit.outcome === "queued" ? 200 : result.audit.outcome === "denied" ? 403 : 409).send(result);
    } catch (error) {
      return reply.code(isExecutionStorageCapacityError(error) ? 507 : isExecutionStorageWriteError(error) ? 503 : error instanceof z.ZodError ? 400 : 409)
        .send({ error: error instanceof Error ? error.message : "Work continuation failed" });
    }
  });
}
import { readExecutionRow } from "./db/execution-archive.js";
