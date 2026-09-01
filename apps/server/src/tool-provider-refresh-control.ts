import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  executionToolCatalogFingerprint,
  type ExecutionToolDiscoveryRuntime,
  type ExecutionToolRefreshResult,
} from "@traceforge/worker-runtime";
import {
  canonicalJson,
  ToolProviderControlPlane,
  type ToolProviderInstallation,
} from "./tool-provider-control-plane.js";

export interface ToolProviderRefreshAuthorizer {
  authorize(input: {
    actor: string;
    providerId: string;
    version: string;
    reason: string;
  }): Promise<{ decision: "allowed" | "denied"; reason: string }>;
}

export interface ToolProviderRefreshAudit {
  commandId: string;
  requestFingerprint: string;
  actor: string;
  providerId: string;
  providerVersion: string;
  source: string | null;
  requestedReason: string;
  authorizationDecision: "allowed" | "denied";
  authorizationReason: string;
  outcome: "running" | "succeeded" | "failed" | "denied";
  beforeRevision: number | null;
  afterRevision: number | null;
  beforeCatalogFingerprint: string | null;
  afterCatalogFingerprint: string | null;
  catalogChanged: boolean | null;
  failureReason: string | null;
  createdAt: string;
  completedAt: string | null;
}

interface RefreshRow {
  command_id: string;
  request_fingerprint: string;
  actor: string;
  provider_id: string;
  provider_version: string;
  source: string | null;
  requested_reason: string;
  authorization_decision: ToolProviderRefreshAudit["authorizationDecision"];
  authorization_reason: string;
  outcome: ToolProviderRefreshAudit["outcome"];
  before_revision: number | null;
  after_revision: number | null;
  before_catalog_fingerprint: string | null;
  after_catalog_fingerprint: string | null;
  catalog_changed: 0 | 1 | null;
  failure_reason: string | null;
  created_at: string;
  completed_at: string | null;
}

export class ToolProviderRefreshError extends Error {
  constructor(message: string, readonly statusCode: 400 | 403 | 404 | 409 | 502 = 400) {
    super(message);
    this.name = "ToolProviderRefreshError";
  }
}

export class ToolProviderRefreshControl {
  private readonly serial = new Map<string, Promise<void>>();

