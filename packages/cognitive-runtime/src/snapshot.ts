import { createHash } from "node:crypto";
import { canonicalJson } from "@traceforge/orchestration-core";
import type { AgentTurnOutcome, AgentTurnPhase } from "@traceforge/shared";

export type CognitiveConsumer = "planner" | "observer" | "worker" | "replay";
export type CognitiveSnapshotStatus = "prepared" | "completed" | "failed";

export interface CognitiveModelRequest {
  system: string;
  user: string;
  schema: Record<string, unknown>;
}

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
  request: CognitiveModelRequest;
  contextManifest: Record<string, unknown>;
  status: CognitiveSnapshotStatus;
  output: unknown;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface StoredCognitiveSnapshot {
  record: CognitiveSnapshotRecord;
  requestFingerprint: string;
  outputJson: string | null;
}

export interface CognitiveSnapshotPersistencePort {
  getStored(id: string): StoredCognitiveSnapshot | undefined;
  insertPrepared(record: CognitiveSnapshotRecord, requestFingerprint: string): void;
  listPrepared(): StoredCognitiveSnapshot[];
  markCompleted(id: string, output: unknown, outputJson: string, at: string): void;
  markFailed(id: string, error: string, at: string): boolean;
  failAllPrepared(error: string, at: string): number;
}

export type CognitiveSnapshotLifecycleEvent =
  | {
      type: "turn_started";
      snapshot: CognitiveSnapshotRecord;
      agentInstanceId: string;
      at: string;
    }
  | {
      type: "turn_progress";
      snapshot: CognitiveSnapshotRecord;
      phase: AgentTurnPhase;
      summary: string;
      refs: string[];
      at: string;
    }
  | {
      type: "turn_completed";
      snapshot: CognitiveSnapshotRecord;
      status: "completed" | "failed" | "interrupted";
      outcome: AgentTurnOutcome | null;
      error: string | null;
      at: string;
    };

export interface CognitiveSnapshotEventPort {
  append(event: CognitiveSnapshotLifecycleEvent): void;
}

export interface PrepareCognitiveSnapshotInput {
  id: string;
  agentInstanceId?: string;
  parentSnapshotId?: string;
  consumer: CognitiveConsumer;
  runId: string;
  caseId: string;
  workId?: string;
  evaluationId?: string;
  sourceRunRevision: number;
  sourceGraphRevision?: number;
  semanticFingerprint?: string;
  request: CognitiveModelRequest;
  contextManifest: Record<string, unknown>;
  at: string;
}

export interface CompleteCognitiveSnapshotOptions {
  deferTurnCompletion?: boolean;
  decisionKind?: string;
  outcome?: AgentTurnOutcome;
}

export interface CognitiveSnapshotModelPort {
  extractJson(request: CognitiveModelRequest): Promise<unknown>;
}

export function cognitiveRequestFingerprint(request: CognitiveModelRequest): string {
  return createHash("sha256")
    .update(canonicalJson({ system: request.system, user: request.user, schema: request.schema }))
    .digest("hex");
}

function jsonRequest(request: CognitiveModelRequest): CognitiveModelRequest {
  return { system: request.system, user: request.user, schema: request.schema };
}

export class CognitiveSnapshotRuntime {
  constructor(
    private readonly persistence: CognitiveSnapshotPersistencePort,
    private readonly events?: CognitiveSnapshotEventPort,
  ) {}

