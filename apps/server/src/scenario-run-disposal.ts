import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { canonicalJson, evolve, type ScenarioEvent, type ScenarioRunState } from "@traceforge/orchestration-core";
import type { BlackboardChangeBus } from "@traceforge/cognitive-runtime";
import { waitForCancellation } from "@traceforge/worker-runtime";
import { SqliteScenarioEventStore } from "./scenario-event-store.js";

const text = z.string().trim().min(1).max(256);
const identity = z.object({ caseId: text, runId: text }).strict();
const requestSchema = identity.extend({
  commandId: text, operation: z.enum(["stop", "retire"]), expectedRevision: z.number().int().positive(),
  actor: text, reason: z.string().trim().min(1).max(1024),
}).strict();
type DisposalRequest = z.infer<typeof requestSchema>;
export interface ScenarioRunDisposalAuthorizer {
  authorize(request: DisposalRequest & { run: ScenarioRunState }): Promise<
    { decision: "allowed"; authorizationRef: string; expiresAt: string } | { decision: "denied" }>;
}
interface Summary {
  run_id: string; case_id: string; revision: number; status: string; definition_kind: string; definition_version: number;
  scenario_package_id: string | null; scenario_package_version: string | null; scenario_schema_revision: number | null;
}
const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
function summary(sqlite: Database.Database, runId: string): Summary {
  const row = sqlite.prepare(`SELECT run_id,case_id,revision,status,definition_kind,definition_version,
    scenario_package_id,scenario_package_version,scenario_schema_revision FROM scenario_event_streams WHERE run_id=?`).get(runId) as Summary | undefined;
  if (!row) throw new Error("Unknown Run");
  return row;
}

/** Facts only. No Registry, Definition, policy, output validator, factory or model is consulted. */
export function readRunForensics(sqlite: Database.Database, runId: string): ScenarioRunState {
  return sqlite.transaction(() => {
    const row = summary(sqlite, runId);
    const state = new SqliteScenarioEventStore(sqlite).loadState(runId);
    if (!state || state.id !== runId || state.caseId !== row.case_id || state.revision !== row.revision || state.status !== row.status
      || state.definitionKind !== row.definition_kind || state.definitionVersion !== row.definition_version
      || (state.scenarioPackage?.id ?? null) !== row.scenario_package_id
      || (state.scenarioPackage?.version ?? null) !== row.scenario_package_version
      || (state.scenarioPackage?.schemaRevision ?? null) !== row.scenario_schema_revision) throw new Error("Run projection integrity mismatch");
    if (Buffer.byteLength(JSON.stringify(state)) > 2 * 1024 * 1024) throw new Error("Run forensic state budget exceeded; use paginated records");
    return state;
  })();
}

interface DisposalAudit extends DisposalRequest {
  authorizationRef: string; resultingRevision: number; resultingStatus: string; eventCommandId: string | null;
  sourceStateHash: string; at: string; automaticResume: false; externalCleanupCertified: false;
}

/** A narrowly scoped control plane, not a second unguarded execution Runtime. */
export class ScenarioRunDisposalControl {
  constructor(private readonly sqlite: Database.Database,
    private readonly authorizer?: ScenarioRunDisposalAuthorizer,
    private readonly changes?: BlackboardChangeBus,
    private readonly now = () => new Date().toISOString()) {
    sqlite.exec(`CREATE TABLE IF NOT EXISTS scenario_run_disposal_audits (
      command_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,case_id TEXT NOT NULL,operation TEXT NOT NULL,
      request_hash TEXT NOT NULL,audit_hash TEXT NOT NULL,audit_json TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS scenario_run_retired_once ON scenario_run_disposal_audits(run_id) WHERE operation='retire';
      CREATE INDEX IF NOT EXISTS scenario_run_disposal_scope ON scenario_run_disposal_audits(case_id,run_id);
      CREATE TRIGGER IF NOT EXISTS scenario_run_disposal_capacity BEFORE INSERT ON scenario_run_disposal_audits BEGIN
        SELECT CASE WHEN (SELECT count(*) FROM scenario_run_disposal_audits)>=50000 OR length(CAST(NEW.audit_json AS BLOB))>8192
          THEN RAISE(ABORT,'Run disposal audit capacity exceeded') END;
        SELECT execution_physical_admit(recovery_floor,maximum_database_bytes,maximum_wal_bytes,32768,'recovery')
          FROM execution_physical_policy WHERE id=1;
      END;`);
    for (const operation of ["UPDATE", "DELETE"]) sqlite.exec(`CREATE TRIGGER IF NOT EXISTS scenario_run_disposal_${operation}
      BEFORE ${operation} ON scenario_run_disposal_audits BEGIN SELECT RAISE(ABORT,'Run disposal audit is immutable'); END;`);
  }

