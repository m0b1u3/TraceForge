import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  RevisionConflictError,
  canonicalJson,
  replayScenario,
  type DurableScenarioRuntime,
  type ScenarioRunState,
  type WorkerDescriptor,
} from "@traceforge/orchestration-core";
import type { SqliteScenarioEventStore, SqliteWorkerRegistry } from "./scenario-event-store.js";

export interface RunRecoveryAction {
  runId: string;
  workId: string;
  leaseId: string;
  action: "preserved" | "requeued" | "blocked";
  reason: string;
  checkpointRef: string | null;
}

export interface RunRecoveryReport {
  recoveredAt: string;
  inspectedRunIds: string[];
  pausedRunIds: string[];
  pendingApprovalIds: string[];
  actions: RunRecoveryAction[];
  issues: Array<{ runId: string; reason: string }>;
}

export interface RunRecoveryDiagnostic {
  runId: string;
  status: ScenarioRunState["status"];
  runRevision: number;
  projectionMatchesReplay: boolean;
  projectionIssues: string[];
  activeLeases: Array<{
    workId: string; workerId: string; leaseId: string; leaseExpiresAt: string;
    checkpointRef: string | null; resumableFromCheckpoint: boolean;
  }>;
  queuedCheckpointWorkIds: string[];
  pendingApprovalIds: string[];
  suspension: ScenarioRunState["suspension"];
}

export interface RunReplayProjection {
  runId: string;
  revision: number;
  currentRevision: number;
  eventCount: number;
  stateDigest: string;
  isCurrent: boolean;
  state: ScenarioRunState;
}

function heartbeatIsStale(worker: WorkerDescriptor | undefined, at: string, timeoutMs: number): boolean {
  if (!worker || worker.status !== "online") return true;
  const age = Date.parse(at) - Date.parse(worker.heartbeatAt);
  return !Number.isFinite(age) || age < 0 || age > timeoutMs;
}

export class ScenarioRunRecoveryService {
  constructor(
    private readonly runtime: DurableScenarioRuntime,
    private readonly events: SqliteScenarioEventStore,
    private readonly workers: SqliteWorkerRegistry,
    private readonly heartbeatTimeoutMs = 30_000,
  ) {
    if (heartbeatTimeoutMs < 1) throw new Error("Recovery heartbeat timeout must be positive");
  }

  recoverAll(at: string): RunRecoveryReport {
    if (!Number.isFinite(Date.parse(at))) throw new Error("Recovery time must be valid");
    const report: RunRecoveryReport = {
      recoveredAt: at,
      inspectedRunIds: [],
      pausedRunIds: [],
      pendingApprovalIds: [],
      actions: [],
      issues: [],
    };
    const workerById = new Map(this.workers.list().map((worker) => [worker.id, worker]));
    for (const summary of this.events.listRuns().filter((run) => run.status === "running" || run.status === "paused")) {
      report.inspectedRunIds.push(summary.runId);
      let state: ScenarioRunState | undefined;
      try {
        state = this.runtime.load(summary.runId);
      } catch (error) {
        report.issues.push({ runId: summary.runId, reason: `Event replay failed: ${error instanceof Error ? error.message : String(error)}` });
        continue;
      }
      if (!state) {
        report.issues.push({ runId: summary.runId, reason: "Run projection exists without an event-sourced state" });
        continue;
      }
      report.pendingApprovalIds.push(...state.workItems.flatMap((work) => work.pendingApproval ? [work.pendingApproval.id] : []));
      if (state.status === "paused") {
        report.pausedRunIds.push(state.id);
        continue;
      }
      for (const work of state.workItems.filter((candidate) => candidate.status === "running" && candidate.leaseId && candidate.leaseExpiresAt)) {
        const leaseId = work.leaseId!;
        const projection = this.workers.listLeases(state.id).find((lease) => lease.workId === work.id);
        const worker = work.workerId ? workerById.get(work.workerId) : undefined;
        const expired = Date.parse(work.leaseExpiresAt!) <= Date.parse(at);
        const projectionMatches = projection?.leaseId === leaseId && projection.workerId === work.workerId;
        const stale = heartbeatIsStale(worker, at, this.heartbeatTimeoutMs);
        if (!expired && projectionMatches && !stale) {
          report.actions.push({
            runId: state.id, workId: work.id, leaseId, action: "preserved",
            reason: "Live Worker and matching lease can continue from durable state",
            checkpointRef: work.latestCheckpoint?.payloadRef ?? null,
          });
          continue;
        }
        const reason = expired
          ? "Startup recovery reclaimed an expired execution lease"
          : !projectionMatches
            ? "Startup recovery repaired an orphaned or mismatched lease projection"
            : "Startup recovery reclaimed a lease owned by an unavailable Worker";
        try {
          const result = this.executeRecovery(state.id, work.id, leaseId, expired, reason, at);
          state = result;
          const recovered = result.workItems.find((candidate) => candidate.id === work.id)!;
          report.actions.push({
            runId: state.id,
            workId: work.id,
            leaseId,
            action: recovered.status === "blocked" ? "blocked" : "requeued",
            reason: recovered.error ?? reason,
            checkpointRef: recovered.latestCheckpoint?.payloadRef ?? null,
          });
        } catch (error) {
          report.issues.push({ runId: state.id, reason: `Failed to recover Work ${work.id}: ${error instanceof Error ? error.message : String(error)}` });
        }
      }
    }
    return report;
  }

