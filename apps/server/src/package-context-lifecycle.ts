import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ScenarioPackageRegistry } from "@traceforge/scenario-sdk";
import { toolInvocationInputFingerprint } from "@traceforge/worker-runtime";
import { SqlitePackageContextStore } from "./package-context-resources.js";

const text = z.string().trim().min(1).max(128);
const requestSchema = z.object({ commandId: text, actor: text, reason: z.string().trim().min(1).max(512),
  action: z.enum(["export", "retire"]), package: z.object({ id: text, version: text, schemaRevision: z.number().int().positive() }).strict(),
  resourceId: text, digest: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict();
export type ContextLifecycleRequest = z.infer<typeof requestSchema>;
export interface ContextLifecycleAuthorizer {
  authorize(request: ContextLifecycleRequest): Promise<{ decision: "allowed"; authorizationRef: string; expiresAt: string } | { decision: "denied" }>;
}

/** Host administrative boundary. Never exposes package removal or exports to a model tool. */
export class PackageContextLifecycle {
  constructor(private readonly sqlite: Database.Database, private readonly packages: ScenarioPackageRegistry,
    private readonly store: SqlitePackageContextStore, private readonly authorizer?: ContextLifecycleAuthorizer) {
    sqlite.exec(`CREATE TABLE IF NOT EXISTS package_context_lifecycle (
      command_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, request_json TEXT NOT NULL, grant_ref TEXT NOT NULL,
      result_json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS context_lifecycle_bounded BEFORE INSERT ON package_context_lifecycle BEGIN
        SELECT CASE WHEN (SELECT count(*) FROM package_context_lifecycle)>=2048 OR length(CAST(NEW.request_json AS BLOB))>4096
          OR length(CAST(NEW.result_json AS BLOB))>1024 OR length(CAST(NEW.grant_ref AS BLOB))>1024
          THEN RAISE(ABORT,'Context lifecycle ledger budget exceeded') END;
        SELECT execution_physical_admit(execution_floor, maximum_database_bytes, maximum_wal_bytes, 6144, 'execution')
          FROM execution_physical_policy WHERE id=1;
      END;
      CREATE TRIGGER IF NOT EXISTS context_lifecycle_keep BEFORE DELETE ON package_context_lifecycle
        BEGIN SELECT RAISE(ABORT,'Context lifecycle audit is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS context_lifecycle_immutable BEFORE UPDATE ON package_context_lifecycle
        BEGIN SELECT RAISE(ABORT,'Context lifecycle audit is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS context_retired_bounded BEFORE INSERT ON package_context_retired BEGIN
        SELECT CASE WHEN (SELECT count(*) FROM package_context_retired)>=2048 THEN RAISE(ABORT,'Context retirement budget exceeded') END;
      END;
      CREATE TRIGGER IF NOT EXISTS context_retired_keep BEFORE DELETE ON package_context_retired
        BEGIN SELECT RAISE(ABORT,'Context retirement cannot be forgotten'); END;
      CREATE TRIGGER IF NOT EXISTS context_retired_immutable BEFORE UPDATE ON package_context_retired
        BEGIN SELECT RAISE(ABORT,'Context retirement is immutable'); END;`);
  }

  async execute(input: unknown): Promise<Record<string, unknown>> {
    const request = requestSchema.parse(input);
    const grant = await this.authorizer?.authorize(structuredClone(request));
    if (grant?.decision !== "allowed" || !grant.authorizationRef?.trim() || grant.authorizationRef.length > 1024
      || !(Date.parse(grant.expiresAt) > Date.now())) throw new Error("Context lifecycle authorization denied");
    return this.sqlite.transaction(() => {
      if (!(Date.parse(grant.expiresAt) > Date.now())) throw new Error("Context lifecycle grant expired");
      const fingerprint = toolInvocationInputFingerprint("context.lifecycle", request);
      const old = this.sqlite.prepare("SELECT fingerprint,result_json FROM package_context_lifecycle WHERE command_id=?").get(request.commandId) as { fingerprint: string; result_json: string } | undefined;
      if (old && old.fingerprint !== fingerprint) throw new Error("Context lifecycle command conflict");
      if (old && request.action === "retire") return { ...JSON.parse(old.result_json), replayed: true };
      const pkg = this.packages.definitions().map((d) => {
        try { return this.packages.requireBinding(request.package, d.kind, d.version); } catch { return null; }
      }).find(Boolean);
      const resource = pkg?.resourceManifest?.resources.find((r) => r.id === request.resourceId && r.digest === request.digest && r.context);
      if (!resource) throw new Error("Context lifecycle resource mismatch");
      const binding = JSON.stringify([request.package.id, request.package.version, request.package.schemaRevision]);
      const content = request.action === "retire" ? this.store.readRetained(request.package, resource) : this.store.read(request.package, resource);
      const result = { action: request.action, package: request.package, resourceId: resource.id, digest: resource.digest,
        bytes: Buffer.byteLength(content), auditOriginalsPreserved: true };
      if (request.action === "retire") {
        // Failed Runs remain recoverable: only explicitly terminal completed/cancelled Runs permit retirement.
        const live = this.sqlite.prepare(`SELECT 1 FROM scenario_event_streams WHERE scenario_package_id=? AND scenario_package_version=?
          AND scenario_schema_revision=? AND status NOT IN ('completed','cancelled') LIMIT 1`).get(request.package.id, request.package.version, request.package.schemaRevision);
        if (live) throw new Error("Context package still has recoverable Runs");
        this.sqlite.prepare("INSERT INTO package_context_retired VALUES (?,?)").run(binding, resource.id);
        this.sqlite.prepare("DELETE FROM package_context_content WHERE binding=? AND resource_id=?").run(binding, resource.id);
      }
      if (!old) this.sqlite.prepare("INSERT INTO package_context_lifecycle VALUES (?,?,?,?,?,?)").run(request.commandId, fingerprint,
        JSON.stringify(request), grant.authorizationRef, JSON.stringify(result), new Date().toISOString());
      // Export is freshly authorized and re-read on retries. It cannot resurrect revoked/retired content.
      return request.action === "export" ? { ...result, format: "traceforge-context-resource/v1", resource, content, replayed: !!old }
        : { ...result, replayed: false };
    })();
  }
}

export function registerContextLifecycleRoutes(app: FastifyInstance, lifecycle: PackageContextLifecycle): void {
  app.post("/api/scenarios/context-resources/lifecycle", async (request, reply) => {
    try { return await lifecycle.execute(request.body); }
    catch { return reply.code(409).send({ error: "Context lifecycle request rejected: authorization, identity, retention, or capacity check failed" }); }
  });
}