  inspect(value: unknown) {
    const input = identity.parse(value);
    return this.sqlite.transaction(() => {
      const run = this.read(input);
      const blockers = this.blockers(input.runId);
      const retired = this.sqlite.prepare("SELECT command_id FROM scenario_run_disposal_audits WHERE run_id=? AND operation='retire'")
        .get(input.runId) as { command_id: string } | undefined;
      const retirement = retired ? this.audit({ ...input, commandId: retired.command_id }) : null;
      return { run, usage: "forensic_only", executionAuthorized: false, blockers, retirement,
        disposalStatus: retirement ? blockers.length ? "retired_unresolved" : "retired" : ["cancelled", "completed"].includes(run.status)
          ? blockers.length ? "stopped_unresolved" : "ready_to_retire" : "stop_required",
        externalCleanupCertified: false };
    })();
  }

  /** Keyset pages retain raw historical facts without invoking package decoders. */
  events(value: unknown) {
    const input = identity.extend({ after: z.coerce.number().int().nonnegative().default(0),
      limit: z.coerce.number().int().min(1).max(100).default(20) }).parse(value);
    return this.sqlite.transaction(() => {
      const run = summary(this.sqlite, input.runId);
      if (run.case_id !== input.caseId) throw new Error("Run scope mismatch");
      const rows = new SqliteScenarioEventStore(this.sqlite).page(input.runId, input.after, input.limit);
      if (rows.reduce((n, row) => n + Buffer.byteLength(row.payload_json), 0) > 4 * 1024 * 1024) throw new Error("Event page byte budget exceeded; reduce page size");
      return { runId: run.run_id, caseId: run.case_id, revision: run.revision, usage: "forensic_only",
        events: rows.map(row => ({ sequence: row.sequence, commandId: row.command_id, type: row.event_type, event: JSON.parse(row.payload_json) })),
        next: rows.at(-1)?.sequence ?? input.after, hasMore: (rows.at(-1)?.sequence ?? input.after) < run.revision };
    })();
  }

  records(value: unknown) {
    const input = identity.extend({ kind: z.enum(["checkpoints", "approvals", "invocations", "processes", "managed"]),
      after: z.coerce.number().int().nonnegative().default(0), limit: z.coerce.number().int().min(1).max(100).default(20) }).parse(value);
    const run = summary(this.sqlite, input.runId);
    if (run.case_id !== input.caseId) throw new Error("Run scope mismatch");
    // Only bounded identity/status/reference fields, never checkpoint bodies or raw tool output.
    const sources = {
      checkpoints: ["worker_checkpoints", "ref,work_id,created_at", "run_id=?"],
      approvals: ["scenario_work_approvals", "id,work_id,status,created_at,resolved_at", "run_id=?"],
      invocations: ["tool_invocation_bindings", "idempotency_key,invocation_id,work_id,status,tool_name,tool_source,tool_version,(SELECT status FROM tool_invocation_executions e WHERE e.idempotency_key=tool_invocation_bindings.idempotency_key) execution_status", "run_id=?"],
      processes: ["process_execution_occupancy", "id,process_key,state,request_id,proof_ref", "json_extract(identity_json,'$.attribution.runId')=?"],
      managed: ["managed_execution_occupancy", "idempotency_key,state,request_id,proof_ref", "json_extract(identity_json,'$.scheduling.runId')=?"],
    } as const;
    const [table, columns, scope] = sources[input.kind];
    const rows = this.sqlite.prepare(`SELECT rowid cursor,${columns} FROM ${table} WHERE ${scope} AND rowid>? ORDER BY rowid LIMIT ?`)
      .all(input.runId, input.after, input.limit + 1) as ({ cursor: number } & Record<string, unknown>)[];
    const selected = rows.slice(0, input.limit);
    return { kind: input.kind, records: selected, next: selected.at(-1)?.cursor ?? input.after, hasMore: rows.length > input.limit };
  }

