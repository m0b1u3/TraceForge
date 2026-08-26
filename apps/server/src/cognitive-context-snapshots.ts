import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ExtractJsonArgs, LlmProvider } from "@traceforge/llm";
import type { ScenarioAgentRole } from "@traceforge/shared";
import { canonicalJson } from "@traceforge/orchestration-core";
import type { ScenarioAgentEventWriter } from "./scenario-agent-event-stream.js";

export type CognitiveConsumer = "planner" | "observer" | "worker" | "replay";
export type CognitiveSnapshotStatus = "prepared" | "completed" | "failed";

export interface CognitiveSnapshotRecord {
  id: string;
  parentSnapshotId: string | null;
  consumer: CognitiveConsumer;
  runId: string;
  caseId: string;
  workId: string | null;
  evaluationId: string | null;
  sourceRunRevision: number;
  sourceGraphRevision: number | null;
  semanticFingerprint: string | null;
  request: ExtractJsonArgs;
  contextManifest: Record<string, unknown>;
  status: CognitiveSnapshotStatus;
  output: unknown;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

interface SnapshotRow {
  id: string;
  parent_snapshot_id: string | null;
  consumer: CognitiveConsumer;
  run_id: string;
  case_id: string;
  work_id: string | null;
  evaluation_id: string | null;
  source_run_revision: number;
  source_graph_revision: number | null;
  semantic_fingerprint: string | null;
  request_fingerprint: string;
  request_json: string;
  context_manifest_json: string;
  status: CognitiveSnapshotStatus;
  output_json: string | null;
  error: string | null;
  created_at: string;
  completed_at: string | null;
}

function requestFingerprint(request: ExtractJsonArgs): string {
  return createHash("sha256").update(canonicalJson({ system: request.system, user: request.user, schema: request.schema })).digest("hex");
}

function parseRow(row: SnapshotRow): CognitiveSnapshotRecord {
  return {
    id: row.id,
    parentSnapshotId: row.parent_snapshot_id,
    consumer: row.consumer,
    runId: row.run_id,
    caseId: row.case_id,
    workId: row.work_id,
    evaluationId: row.evaluation_id,
    sourceRunRevision: row.source_run_revision,
    sourceGraphRevision: row.source_graph_revision,
    semanticFingerprint: row.semantic_fingerprint,
    request: JSON.parse(row.request_json) as ExtractJsonArgs,
    contextManifest: JSON.parse(row.context_manifest_json) as Record<string, unknown>,
    status: row.status,
    output: row.output_json === null ? null : JSON.parse(row.output_json),
    error: row.error,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

const columns = `
  id, parent_snapshot_id, consumer, run_id, case_id, work_id, evaluation_id,
  source_run_revision, source_graph_revision, semantic_fingerprint, request_fingerprint,
  request_json, context_manifest_json, status, output_json, error, created_at, completed_at
`;

export class SqliteCognitiveSnapshotStore {
  constructor(private readonly sqlite: Database.Database, private readonly events?: ScenarioAgentEventWriter) {}

  recoverPrepared(at: string): number {
    const pending = this.sqlite.prepare(`SELECT ${columns} FROM scenario_cognitive_snapshots WHERE status = 'prepared'`)
      .all() as SnapshotRow[];
    const changed = this.sqlite.prepare(`
      UPDATE scenario_cognitive_snapshots
      SET status = 'failed', error = 'runtime restarted before cognitive evaluation completed', completed_at = ?
      WHERE status = 'prepared'
    `).run(at).changes;
    for (const row of pending) this.emitTurnCompleted(parseRow(row), "interrupted", "runtime restarted before cognitive evaluation completed", at);
    return changed;
  }

  prepare(input: {
    id: string;
    parentSnapshotId?: string;
    consumer: CognitiveConsumer;
    runId: string;
    caseId: string;
    workId?: string;
    evaluationId?: string;
    sourceRunRevision: number;
    sourceGraphRevision?: number;
    semanticFingerprint?: string;
    request: ExtractJsonArgs;
    contextManifest: Record<string, unknown>;
    at: string;
  }): CognitiveSnapshotRecord {
    const fingerprint = requestFingerprint(input.request);
    const existing = this.row(input.id);
    if (existing) {
      if (existing.request_fingerprint !== fingerprint) throw new Error(`Cognitive snapshot ${input.id} was reused with different model input`);
      return parseRow(existing);
    }
    this.sqlite.prepare(`
      INSERT INTO scenario_cognitive_snapshots
        (id, parent_snapshot_id, consumer, run_id, case_id, work_id, evaluation_id,
         source_run_revision, source_graph_revision, semantic_fingerprint, request_fingerprint,
         request_json, context_manifest_json, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?)
    `).run(
      input.id,
      input.parentSnapshotId ?? null,
      input.consumer,
      input.runId,
      input.caseId,
      input.workId ?? null,
      input.evaluationId ?? null,
      input.sourceRunRevision,
      input.sourceGraphRevision ?? null,
      input.semanticFingerprint ?? null,
      fingerprint,
      JSON.stringify({ system: input.request.system, user: input.request.user, schema: input.request.schema }),
      JSON.stringify(input.contextManifest),
      input.at,
    );
    const created = this.get(input.id)!;
    this.events?.append({
      method: "turn/started", runId: created.runId, caseId: created.caseId, workId: created.workId,
      turnId: created.id, role: created.consumer as ScenarioAgentRole, createdAt: input.at,
      params: { sourceRunRevision: created.sourceRunRevision, sourceGraphRevision: created.sourceGraphRevision },
    });
    return created;
  }

  complete(id: string, output: unknown, at: string): CognitiveSnapshotRecord {
    const row = this.row(id);
    if (!row) throw new Error(`Unknown cognitive snapshot ${id}`);
    const serialized = JSON.stringify(output);
    if (serialized === undefined) throw new Error(`Cognitive snapshot ${id} output is not JSON-serializable`);
    if (row.status === "completed") {
      if (row.output_json !== serialized) throw new Error(`Cognitive snapshot ${id} already has a different output`);
      return parseRow(row);
    }
    this.sqlite.prepare(`
      UPDATE scenario_cognitive_snapshots
      SET status = 'completed', output_json = ?, error = NULL, completed_at = ? WHERE id = ?
    `).run(serialized, at, id);
    const completed = this.get(id)!;
    this.emitTurnCompleted(completed, "completed", null, at);
    return completed;
  }

  fail(id: string, error: unknown, at: string): CognitiveSnapshotRecord {
    if (!this.row(id)) throw new Error(`Unknown cognitive snapshot ${id}`);
    const message = error instanceof Error ? error.message : String(error);
    const changed = this.sqlite.prepare(`
      UPDATE scenario_cognitive_snapshots
      SET status = 'failed', error = ?, completed_at = ? WHERE id = ? AND status != 'completed'
    `).run(message, at, id).changes;
    const failed = this.get(id)!;
    if (changed === 1) this.emitTurnCompleted(failed, "failed", message, at);
    return failed;
  }

  get(id: string): CognitiveSnapshotRecord | undefined {
    const row = this.row(id);
    return row ? parseRow(row) : undefined;
  }

  list(runId: string, consumer?: CognitiveConsumer): CognitiveSnapshotRecord[] {
    const rows = (consumer
      ? this.sqlite.prepare(`SELECT ${columns} FROM scenario_cognitive_snapshots WHERE run_id = ? AND consumer = ? ORDER BY created_at ASC`).all(runId, consumer)
      : this.sqlite.prepare(`SELECT ${columns} FROM scenario_cognitive_snapshots WHERE run_id = ? ORDER BY created_at ASC`).all(runId)) as SnapshotRow[];
    return rows.map(parseRow);
  }

  private row(id: string): SnapshotRow | undefined {
    return this.sqlite.prepare(`SELECT ${columns} FROM scenario_cognitive_snapshots WHERE id = ?`).get(id) as SnapshotRow | undefined;
  }

  private emitTurnCompleted(snapshot: CognitiveSnapshotRecord, status: "completed" | "failed" | "interrupted", error: string | null, at: string): void {
    this.events?.append({
      method: "turn/completed", runId: snapshot.runId, caseId: snapshot.caseId, workId: snapshot.workId,
      turnId: snapshot.id, role: snapshot.consumer as ScenarioAgentRole, createdAt: at, params: { status, error },
    });
  }
}

export function registerCognitiveSnapshotRoutes(
  app: FastifyInstance,
  store: SqliteCognitiveSnapshotStore,
  provider: LlmProvider,
  providerReady: () => boolean,
  createId: () => string = randomUUID,
  now: () => string = () => new Date().toISOString(),
): void {
  app.get("/api/scenarios/runs/:runId/cognitive-snapshots", async (request) => {
    const { runId } = z.object({ runId: z.string().min(1) }).parse(request.params);
    const { consumer } = z.object({ consumer: z.enum(["planner", "observer", "worker", "replay"]).optional() }).parse(request.query);
    return store.list(runId, consumer).map(({ request: _request, output: _output, ...metadata }) => metadata);
  });

  app.get("/api/scenarios/cognitive-snapshots/:snapshotId", async (request, reply) => {
    const { snapshotId } = z.object({ snapshotId: z.string().min(1) }).parse(request.params);
    const snapshot = store.get(snapshotId);
    return snapshot ?? reply.code(404).send({ error: `Unknown cognitive snapshot ${snapshotId}` });
  });

  app.post("/api/scenarios/cognitive-snapshots/:snapshotId/replay", async (request, reply) => {
    const { snapshotId } = z.object({ snapshotId: z.string().min(1) }).parse(request.params);
    const source = store.get(snapshotId);
    if (!source) return reply.code(404).send({ error: `Unknown cognitive snapshot ${snapshotId}` });
    if (!providerReady()) return reply.code(409).send({ error: "LLM provider is not ready" });
    const id = createId();
    store.prepare({
      id,
      parentSnapshotId: source.id,
      consumer: "replay",
      runId: source.runId,
      caseId: source.caseId,
      workId: source.workId ?? undefined,
      evaluationId: source.evaluationId ?? undefined,
      sourceRunRevision: source.sourceRunRevision,
      sourceGraphRevision: source.sourceGraphRevision ?? undefined,
      semanticFingerprint: source.semanticFingerprint ?? undefined,
      request: source.request,
      contextManifest: { ...source.contextManifest, replayOf: source.id },
      at: now(),
    });
    try {
      const output = await provider.extractJson(source.request);
      return store.complete(id, output, now());
    } catch (error) {
      store.fail(id, error, now());
      return reply.code(502).send(store.get(id));
    }
  });
}