  diagnose(runId: string): RunRecoveryDiagnostic | undefined {
    const summary = this.events.listRuns().find((run) => run.runId === runId);
    const state = this.runtime.load(runId);
    if (!summary || !state) return undefined;
    const issues: string[] = [];
    if (summary.revision !== state.revision) issues.push(`summary revision ${summary.revision} differs from replay revision ${state.revision}`);
    if (summary.status !== state.status) issues.push(`summary status ${summary.status} differs from replay status ${state.status}`);
    if (summary.activePhaseId !== state.activePhaseId) issues.push(`summary phase ${summary.activePhaseId} differs from replay phase ${state.activePhaseId}`);
    const leases = this.workers.listLeases(runId);
    for (const lease of leases) {
      const work = state.workItems.find((candidate) => candidate.id === lease.workId);
      if (!work || work.status !== "running" || work.leaseId !== lease.leaseId || work.workerId !== lease.workerId) {
        issues.push(`lease ${lease.leaseId} does not match replayed Work ownership`);
      }
    }
    for (const work of state.workItems.filter((candidate) => candidate.status === "running")) {
      if (!leases.some((lease) => lease.workId === work.id && lease.leaseId === work.leaseId)) {
        issues.push(`running Work ${work.id} has no matching lease projection`);
      }
    }
    return {
      runId,
      status: state.status,
      runRevision: state.revision,
      projectionMatchesReplay: issues.length === 0,
      projectionIssues: issues,
      activeLeases: state.workItems.filter((work) => work.status === "running" && work.leaseId && work.leaseExpiresAt).map((work) => ({
        workId: work.id,
        workerId: work.workerId!,
        leaseId: work.leaseId!,
        leaseExpiresAt: work.leaseExpiresAt!,
        checkpointRef: work.latestCheckpoint?.payloadRef ?? null,
        resumableFromCheckpoint: Boolean(work.latestCheckpoint),
      })),
      queuedCheckpointWorkIds: state.workItems.filter((work) => work.status === "queued" && work.resumeFromCheckpoint).map((work) => work.id),
      pendingApprovalIds: state.workItems.flatMap((work) => work.pendingApproval ? [work.pendingApproval.id] : []),
      suspension: state.suspension,
    };
  }

  replay(runId: string, revision?: number): RunReplayProjection | undefined {
    const stream = this.events.load(runId);
    if (stream.revision === 0) return undefined;
    const through = revision ?? stream.revision;
    if (!Number.isInteger(through) || through < 1 || through > stream.revision) {
      throw new Error(`Replay revision must be between 1 and ${stream.revision}`);
    }
    const state = replayScenario(stream.events.slice(0, through));
    if (!state) throw new Error(`Run ${runId} has no replayable state at revision ${through}`);
    return {
      runId,
      revision: through,
      currentRevision: stream.revision,
      eventCount: through,
      stateDigest: createHash("sha256").update(canonicalJson(state)).digest("hex"),
      isCurrent: through === stream.revision,
      state,
    };
  }

  private executeRecovery(runId: string, workId: string, leaseId: string, expired: boolean, reason: string, at: string): ScenarioRunState {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const state = this.runtime.load(runId);
      if (!state) throw new Error(`Unknown Run ${runId}`);
      const work = state.workItems.find((candidate) => candidate.id === workId);
      if (!work || work.status !== "running" || work.leaseId !== leaseId) return state;
      try {
        return this.runtime.execute({
          runId,
          commandId: `startup-recovery:${leaseId}`,
          expectedRevision: state.revision,
          command: expired
            ? { type: "expire_lease", workId, leaseId, at }
            : { type: "interrupt_work", workId, leaseId, reason, at },
        }).state;
      } catch (error) {
        if (!(error instanceof RevisionConflictError) || attempt === 3) throw error;
      }
    }
    throw new Error(`Recovery for lease ${leaseId} exhausted concurrency retries`);
  }
}

export function registerScenarioRunRecoveryRoutes(app: FastifyInstance, service: ScenarioRunRecoveryService): void {
  app.get("/api/scenarios/runs/:runId/recovery", async (request, reply) => {
    try {
      const { runId } = z.object({ runId: z.string().min(1) }).parse(request.params);
      return service.diagnose(runId) ?? reply.code(404).send({ error: `Unknown scenario run ${runId}` });
    } catch (error) { return sendError(reply, error); }
  });
  app.get("/api/scenarios/runs/:runId/replay", async (request, reply) => {
    try {
      const { runId } = z.object({ runId: z.string().min(1) }).parse(request.params);
      const { revision } = z.object({ revision: z.coerce.number().int().min(1).optional() }).parse(request.query);
      return service.replay(runId, revision) ?? reply.code(404).send({ error: `Unknown scenario run ${runId}` });
    } catch (error) { return sendError(reply, error); }
  });
}

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof z.ZodError) return reply.code(400).send({ error: "invalid request", issues: error.issues });
  return reply.code(400).send({ error: error instanceof Error ? error.message : "Run recovery failed" });
}
