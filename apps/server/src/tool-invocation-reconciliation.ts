import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { validateToolProviderResult, type ToolExecutionResult } from "@traceforge/worker-runtime";
import { SqliteToolInvocationBindingStore } from "./worker-execution-adapters.js";
import { isExecutionStorageCapacityError, isExecutionStorageWriteError, settleNoEffectReceiptReservation } from "./db/execution-storage.js";

export type ToolInvocationResolution = "confirmed_result" | "confirmed_no_effect";

export interface ToolInvocationReconciliationIdentity {
  idempotencyKey: string;
  invocationId: string;
  tool: { name: string; source: string; version: string; contractFingerprint: string };
  inputFingerprint: string;
  attribution: { caseId: string; runId: string; workId: string };
}

export interface ToolInvocationReconciliationAuthorizer {
  authorize(input: {
    actor: string;
    resolution: ToolInvocationResolution;
    reason: string;
    identity: ToolInvocationReconciliationIdentity;
  }): Promise<{ decision: "allowed" | "denied"; reason: string }>;
}

export interface ToolInvocationReconciliationAssertion {
  schemaVersion: 1;
  identity: ToolInvocationReconciliationIdentity;
  executionOwnership: { ownerId: string; leaseId: string | null };
  outcome: "result_confirmed" | "no_effect_confirmed";
  resultFingerprint: string | null;
  cleanup: {
    status: "not_started" | "terminal" | "not_applicable";
    evidenceRef: string;
  };
  issuedAt: string;
  expiresAt: string;
}

/** A deployment-owned trust boundary, for example an Execution Node attestation verifier. */
export interface ToolInvocationReconciliationEvidenceVerifier {
  verify(input: {
    evidence: unknown;
    resolution: ToolInvocationResolution;
    result: ToolExecutionResult | null;
    expectedIdentity: ToolInvocationReconciliationIdentity;
    expectedExecutionOwnership: { ownerId: string; leaseId: string | null };
  }): Promise<ToolInvocationReconciliationAssertion>;
}

export interface ToolInvocationReconciliationAudit {
  commandId: string;
  requestFingerprint: string;
  idempotencyKey: string;
  actor: string;
  requestedResolution: ToolInvocationResolution;
  requestedReason: string;
  evidenceFingerprint: string;
  verifiedAssertion: ToolInvocationReconciliationAssertion | null;
  authorizationDecision: "allowed" | "denied" | "not_evaluated";
  authorizationReason: string;
  outcome: "resolved" | "denied" | "rejected";
  failureReason: string | null;
  createdAt: string;
}

interface AuditRow {
  command_id: string;
  request_fingerprint: string;
  idempotency_key: string;
  actor: string;
  requested_resolution: ToolInvocationResolution;
  requested_reason: string;
  evidence_fingerprint: string;
  verified_assertion_json: string | null;
  authorization_decision: "allowed" | "denied" | "not_evaluated";
  authorization_reason: string;
  outcome: "resolved" | "denied" | "rejected";
  failure_reason: string | null;
  created_at: string;
}

export class ToolInvocationReconciliationError extends Error {
  constructor(message: string, readonly statusCode: 400 | 403 | 404 | 409 = 400) {
    super(message);
    this.name = "ToolInvocationReconciliationError";
  }
}

export class ToolInvocationReconciliationControl {
  private readonly serial = new Map<string, Promise<void>>();

