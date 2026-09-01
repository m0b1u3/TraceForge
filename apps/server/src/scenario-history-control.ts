import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { canonicalJson } from "@traceforge/orchestration-core";
import { waitForCancellation } from "@traceforge/worker-runtime";
import { archiveHistoryRange, historyHash, readHistoryRows } from "./db/scenario-history.js";

const text = z.string().trim().min(1).max(256);
const identity = z.object({ caseId: text, runId: text }).strict();
const range = identity.extend({ expectedRevision: z.number().int().positive(), throughRevision: z.number().int().positive() });
const request = range.extend({ commandId: text, actor: text, reason: z.string().trim().min(1).max(1024), planFingerprint: z.string().length(64) });
type ArchiveRequest = z.infer<typeof request>;
export interface ScenarioHistoryAuthorizer {
  authorize(input: ArchiveRequest): Promise<{ decision: "allowed"; authorizationRef: string; expiresAt: string } | { decision: "denied" }>;
}
export class ScenarioHistoryControl {
  constructor(private readonly sqlite: Database.Database, private readonly authorizer?: ScenarioHistoryAuthorizer,
    private readonly now = () => new Date().toISOString()) {}

  inspect(value: unknown) {
    const input = identity.parse(value), run = this.run(input);
    const segments = this.sqlite.prepare("SELECT first_revision,last_revision,digest,original_bytes,length(payload) compressed_bytes,length(CAST(snapshot_json AS BLOB)) snapshot_bytes FROM scenario_history_segments WHERE run_id=? ORDER BY first_revision LIMIT 1025")
      .all(input.runId) as { first_revision: number; last_revision: number; digest: string; original_bytes: number; compressed_bytes: number; snapshot_bytes: number }[];
    if (segments.length > 1024) throw new Error("Run history chain budget exceeded");
    return { ...input, revision: run.revision, archivedThrough: segments.at(-1)?.last_revision ?? 0, segments,
      usage: this.sqlite.prepare("SELECT * FROM scenario_history_usage WHERE id=1").get(), deletesEvidence: false, automaticResume: false };
  }

  preview(value: unknown) {
    const input = range.parse(value);
    return this.sqlite.transaction(() => {
      const run = this.run(input);
      if (run.revision !== input.expectedRevision || input.throughRevision > run.revision) throw new Error("Run history revision conflict");
      const prior = this.sqlite.prepare("SELECT last_revision,digest FROM scenario_history_segments WHERE run_id=? ORDER BY last_revision DESC LIMIT 1")
        .get(input.runId) as { last_revision: number; digest: string } | undefined;
      const firstRevision = (prior?.last_revision ?? 0) + 1, count = input.throughRevision - firstRevision + 1;
      if (count < 1 || count > 1000) throw new Error("Archive a contiguous range of 1..1000 events");
      const rows = readHistoryRows(this.sqlite, input.runId, firstRevision - 1, count, input.throughRevision);
      if (rows.length !== count) throw new Error("Run history range is incomplete");
      const plan = { ...input, firstRevision, previousDigest: prior?.digest ?? "", sourceDigest: historyHash(JSON.stringify(rows)) };
      return { ...plan, planFingerprint: historyHash(canonicalJson(plan)), automaticResume: false, deletesEvidence: false };
    })();
  }

  audit(value: unknown) {
    const input = identity.extend({ commandId: text }).parse(value); this.run(input);
    const row = this.sqlite.prepare("SELECT * FROM scenario_history_audits WHERE command_id=?").get(input.commandId) as { audit_json: string; audit_hash: string } | undefined;
    if (!row || historyHash(row.audit_json) !== row.audit_hash) throw new Error("Run history audit missing or corrupt");
    const audit = JSON.parse(row.audit_json);
    if (audit.caseId !== input.caseId || audit.runId !== input.runId || audit.commandId !== input.commandId) throw new Error("Run history audit scope mismatch");
    const segment = this.sqlite.prepare("SELECT digest FROM scenario_history_segments WHERE run_id=? AND first_revision=? AND last_revision=?")
      .get(input.runId, audit.firstRevision, audit.throughRevision) as { digest: string } | undefined;
    if (segment?.digest !== audit.digest) throw new Error("Run history audit segment missing or mismatched");
    return audit;
  }

  async archive(value: unknown) {
    const input = request.parse(structuredClone(value)), fingerprint = historyHash(canonicalJson(input)); this.run(input);
    const grant = structuredClone(await waitForCancellation(() => this.authorizer?.authorize(structuredClone(input))
      ?? Promise.resolve({ decision: "denied" as const }), AbortSignal.timeout(10000)));
    if (grant.decision !== "allowed" || !grant.authorizationRef?.trim() || Buffer.byteLength(grant.authorizationRef) > 1024
      || !(Date.parse(grant.expiresAt) > Date.parse(this.now()))) throw new Error("Run history authorization denied or expired");
    return this.sqlite.transaction(() => {
      if (!(Date.parse(grant.expiresAt) > Date.parse(this.now()))) throw new Error("Run history authorization expired");
      const previous = this.sqlite.prepare("SELECT request_hash FROM scenario_history_audits WHERE command_id=?").get(input.commandId) as { request_hash: string } | undefined;
      if (previous) {
        if (previous.request_hash !== fingerprint) throw new Error("Run history command conflict");
        return { audit: this.audit({ caseId: input.caseId, runId: input.runId, commandId: input.commandId }), replayed: true };
      }
      const plan = this.preview({ caseId: input.caseId, runId: input.runId, expectedRevision: input.expectedRevision, throughRevision: input.throughRevision });
      if (plan.planFingerprint !== input.planFingerprint) throw new Error("Run history archive plan changed");
      const archived = archiveHistoryRange(this.sqlite, input.runId, input.throughRevision);
      const audit = { ...input, ...archived, authorizationRef: grant.authorizationRef, at: this.now(), automaticResume: false, deletesEvidence: false };
      const body = canonicalJson(audit);
      this.sqlite.prepare("INSERT INTO scenario_history_audits VALUES (?,?,?,?)").run(input.commandId, fingerprint, historyHash(body), body);
      return { audit, replayed: false };
    })();
  }

  private run(input: { caseId: string; runId: string }) {
    const row = this.sqlite.prepare("SELECT case_id,revision FROM scenario_event_streams WHERE run_id=?").get(input.runId) as { case_id: string; revision: number } | undefined;
    if (!row || row.case_id !== input.caseId) throw new Error("Run history scope mismatch");
    return row;
  }
}
export function registerScenarioHistoryRoutes(app: FastifyInstance, control: ScenarioHistoryControl) {
  const route = (suffix: string, write: boolean, handler: (value: unknown) => unknown) => app.route({
    method: write ? "POST" : "GET", url: `/api/scenarios/runs/:runId/history${suffix}`, handler: async (req, reply) => {
      try { return await handler({ ...(write ? req.body as object : req.query as object), ...req.params as object }); }
      catch (error) { return reply.code(error instanceof z.ZodError ? 400 : 409).send({ error: error instanceof Error ? error.message.slice(0, 1024) : "Run history unavailable" }); }
    },
  });
  route("", false, value => control.inspect(value));
  route("/preview", true, value => control.preview(value));
  route("/archive", true, value => control.archive(value));
  route("/audit", false, value => control.audit(value));
}