  audit(value: unknown): DisposalAudit {
    const input = identity.extend({ commandId: text }).parse(value);
    const row = this.sqlite.prepare("SELECT * FROM scenario_run_disposal_audits WHERE command_id=? AND run_id=? AND case_id=?")
      .get(input.commandId, input.runId, input.caseId) as { audit_hash: string; audit_json: string; operation: string } | undefined;
    if (!row) throw new Error("Run disposal audit not found");
    const audit = JSON.parse(row.audit_json) as DisposalAudit;
    if (hash(audit) !== row.audit_hash || audit.runId !== input.runId || audit.caseId !== input.caseId
      || audit.commandId !== input.commandId || audit.operation !== row.operation) throw new Error("Run disposal audit integrity mismatch");
    if (audit.eventCommandId) {
      const command = new SqliteScenarioEventStore(this.sqlite).findCommand(input.runId, audit.eventCommandId);
      if (!command || command.resultingRevision !== audit.resultingRevision || command.events.length !== 1
        || command.events[0]?.type !== "run_cancelled" || command.events[0].reason !== audit.reason || command.events[0].at !== audit.at)
        throw new Error("Run disposal event integrity mismatch");
    }
    return audit;
  }

  async dispose(value: unknown) {
    const input = requestSchema.parse(structuredClone(value)), requestHash = hash(input), before = this.read(input);
    const grant = await waitForCancellation(() => this.authorizer?.authorize({ ...structuredClone(input), run: structuredClone(before) })
      ?? Promise.resolve({ decision: "denied" as const }), AbortSignal.timeout(10000));
    if (grant.decision !== "allowed" || !grant.authorizationRef?.trim() || Buffer.byteLength(grant.authorizationRef) > 1024
      || !(Date.parse(grant.expiresAt) > Date.parse(this.now()))) throw new Error("Run disposal authorization denied or expired");
    const authorized = structuredClone(grant);
    const result = this.sqlite.transaction(() => {
      if (!(Date.parse(authorized.expiresAt) > Date.parse(this.now()))) throw new Error("Run disposal authorization expired");
      const previous = this.sqlite.prepare("SELECT request_hash FROM scenario_run_disposal_audits WHERE command_id=?").get(input.commandId) as { request_hash: string } | undefined;
      if (previous) {
        if (previous.request_hash !== requestHash) throw new Error("Run disposal command conflict");
        return { audit: this.audit({ caseId: input.caseId, runId: input.runId, commandId: input.commandId }), replayed: true };
      }
      const run = this.read(input);
      if (run.revision !== input.expectedRevision || hash(run) !== hash(before)) throw new Error("Run changed during disposal authorization");
      if (this.sqlite.prepare("SELECT 1 FROM scenario_run_disposal_audits WHERE run_id=? AND operation='retire'").get(input.runId)) throw new Error("Run is already retired");
      const at = this.now();
      let eventCommandId: string | null = null, resultingRevision = run.revision, resultingStatus = run.status;
      if (input.operation === "retire") {
        if (!["cancelled", "completed"].includes(run.status)) throw new Error("Retirement requires a stopped Run");
        if (this.blockers(input.runId).length) throw new Error("Unresolved execution prevents retirement");
      } else if (!["cancelled", "completed"].includes(run.status)) {
        const affected = [
          "SELECT count(*) n FROM scenario_work_leases WHERE run_id=?",
          "SELECT count(*) n FROM scenario_work_approvals WHERE run_id=? AND status='pending'",
          "SELECT count(*) n FROM tool_invocation_bindings WHERE run_id=? AND status='prepared'",
        ].reduce((n, query) => n + (this.sqlite.prepare(query).get(input.runId) as { n: number }).n, 0);
        if (affected > 1024) throw new Error("Run stop projection budget exceeded");
        this.sqlite.prepare(`SELECT execution_physical_admit(recovery_floor,maximum_database_bytes,maximum_wal_bytes,?,'recovery')
          FROM execution_physical_policy WHERE id=1`).get(32768 + affected * 12288);
        eventCommandId = `disposal:${input.commandId}`;
        const event: ScenarioEvent = { type: "run_cancelled", reason: input.reason, at };
        new SqliteScenarioEventStore(this.sqlite).validateState(evolve(run, event)!);
        const append = new SqliteScenarioEventStore(this.sqlite).append({ runId: input.runId, commandId: eventCommandId,
          expectedRevision: run.revision, fingerprint: requestHash, events: [event] });
        if (append.idempotentReplay) throw new Error("Run disposal event command already exists without audit");
        resultingRevision = append.resultingRevision;
        resultingStatus = "cancelled";
      }
      const audit: DisposalAudit = { ...input, authorizationRef: authorized.authorizationRef, resultingRevision, resultingStatus,
        eventCommandId, sourceStateHash: hash(before), at, automaticResume: false, externalCleanupCertified: false };
      this.sqlite.prepare("INSERT INTO scenario_run_disposal_audits VALUES (?,?,?,?,?,?,?)")
        .run(input.commandId, input.runId, input.caseId, input.operation, requestHash, hash(audit), canonicalJson(audit));
      return { audit, replayed: false };
    })();
    // Replays also retry the advisory wakeup; durable terminal state remains the authority after a crash.
    this.changes?.publish({ kind: "run", caseId: input.caseId, runId: input.runId, revision: result.audit.resultingRevision,
      eventTypes: result.audit.eventCommandId ? ["run_cancelled"] : [], at: result.audit.at });
    return result;
  }