  constructor(
    private readonly sqlite: Database.Database,
    private readonly providers: ToolProviderControlPlane,
    private readonly runtime: ExecutionToolDiscoveryRuntime,
    private readonly authorizer: ToolProviderRefreshAuthorizer,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  listAudits(providerId?: string): ToolProviderRefreshAudit[] {
    const rows = (providerId
      ? this.sqlite.prepare("SELECT * FROM tool_provider_refresh_audits WHERE provider_id = ? ORDER BY created_at, command_id").all(required(providerId, "providerId"))
      : this.sqlite.prepare("SELECT * FROM tool_provider_refresh_audits ORDER BY created_at, command_id").all()) as RefreshRow[];
    return rows.map(parseAudit);
  }

  async refresh(input: {
    providerId: string;
    version: string;
    actor: string;
    commandId: string;
    reason: string;
  }): Promise<{ audit: ToolProviderRefreshAudit; replayed: boolean }> {
    const normalized = {
      providerId: required(input.providerId, "providerId"),
      version: required(input.version, "version"),
      actor: required(input.actor, "actor"),
      commandId: required(input.commandId, "commandId"),
      reason: required(input.reason, "reason"),
    };
    const requestFingerprint = fingerprint({
      action: "provider-refresh",
      providerId: normalized.providerId,
      version: normalized.version,
      actor: normalized.actor,
      reason: normalized.reason,
    });
    const existing = this.row(normalized.commandId);
    if (existing) return this.replay(existing, requestFingerprint);

    const authorization = await this.authorize(normalized);
    if (authorization.decision === "denied") {
      const at = this.now();
      try {
        this.insert({
          ...normalized,
          requestFingerprint,
          authorizationDecision: "denied",
          authorizationReason: authorization.reason,
          outcome: "denied",
          failureReason: authorization.reason,
          createdAt: at,
          completedAt: at,
        });
      } catch (error) {
        const raced = this.row(normalized.commandId);
        if (raced) return this.replay(raced, requestFingerprint);
        throw error;
      }
      throw new ToolProviderRefreshError("Tool Provider refresh is not authorized", 403);
    }
    return this.serialize(normalized.providerId, async () => {
      const replay = this.row(normalized.commandId);
      if (replay) return this.replay(replay, requestFingerprint);
      return this.perform(normalized, requestFingerprint, authorization.reason);
    });
  }

  recoverInterrupted(): number {
    return this.sqlite.prepare(`
      UPDATE tool_provider_refresh_audits
      SET outcome = 'failed', failure_reason = 'Refresh was interrupted before its result was durably audited', completed_at = ?
      WHERE outcome = 'running'
    `).run(this.now()).changes;
  }

  private async perform(
    input: { providerId: string; version: string; actor: string; commandId: string; reason: string },
    requestFingerprint: string,
    authorizationReason: string,
  ): Promise<{ audit: ToolProviderRefreshAudit; replayed: boolean }> {
    const installation = this.providers.list().find((candidate) =>
      candidate.manifest.providerId === input.providerId && candidate.manifest.version === input.version);
    if (!installation) return this.failBeforeStart(input, requestFingerprint, authorizationReason, "Unknown Tool Provider version", 404);
    if (installation.state !== "enabled") {
      return this.failBeforeStart(
        input, requestFingerprint, authorizationReason,
        `Tool Provider ${input.providerId}@${input.version} cannot refresh from state ${installation.state}`, 409, installation,
      );
    }
    const before = sourceStatus(this.runtime, installation.manifest.source);
    if (!before || !before.acceptingInvocations) {
      return this.failBeforeStart(
        input, requestFingerprint, authorizationReason,
        `Tool Provider source ${installation.manifest.source} is not active and accepting refreshes`, 409, installation,
      );
    }
    const signedFingerprint = executionToolCatalogFingerprint(installation.manifest.tools);
    if (before.lastSuccessfulCatalogFingerprint !== signedFingerprint) {
      return this.failBeforeStart(
        input, requestFingerprint, authorizationReason,
        "Active Tool Provider catalog does not match its signed manifest", 409, installation,
      );
    }
    const createdAt = this.now();
    this.insert({
      ...input,
      requestFingerprint,
      source: installation.manifest.source,
      authorizationDecision: "allowed",
      authorizationReason,
      outcome: "running",
      beforeRevision: before.discoveryRevision,
      beforeCatalogFingerprint: before.lastSuccessfulCatalogFingerprint,
      createdAt,
      completedAt: null,
    });
    let result: ExecutionToolRefreshResult;
    try {
      result = await this.runtime.refreshWithResult(installation.manifest.source);
    } catch (error) {
      const reason = bounded(error);
      this.completeFailure(input.commandId, reason, null);
      throw new ToolProviderRefreshError(reason, 409);
    }
    const afterInstallation = this.providers.list().find((candidate) =>
      candidate.manifest.providerId === input.providerId && candidate.manifest.version === input.version);
    const failure = validateResult(result, installation, afterInstallation, signedFingerprint);
    if (failure) {
      this.completeFailure(input.commandId, failure, result);
      throw new ToolProviderRefreshError(failure, result.outcome === "degraded" ? 502 : 409);
    }
    this.sqlite.prepare(`
      UPDATE tool_provider_refresh_audits
      SET outcome = 'succeeded', after_revision = ?, after_catalog_fingerprint = ?, catalog_changed = ?, completed_at = ?
      WHERE command_id = ? AND outcome = 'running'
    `).run(result.afterRevision, result.afterCatalogFingerprint, result.catalogChanged ? 1 : 0, this.now(), input.commandId);
    return { audit: parseAudit(this.row(input.commandId)!), replayed: false };
  }

  private failBeforeStart(
    input: { providerId: string; version: string; actor: string; commandId: string; reason: string },
    requestFingerprint: string,
    authorizationReason: string,
    failureReason: string,
    statusCode: 404 | 409,
    installation?: ToolProviderInstallation,
  ): { audit: ToolProviderRefreshAudit; replayed: boolean } {
    const at = this.now();
    try {
      this.insert({
        ...input,
        requestFingerprint,
        source: installation?.manifest.source,
        authorizationDecision: "allowed",
        authorizationReason,
        outcome: "failed",
        failureReason,
        createdAt: at,
        completedAt: at,
      });
    } catch (error) {
      const raced = this.row(input.commandId);
      if (raced) return this.replay(raced, requestFingerprint);
      throw error;
    }
    throw new ToolProviderRefreshError(failureReason, statusCode);
  }

  private completeFailure(commandId: string, failure: string, result: ExecutionToolRefreshResult | null): void {
    this.sqlite.prepare(`
      UPDATE tool_provider_refresh_audits
      SET outcome = 'failed', after_revision = ?, after_catalog_fingerprint = ?, catalog_changed = ?, failure_reason = ?, completed_at = ?
      WHERE command_id = ? AND outcome = 'running'
    `).run(
      result?.afterRevision ?? null,
      result?.afterCatalogFingerprint ?? null,
      result ? (result.catalogChanged ? 1 : 0) : null,
      failure,
      this.now(),
      commandId,
    );
  }

  private replay(row: RefreshRow, requestFingerprint: string): { audit: ToolProviderRefreshAudit; replayed: boolean } {
    if (row.request_fingerprint !== requestFingerprint) {
      throw new ToolProviderRefreshError(`Refresh command ${row.command_id} was already used with different input`, 409);
    }
    if (row.outcome === "running") throw new ToolProviderRefreshError(`Refresh command ${row.command_id} is already running`, 409);
    if (row.outcome === "denied") throw new ToolProviderRefreshError(row.failure_reason ?? "Tool Provider refresh was denied", 403);
    if (row.outcome === "failed") {
      const statusCode = row.after_revision === null ? 409 : 502;
      throw new ToolProviderRefreshError(row.failure_reason ?? "Tool Provider refresh failed", statusCode);
    }
    return { audit: parseAudit(row), replayed: true };
  }

  private async authorize(input: { actor: string; providerId: string; version: string; reason: string }) {
    try {
      const result = await this.authorizer.authorize(input);
      if (!result || !["allowed", "denied"].includes(result.decision) || !result.reason?.trim()) throw new Error("invalid authorization response");
      return { decision: result.decision, reason: result.reason.trim().slice(0, 512) } as const;
    } catch {
      return { decision: "denied", reason: "Tool Provider refresh authorization failed closed" } as const;
    }
  }

  private serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.serial.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const settled = current.then(() => undefined, () => undefined);
    this.serial.set(key, settled);
    void settled.finally(() => { if (this.serial.get(key) === settled) this.serial.delete(key); });
    return current;
  }

