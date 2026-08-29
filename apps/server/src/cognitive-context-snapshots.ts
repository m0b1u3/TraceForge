import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  CognitiveSnapshotRuntime,
  type CognitiveConsumer,
  type CognitiveSnapshotEventPort,
  type CognitiveSnapshotLifecycleEvent,
  type CognitiveSnapshotPersistencePort,
  type CognitiveSnapshotRecord,
  type CognitiveSnapshotStatus,
  type CompleteCognitiveSnapshotOptions,
  type PrepareCognitiveSnapshotInput,
  type StoredCognitiveSnapshot,
} from "@traceforge/cognitive-runtime";
import type { LlmProvider } from "@traceforge/llm";
import type { ScenarioAgentEventWriter } from "./scenario-agent-event-stream.js";

export type {
  CognitiveConsumer,
  CognitiveModelRequest,
  CognitiveSnapshotRecord,
  CognitiveSnapshotStatus,
  CompleteCognitiveSnapshotOptions,
  PrepareCognitiveSnapshotInput,
} from "@traceforge/cognitive-runtime";

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
    request: JSON.parse(row.request_json) as CognitiveSnapshotRecord["request"],
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

export class SqliteCognitiveSnapshotStore implements CognitiveSnapshotPersistencePort {
  private readonly runtime: CognitiveSnapshotRuntime;

  constructor(private readonly sqlite: Database.Database, events?: ScenarioAgentEventWriter) {
    const eventPort: CognitiveSnapshotEventPort | undefined = events
      ? { append: (event) => this.appendLifecycleEvent(events, event) }
      : undefined;
    this.runtime = new CognitiveSnapshotRuntime(this, eventPort);
  }

  recoverPrepared(at: string): number {
    return this.runtime.recoverPrepared(at);
  }

  prepare(input: PrepareCognitiveSnapshotInput): CognitiveSnapshotRecord {
    return this.runtime.prepare(input);
  }

  complete(
    id: string,
    output: unknown,
    at: string,
    options: CompleteCognitiveSnapshotOptions = {},
  ): CognitiveSnapshotRecord {
    return this.runtime.complete(id, output, at, options);
  }

  fail(id: string, error: unknown, at: string): CognitiveSnapshotRecord {
    return this.runtime.fail(id, error, at);
  }

  replay(input: { sourceId: string; id: string; model: LlmProvider; now: () => string }): Promise<CognitiveSnapshotRecord> {
    return this.runtime.replay(input);
  }

  get(id: string): CognitiveSnapshotRecord | undefined {
    return this.getStored(id)?.record;
  }

  list(runId: string, consumer?: CognitiveConsumer): CognitiveSnapshotRecord[] {
    const rows = (consumer
      ? this.sqlite.prepare(`SELECT ${columns} FROM scenario_cognitive_snapshots WHERE run_id = ? AND consumer = ? ORDER BY created_at ASC`).all(runId, consumer)
      : this.sqlite.prepare(`SELECT ${columns} FROM scenario_cognitive_snapshots WHERE run_id = ? ORDER BY created_at ASC`).all(runId)) as SnapshotRow[];
    return rows.map(parseRow);
  }

  getStored(id: string): StoredCognitiveSnapshot | undefined {
    const row = this.row(id);
    return row ? { record: parseRow(row), requestFingerprint: row.request_fingerprint, outputJson: row.output_json } : undefined;
  }

  insertPrepared(record: CognitiveSnapshotRecord, requestFingerprint: string): void {
    this.sqlite.prepare(`
      INSERT INTO scenario_cognitive_snapshots
        (id, parent_snapshot_id, consumer, run_id, case_id, work_id, evaluation_id,
         source_run_revision, source_graph_revision, semantic_fingerprint, request_fingerprint,
         request_json, context_manifest_json, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?)
    `).run(
      record.id,
      record.parentSnapshotId,
      record.consumer,
      record.runId,
      record.caseId,
      record.workId,
      record.evaluationId,
      record.sourceRunRevision,
      record.sourceGraphRevision,
      record.semanticFingerprint,
      requestFingerprint,
      JSON.stringify(record.request),
      JSON.stringify(record.contextManifest),
      record.createdAt,
    );
  }

  listPrepared(): StoredCognitiveSnapshot[] {
    return (this.sqlite.prepare(`SELECT ${columns} FROM scenario_cognitive_snapshots WHERE status = 'prepared'`)
      .all() as SnapshotRow[])
      .map((row) => ({ record: parseRow(row), requestFingerprint: row.request_fingerprint, outputJson: row.output_json }));
  }

  markCompleted(id: string, _output: unknown, outputJson: string, at: string): void {
    this.sqlite.prepare(`
      UPDATE scenario_cognitive_snapshots
      SET status = 'completed', output_json = ?, error = NULL, completed_at = ? WHERE id = ?
    `).run(outputJson, at, id);
  }

  markFailed(id: string, error: string, at: string): boolean {
    return this.sqlite.prepare(`
      UPDATE scenario_cognitive_snapshots
      SET status = 'failed', error = ?, completed_at = ? WHERE id = ? AND status != 'completed'
    `).run(error, at, id).changes === 1;
  }

  failAllPrepared(error: string, at: string): number {
    return this.sqlite.prepare(`
      UPDATE scenario_cognitive_snapshots
      SET status = 'failed', error = ?, completed_at = ? WHERE status = 'prepared'
    `).run(error, at).changes;
  }

  private row(id: string): SnapshotRow | undefined {
    return this.sqlite.prepare(`SELECT ${columns} FROM scenario_cognitive_snapshots WHERE id = ?`).get(id) as SnapshotRow | undefined;
  }

  private appendLifecycleEvent(events: ScenarioAgentEventWriter, event: CognitiveSnapshotLifecycleEvent): void {
    const snapshot = event.snapshot;
    if (event.type === "turn_started") {
      events.append({
        method: "turn/started",
        runId: snapshot.runId,
        caseId: snapshot.caseId,
        workId: snapshot.workId,
        turnId: snapshot.id,
        role: snapshot.consumer,
        createdAt: event.at,
        params: {
          agentInstanceId: event.agentInstanceId,
          sourceRunRevision: snapshot.sourceRunRevision,
          sourceGraphRevision: snapshot.sourceGraphRevision,
        },
      });
      return;
    }
    if (event.type === "turn_progress") {
      events.append({
        method: "turn/progress",
        runId: snapshot.runId,
        caseId: snapshot.caseId,
        workId: snapshot.workId,
        turnId: snapshot.id,
        role: snapshot.consumer,
        createdAt: event.at,
        params: { phase: event.phase, summary: event.summary, refs: event.refs },
      });
      return;
    }
    events.append({
      method: "turn/completed",
      runId: snapshot.runId,
      caseId: snapshot.caseId,
      workId: snapshot.workId,
      turnId: snapshot.id,
      role: snapshot.consumer,
      createdAt: event.at,
      params: { status: event.status, outcome: event.outcome, checkpointRef: null, error: event.error },
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
    if (!store.get(snapshotId)) return reply.code(404).send({ error: `Unknown cognitive snapshot ${snapshotId}` });
    if (!providerReady()) return reply.code(409).send({ error: "LLM provider is not ready" });
    const id = createId();
    try {
      return await store.replay({ sourceId: snapshotId, id, model: provider, now });
    } catch {
      return reply.code(502).send(store.get(id));
    }
  });
}