  private read(input: { caseId: string; runId: string }) {
    const run = readRunForensics(this.sqlite, input.runId);
    if (run.caseId !== input.caseId) throw new Error("Run scope mismatch");
    return run;
  }

  private blockers(runId: string) {
    const sources = {
      leases: ["scenario_work_leases", "work_id", "run_id=?"],
      approvals: ["scenario_work_approvals", "id", "run_id=? AND status='pending'"],
      invocations: ["tool_invocation_bindings b LEFT JOIN tool_invocation_executions e USING(idempotency_key)", "b.idempotency_key",
        "b.run_id=? AND (b.status='prepared' OR e.status IN ('prepared','executing','uncertain') OR (e.idempotency_key IS NULL AND b.status!='completed'))"],
      processes: ["process_execution_occupancy", "id", "json_extract(identity_json,'$.attribution.runId')=? AND state!='released'"],
      managed: ["managed_execution_occupancy", "idempotency_key", "json_extract(identity_json,'$.scheduling.runId')=? AND state!='released'"],
      models: ["scenario_model_calls", "id", "run_id=? AND status='running'"],
      admissions: ["scenario_model_admissions", "id", "run_id=? AND status IN ('queued','admitted')"],
    } as const;
    return Object.entries(sources).flatMap(([kind, [table, key, where]]) => {
      const { count } = this.sqlite.prepare(`SELECT count(*) count FROM ${table} WHERE ${where}`).get(runId) as { count: number };
      if (!count) return [];
      const samples = this.sqlite.prepare(`SELECT ${key} id FROM ${table} WHERE ${where} ORDER BY ${key} LIMIT 20`).all(runId) as { id: string }[];
      return [{ kind, count, sampleIds: samples.map(row => row.id) }];
    });
  }
}

export function registerScenarioRunDisposalRoutes(app: FastifyInstance, control: ScenarioRunDisposalControl) {
  const route = (suffix: string, handler: (input: unknown) => unknown, write = false) => {
    app.route({ method: write ? "POST" : "GET", url: `/api/scenarios/runs/:runId/disposal${suffix}`, handler: async (request, reply) => {
      try { return await handler({ ...(write ? request.body as object : request.query as object), ...request.params as object }); }
      catch (error) { return reply.code(error instanceof z.ZodError ? 400 : 409).send({ error: error instanceof Error ? error.message.slice(0, 1024) : "Run disposal unavailable" }); }
    } });
  };
  route("", value => control.inspect(value));
  route("/events", value => control.events(value));
  route("/records", value => control.records(value));
  route("/audit", value => control.audit(value));
  route("", value => control.dispose(value), true);
}