  private row(commandId: string): RefreshRow | undefined {
    return this.sqlite.prepare("SELECT * FROM tool_provider_refresh_audits WHERE command_id = ?").get(commandId) as RefreshRow | undefined;
  }

  private insert(input: {
    providerId: string; version: string; actor: string; commandId: string; reason: string; requestFingerprint: string;
    source?: string; authorizationDecision: "allowed" | "denied"; authorizationReason: string;
    outcome: "running" | "failed" | "denied"; beforeRevision?: number; beforeCatalogFingerprint?: string | null;
    failureReason?: string; createdAt: string; completedAt: string | null;
  }): void {
    this.sqlite.prepare(`
      INSERT INTO tool_provider_refresh_audits
        (command_id, request_fingerprint, actor, provider_id, provider_version, source, requested_reason,
         authorization_decision, authorization_reason, outcome, before_revision, before_catalog_fingerprint,
         failure_reason, created_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.commandId, input.requestFingerprint, input.actor, input.providerId, input.version, input.source ?? null,
      input.reason, input.authorizationDecision, input.authorizationReason, input.outcome,
      input.beforeRevision ?? null, input.beforeCatalogFingerprint ?? null, input.failureReason ?? null,
      input.createdAt, input.completedAt,
    );
  }
}

export function registerToolProviderRefreshRoutes(app: FastifyInstance, control: ToolProviderRefreshControl): void {
  app.post("/api/security-tools/providers/:providerId/versions/:version/refresh", async (request, reply) => {
    try {
      const { providerId, version } = request.params as { providerId: string; version: string };
      const body = (request.body ?? {}) as { actor?: string; commandId?: string; reason?: string };
      return reply.send(await control.refresh({
        providerId, version, actor: body.actor ?? "", commandId: body.commandId ?? "", reason: body.reason ?? "",
      }));
    } catch (error) { return refreshError(reply, error); }
  });
}

function validateResult(
  result: ExecutionToolRefreshResult,
  before: ToolProviderInstallation,
  after: ToolProviderInstallation | undefined,
  signedFingerprint: string | null,
): string | null {
  if (!after || after.state !== "enabled" || after.manifest.source !== before.manifest.source) {
    return "Tool Provider lifecycle changed while refresh was running";
  }
  if (result.source !== before.manifest.source) return "Tool discovery refreshed an unexpected source";
  if (result.outcome !== "ready") return result.failure ?? "Tool Provider discovery refresh degraded";
  if (result.afterRevision <= result.beforeRevision) return "Tool Provider discovery revision did not advance";
  if (result.afterCatalogFingerprint !== signedFingerprint) return "Refreshed Tool Provider catalog does not match its signed manifest";
  if (result.catalogChanged) return "A managed Tool Provider refresh cannot change the signed catalog in place";
  return null;
}

function sourceStatus(runtime: ExecutionToolDiscoveryRuntime, source: string) {
  return runtime.snapshot().sources.find((candidate) => candidate.source === source);
}

function parseAudit(row: RefreshRow): ToolProviderRefreshAudit {
  return {
    commandId: row.command_id, requestFingerprint: row.request_fingerprint, actor: row.actor,
    providerId: row.provider_id, providerVersion: row.provider_version, source: row.source,
    requestedReason: row.requested_reason, authorizationDecision: row.authorization_decision,
    authorizationReason: row.authorization_reason, outcome: row.outcome, beforeRevision: row.before_revision,
    afterRevision: row.after_revision, beforeCatalogFingerprint: row.before_catalog_fingerprint,
    afterCatalogFingerprint: row.after_catalog_fingerprint, catalogChanged: row.catalog_changed === null ? null : row.catalog_changed === 1,
    failureReason: row.failure_reason, createdAt: row.created_at, completedAt: row.completed_at,
  };
}

function refreshError(reply: FastifyReply, error: unknown) {
  if (error instanceof ToolProviderRefreshError) return reply.code(error.statusCode).send({ error: error.message });
  return reply.code(500).send({ error: bounded(error) });
}

function fingerprint(value: unknown): string { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }
function required(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new ToolProviderRefreshError(`${label} is required`);
  return value.trim();
}
function bounded(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 1_024); }