  prepare(input: PrepareCognitiveSnapshotInput): CognitiveSnapshotRecord {
    const request = jsonRequest(input.request);
    const fingerprint = cognitiveRequestFingerprint(request);
    const existing = this.persistence.getStored(input.id);
    if (existing) {
      if (existing.requestFingerprint !== fingerprint) {
        throw new Error(`Cognitive snapshot ${input.id} was reused with different model input`);
      }
      return existing.record;
    }
    const prepared: CognitiveSnapshotRecord = {
      id: input.id,
      parentSnapshotId: input.parentSnapshotId ?? null,
      consumer: input.consumer,
      runId: input.runId,
      caseId: input.caseId,
      workId: input.workId ?? null,
      evaluationId: input.evaluationId ?? null,
      sourceRunRevision: input.sourceRunRevision,
      sourceGraphRevision: input.sourceGraphRevision ?? null,
      semanticFingerprint: input.semanticFingerprint ?? null,
      request,
      contextManifest: input.contextManifest,
      status: "prepared",
      output: null,
      error: null,
      createdAt: input.at,
      completedAt: null,
    };
    this.persistence.insertPrepared(prepared, fingerprint);
    const created = this.required(input.id);
    this.events?.append({
      type: "turn_started",
      snapshot: created.record,
      agentInstanceId: input.agentInstanceId ?? `${created.record.consumer}:${created.record.runId}`,
      at: input.at,
    });
    this.progress(created.record, "prepared", "Agent Turn prepared", [], input.at);
    this.progress(created.record, "contextBuilt", "Bounded context snapshot persisted", [created.record.id], input.at);
    this.progress(created.record, "modelInvoked", "Model invocation requested", [created.record.id], input.at);
    return created.record;
  }

  complete(
    id: string,
    output: unknown,
    at: string,
    options: CompleteCognitiveSnapshotOptions = {},
  ): CognitiveSnapshotRecord {
    const stored = this.required(id);
    const serialized = JSON.stringify(output);
    if (serialized === undefined) throw new Error(`Cognitive snapshot ${id} output is not JSON-serializable`);
    if (stored.record.status === "completed") {
      if (stored.outputJson !== serialized) throw new Error(`Cognitive snapshot ${id} already has a different output`);
      return stored.record;
    }
    this.persistence.markCompleted(id, output, serialized, at);
    const completed = this.required(id).record;
    this.progress(
      completed,
      "decisionProduced",
      `Structured decision produced${options.decisionKind ? `: ${options.decisionKind}` : ""}`,
      [completed.id],
      at,
    );
    if (!options.deferTurnCompletion) {
      this.events?.append({
        type: "turn_completed",
        snapshot: completed,
        status: "completed",
        outcome: options.outcome ?? "finish",
        error: null,
        at,
      });
    }
    return completed;
  }

  fail(id: string, error: unknown, at: string): CognitiveSnapshotRecord {
    this.required(id);
    const message = error instanceof Error ? error.message : String(error);
    const changed = this.persistence.markFailed(id, message, at);
    const failed = this.required(id).record;
    if (changed) {
      this.events?.append({
        type: "turn_completed",
        snapshot: failed,
        status: "failed",
        outcome: null,
        error: message,
        at,
      });
    }
    return failed;
  }

  recoverPrepared(at: string): number {
    const message = "runtime restarted before cognitive evaluation completed";
    const pending = this.persistence.listPrepared();
    const changed = this.persistence.failAllPrepared(message, at);
    for (const stored of pending) {
      this.events?.append({
        type: "turn_completed",
        snapshot: stored.record,
        status: "interrupted",
        outcome: null,
        error: message,
        at,
      });
    }
    return changed;
  }

  async replay(input: {
    sourceId: string;
    id: string;
    model: CognitiveSnapshotModelPort;
    now: () => string;
  }): Promise<CognitiveSnapshotRecord> {
    const source = this.required(input.sourceId).record;
    this.prepare({
      id: input.id,
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
      at: input.now(),
    });
    try {
      const output = await input.model.extractJson(source.request);
      return this.complete(input.id, output, input.now());
    } catch (error) {
      this.fail(input.id, error, input.now());
      throw error;
    }
  }

  private progress(snapshot: CognitiveSnapshotRecord, phase: AgentTurnPhase, summary: string, refs: string[], at: string): void {
    this.events?.append({ type: "turn_progress", snapshot, phase, summary, refs, at });
  }

  private required(id: string): StoredCognitiveSnapshot {
    const stored = this.persistence.getStored(id);
    if (!stored) throw new Error(`Unknown cognitive snapshot ${id}`);
    return stored;
  }
}