  constructor(
    private readonly sqlite: Database.Database,
    private readonly bindings: SqliteToolInvocationBindingStore,
    private readonly authorizer: ToolInvocationReconciliationAuthorizer,
    private readonly verifier: ToolInvocationReconciliationEvidenceVerifier,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  listAudits(idempotencyKey?: string): ToolInvocationReconciliationAudit[] {
    return this.auditHistory({ idempotencyKey, limit: 100 }).audits;
  }

  auditHistory(value: unknown) {
    const query = z.object({ idempotencyKey: z.string().trim().min(1).max(512).optional(),
      after: z.string().min(1).max(512).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).strict().parse(value);
    const rows = (query.idempotencyKey
      ? this.sqlite.prepare("SELECT * FROM tool_invocation_reconciliation_audits WHERE idempotency_key = ? AND command_id > ? ORDER BY command_id LIMIT ?")
        .all(query.idempotencyKey, query.after ?? "", query.limit + 1)
      : this.sqlite.prepare("SELECT * FROM tool_invocation_reconciliation_audits WHERE command_id > ? ORDER BY command_id LIMIT ?")
        .all(query.after ?? "", query.limit + 1)) as AuditRow[];
    return { audits: rows.slice(0, query.limit).map((row) => parseAudit(this.row(row.command_id)!)), nextCursor: rows.length > query.limit ? rows[query.limit - 1]!.command_id : null };
  }

  async reconcile(value: {
    idempotencyKey: string;
    actor: string;
    commandId: string;
    resolution: ToolInvocationResolution;
    reason: string;
    evidence: unknown;
    result?: unknown;
  }): Promise<{ audit: ToolInvocationReconciliationAudit; replayed: boolean }> {
    const input = normalize(structuredClone(value));
    const evidenceFingerprint = fingerprint(input.evidence);
    const result = input.resolution === "confirmed_result"
      ? validateToolProviderResult(input.result)
      : null;
    if (input.resolution === "confirmed_no_effect" && input.result !== undefined) {
      throw new ToolInvocationReconciliationError("confirmed_no_effect must not include a result");
    }
    const requestFingerprint = fingerprint({
      idempotencyKey: input.idempotencyKey,
      actor: input.actor,
      resolution: input.resolution,
      reason: input.reason,
      evidenceFingerprint,
      result,
    });
    const historical = this.row(input.commandId);
    if (historical) return this.replay(historical, requestFingerprint);
    return this.serialize(input.idempotencyKey, async () => {
      const raced = this.row(input.commandId);
      if (raced) return this.replay(raced, requestFingerprint);
      const binding = this.bindings.get(input.idempotencyKey);
      const execution = this.bindings.execution(input.idempotencyKey);
      if (!binding || !execution) {
        return this.reject(input, requestFingerprint, evidenceFingerprint, "Unknown Tool Invocation", 404);
      }
      const identity: ToolInvocationReconciliationIdentity = {
        idempotencyKey: binding.idempotencyKey,
        invocationId: binding.invocationId,
        tool: binding.tool,
        inputFingerprint: binding.inputFingerprint,
        attribution: binding.attribution,
      };
      const authorization = await this.authorize({ actor: input.actor, resolution: input.resolution, reason: input.reason, identity: structuredClone(identity) });
      if (authorization.decision === "denied") {
        this.insertAudit({
          input, requestFingerprint, evidenceFingerprint, authorizationDecision: "denied",
          authorizationReason: authorization.reason, outcome: "denied",
          failureReason: "Tool Invocation reconciliation is not authorized", assertion: null,
        });
        throw new ToolInvocationReconciliationError("Tool Invocation reconciliation is not authorized", 403);
      }
      if (execution.status !== "uncertain") {
        return this.reject(input, requestFingerprint, evidenceFingerprint, `Invocation is ${execution.status}, not uncertain`, 409, authorization.reason, "allowed");
      }
      if (binding.status === "completed") {
        return this.reject(input, requestFingerprint, evidenceFingerprint, "Completed invocation binding conflicts with uncertain execution ownership", 409, authorization.reason, "allowed");
      }
      let assertion: ToolInvocationReconciliationAssertion;
      try {
        assertion = structuredClone(await this.verifier.verify({
          evidence: input.evidence,
          resolution: input.resolution,
          result: structuredClone(result),
          expectedIdentity: structuredClone(identity),
          expectedExecutionOwnership: { ownerId: execution.owner_id, leaseId: execution.lease_id },
        }));
        validateAssertion(assertion, identity, execution, input.resolution, result, this.now);
      } catch (error) {
        // Capacity is retryable after operator intervention; it is not a permanent evidence rejection.
        if (isExecutionStorageCapacityError(error) || isExecutionStorageWriteError(error)) throw error;
        return this.reject(input, requestFingerprint, evidenceFingerprint, "Reconciliation evidence could not be trusted", 409, authorization.reason, "allowed");
      }
      const audit = this.commitResolution({
        input, requestFingerprint, evidenceFingerprint, authorizationReason: authorization.reason,
        assertion, result, identity,
      });
      return { audit, replayed: false };
    });
  }

  private commitResolution(input: {
    input: ReturnType<typeof normalize>;
    requestFingerprint: string;
    evidenceFingerprint: string;
    authorizationReason: string;
    assertion: ToolInvocationReconciliationAssertion;
    result: ToolExecutionResult | null;
    identity: ToolInvocationReconciliationIdentity;
  }): ToolInvocationReconciliationAudit {
    const outcome = this.sqlite.transaction(() => {
      const current = this.bindings.execution(input.input.idempotencyKey);
      const binding = this.bindings.get(input.input.idempotencyKey);
      if (!current || current.status !== "uncertain"
        || current.owner_id !== input.assertion.executionOwnership.ownerId
        || current.lease_id !== input.assertion.executionOwnership.leaseId
        || !binding || binding.status === "completed" || !sameIdentity(input.identity, {
          idempotencyKey: binding.idempotencyKey, invocationId: binding.invocationId, tool: binding.tool,
          inputFingerprint: binding.inputFingerprint, attribution: binding.attribution,
        })) return "conflict" as const;
      const at = this.now();
      validateAssertion(input.assertion, input.identity, current, input.input.resolution, input.result, () => at);
      if (!input.result && this.sqlite.prepare("SELECT 1 FROM worker_tool_receipts WHERE idempotency_key = ?").get(input.input.idempotencyKey)) {
        return "conflict" as const;
      }
      if (input.result) {
        this.sqlite.prepare("INSERT INTO worker_tool_receipts (idempotency_key, result_json, created_at) VALUES (?, ?, ?)")
          .run(input.input.idempotencyKey, JSON.stringify(input.result), at);
        this.sqlite.prepare("UPDATE tool_invocation_bindings SET status = 'completed', release_reason = NULL, updated_at = ? WHERE idempotency_key = ?")
          .run(at, input.input.idempotencyKey);
      } else {
        this.sqlite.prepare(`UPDATE tool_invocation_bindings SET status = 'released', release_reason = ?, updated_at = ?
          WHERE idempotency_key = ? AND status != 'completed'`)
          .run(`Authorized reconciliation confirmed no external effect: ${input.input.reason}`.slice(0, 1024), at, input.input.idempotencyKey);
      }
      this.sqlite.prepare(`UPDATE tool_invocation_executions SET status = 'completed', reason = ?, updated_at = ?
        WHERE idempotency_key = ? AND status = 'uncertain'`)
        .run(input.result ? null : "Authorized reconciliation confirmed no external effect", at, input.input.idempotencyKey);
      this.insertAudit({
        input: input.input, requestFingerprint: input.requestFingerprint, evidenceFingerprint: input.evidenceFingerprint,
        authorizationDecision: "allowed", authorizationReason: input.authorizationReason,
        outcome: "resolved", failureReason: null, assertion: input.assertion, createdAt: at,
      });
      if (!input.result) settleNoEffectReceiptReservation(this.sqlite, input.input.idempotencyKey);
      return "resolved" as const;
    })();
    if (outcome === "conflict") {
      this.reject(
        input.input, input.requestFingerprint, input.evidenceFingerprint,
        "Invocation ownership changed while reconciliation was in progress", 409, input.authorizationReason, "allowed",
      );
    }
    return parseAudit(this.row(input.input.commandId)!);
  }

  private reject(
    input: ReturnType<typeof normalize>,
    requestFingerprint: string,
    evidenceFingerprint: string,
    reason: string,
    statusCode: 404 | 409,
    authorizationReason = "Authorization was not evaluated because the invocation was not eligible",
    authorizationDecision: "allowed" | "not_evaluated" = "not_evaluated",
  ): never {
    this.insertAudit({
      input, requestFingerprint, evidenceFingerprint, authorizationDecision,
      authorizationReason, outcome: "rejected", failureReason: reason, assertion: null,
    });
    throw new ToolInvocationReconciliationError(reason, statusCode);
  }

  private replay(row: AuditRow, requestFingerprint: string): { audit: ToolInvocationReconciliationAudit; replayed: boolean } {
    if (row.request_fingerprint !== requestFingerprint) {
      throw new ToolInvocationReconciliationError(`Reconciliation command ${row.command_id} was already used with different input`, 409);
    }
    if (row.outcome === "denied") throw new ToolInvocationReconciliationError(row.failure_reason ?? "Reconciliation was denied", 403);
    if (row.outcome === "rejected") throw new ToolInvocationReconciliationError(row.failure_reason ?? "Reconciliation was rejected", 409);
    return { audit: parseAudit(row), replayed: true };
  }

  private async authorize(input: Parameters<ToolInvocationReconciliationAuthorizer["authorize"]>[0]) {
    try {
      const decision = await this.authorizer.authorize(input);
      if (!decision || !["allowed", "denied"].includes(decision.decision) || !decision.reason?.trim()) throw new Error("invalid authorization response");
      return { decision: decision.decision, reason: decision.reason.trim().slice(0, 512) } as const;
    } catch {
      return { decision: "denied", reason: "Tool Invocation reconciliation authorization failed closed" } as const;
    }
  }

  private insertAudit(input: {
    input: ReturnType<typeof normalize>;
    requestFingerprint: string;
    evidenceFingerprint: string;
    assertion: ToolInvocationReconciliationAssertion | null;
    authorizationDecision: "allowed" | "denied" | "not_evaluated";
    authorizationReason: string;
    outcome: "resolved" | "denied" | "rejected";
    failureReason: string | null;
    createdAt?: string;
  }): void {
    this.sqlite.prepare(`INSERT INTO tool_invocation_reconciliation_audits
      (command_id, request_fingerprint, idempotency_key, actor, requested_resolution, requested_reason,
       evidence_fingerprint, verified_assertion_json, authorization_decision, authorization_reason, outcome, failure_reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        input.input.commandId, input.requestFingerprint, input.input.idempotencyKey, input.input.actor,
        input.input.resolution, input.input.reason, input.evidenceFingerprint,
        input.assertion ? canonicalJson(input.assertion) : null,
        input.authorizationDecision, input.authorizationReason, input.outcome, input.failureReason, input.createdAt ?? this.now(),
      );
  }

  private serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.serial.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const settled = current.then(() => undefined, () => undefined);
    this.serial.set(key, settled);
    void settled.finally(() => { if (this.serial.get(key) === settled) this.serial.delete(key); });
    return current;
  }

  private row(commandId: string): AuditRow | undefined {
    return readExecutionRow<AuditRow>(this.sqlite, "reconciliation", commandId);
  }
}

export function registerToolInvocationReconciliationRoutes(app: FastifyInstance, control: ToolInvocationReconciliationControl): void {
  app.get("/api/security-tools/invocations/reconciliations", async (request, reply) => {
    try { return control.auditHistory(request.query); }
    catch (error) { return reconciliationError(reply, error); }
  });
  app.post("/api/security-tools/invocations/:idempotencyKey/reconcile", async (request, reply) => {
    try {
      const { idempotencyKey } = request.params as { idempotencyKey: string };
      const body = (request.body ?? {}) as Record<string, unknown>;
      return reply.send(await control.reconcile({
        idempotencyKey, actor: stringValue(body.actor), commandId: stringValue(body.commandId),
        resolution: body.resolution as ToolInvocationResolution, reason: stringValue(body.reason),
        evidence: body.evidence, result: body.result,
      }));
    } catch (error) { return reconciliationError(reply, error); }
  });
}

function normalize(input: {
  idempotencyKey: string; actor: string; commandId: string; resolution: ToolInvocationResolution;
  reason: string; evidence: unknown; result?: unknown;
}) {
  if (!["confirmed_result", "confirmed_no_effect"].includes(input.resolution)) {
    throw new ToolInvocationReconciliationError("resolution must be confirmed_result or confirmed_no_effect");
  }
  if (input.evidence === undefined) throw new ToolInvocationReconciliationError("evidence is required");
  return {
    idempotencyKey: required(input.idempotencyKey, "idempotencyKey"), actor: required(input.actor, "actor"),
    commandId: required(input.commandId, "commandId"), resolution: input.resolution,
    reason: required(input.reason, "reason").slice(0, 1024), evidence: input.evidence, result: input.result,
  };
}

function validateAssertion(
  assertion: ToolInvocationReconciliationAssertion,
  identity: ToolInvocationReconciliationIdentity,
  execution: NonNullable<ReturnType<SqliteToolInvocationBindingStore["execution"]>>,
  resolution: ToolInvocationResolution,
  result: ToolExecutionResult | null,
  now: () => string,
): void {
  if (!assertion || assertion.schemaVersion !== 1 || !sameIdentity(assertion.identity, identity)) throw new Error("identity mismatch");
  if (assertion.executionOwnership?.ownerId !== execution.owner_id
    || assertion.executionOwnership.leaseId !== execution.lease_id) throw new Error("ownership mismatch");
  if (!assertion.cleanup?.evidenceRef?.trim() || !["not_started", "terminal", "not_applicable"].includes(assertion.cleanup.status)) throw new Error("invalid cleanup proof");
  const issued = Date.parse(assertion.issuedAt);
  const expires = Date.parse(assertion.expiresAt);
  const current = Date.parse(now());
  const ownershipUpdated = Date.parse(execution.updated_at);
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || !Number.isFinite(current) || !Number.isFinite(ownershipUpdated)
    || issued < ownershipUpdated || issued > current || expires <= current || expires <= issued) throw new Error("stale evidence");
  if (resolution === "confirmed_result") {
    if (assertion.outcome !== "result_confirmed" || assertion.resultFingerprint !== fingerprint(result)) throw new Error("result mismatch");
    if (assertion.cleanup.status === "not_started") throw new Error("result cannot be paired with not-started proof");
  } else {
    if (assertion.outcome !== "no_effect_confirmed" || assertion.resultFingerprint !== null) throw new Error("outcome mismatch");
    if (assertion.cleanup.status === "not_applicable") throw new Error("no-effect proof must establish no start or terminal cleanup");
  }
}

function sameIdentity(left: ToolInvocationReconciliationIdentity, right: ToolInvocationReconciliationIdentity): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function parseAudit(row: AuditRow): ToolInvocationReconciliationAudit {
  return {
    commandId: row.command_id, requestFingerprint: row.request_fingerprint, idempotencyKey: row.idempotency_key,
    actor: row.actor, requestedResolution: row.requested_resolution, requestedReason: row.requested_reason,
    evidenceFingerprint: row.evidence_fingerprint,
    verifiedAssertion: row.verified_assertion_json ? JSON.parse(row.verified_assertion_json) as ToolInvocationReconciliationAssertion : null,
    authorizationDecision: row.authorization_decision, authorizationReason: row.authorization_reason,
    outcome: row.outcome, failureReason: row.failure_reason, createdAt: row.created_at,
  };
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonicalize(entry)]));
  throw new ToolInvocationReconciliationError("Reconciliation input must be JSON-compatible");
}

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new ToolInvocationReconciliationError(`${label} is required`);
  return normalized;
}

function stringValue(value: unknown): string { return typeof value === "string" ? value : ""; }

function reconciliationError(reply: FastifyReply, error: unknown) {
  if (error instanceof z.ZodError) return reply.code(400).send({ error: "Invalid reconciliation history query" });
  if (isExecutionStorageCapacityError(error)) return reply.code(507).send({ error: "Execution storage capacity exhausted" });
  if (isExecutionStorageWriteError(error)) return reply.code(503).send({ error: "Execution recovery storage is unavailable" });
  if (error instanceof ToolInvocationReconciliationError) return reply.code(error.statusCode).send({ error: error.message });
  return reply.code(500).send({ error: "Tool Invocation reconciliation failed" });
}
import { readExecutionRow } from "./db/execution-archive.js";
