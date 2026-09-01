import type { ScenarioRunState, WorkerDescriptor } from "@traceforge/orchestration-core";
import { LeaseLostError } from "./runtime.js";
import type {
  WorkerAssignment,
  WorkerControlPlaneClient,
  WorkerOutputDraft,
} from "./model.js";

interface CommandResponse { state: ScenarioRunState }
export interface WorkerControlPlaneTransportLimits { timeoutMs: number; maximumResponseBytes: number; maximumRequestBytes: number }

export class HttpWorkerControlPlaneClient implements WorkerControlPlaneClient {
  private readonly limits: WorkerControlPlaneTransportLimits;
  constructor(
    private readonly baseUrl: string,
    private readonly fetcher: typeof fetch = fetch,
    limits: Partial<WorkerControlPlaneTransportLimits> = {},
  ) {
    this.limits = { timeoutMs: 10000, maximumResponseBytes: 4 * 1024 * 1024, maximumRequestBytes: 1024 * 1024, ...limits };
    if (!Object.values(this.limits).every((n) => Number.isSafeInteger(n) && n > 0) || this.limits.timeoutMs > 60000
      || this.limits.maximumRequestBytes > 16 * 1024 * 1024 || this.limits.maximumResponseBytes > 16 * 1024 * 1024) {
      throw new Error("Invalid Worker control-plane transport limits");
    }
  }

  async register(worker: WorkerDescriptor): Promise<void> {
    await this.request("POST", "/api/scenarios/workers", {
      id: worker.id,
      roles: worker.roles,
      capabilities: worker.capabilities,
      maxConcurrentWork: worker.maxConcurrentWork,
      status: worker.status,
    });
  }

  async heartbeat(workerId: string): Promise<void> {
    await this.request("POST", `/api/scenarios/workers/${encodeURIComponent(workerId)}/heartbeat`, {});
  }

  async assignments(workerId: string): Promise<WorkerAssignment[]> {
    return this.request("GET", `/api/scenarios/workers/${encodeURIComponent(workerId)}/assignments`) as Promise<WorkerAssignment[]>;
  }

  async refresh(assignment: WorkerAssignment): Promise<WorkerAssignment> {
    const current = await this.assignments(assignment.work.workerId ?? "");
    const refreshed = current.find((candidate) => candidate.runId === assignment.runId && candidate.work.id === assignment.work.id && candidate.leaseId === assignment.leaseId);
    if (!refreshed) throw new LeaseLostError(`Lease ${assignment.leaseId} no longer owns work ${assignment.work.id}`);
    return refreshed;
  }

  async renew(assignment: WorkerAssignment, commandId: string): Promise<WorkerAssignment> {
    const response = await this.command(assignment, "renew", { commandId });
    return this.assignmentFromState(assignment, response.state);
  }

  async checkpoint(
    assignment: WorkerAssignment,
    input: { commandId: string; checkpointId: string; progressSummary: string; payloadRef: string },
  ): Promise<WorkerAssignment> {
    const response = await this.command(assignment, "checkpoint", input);
    return this.assignmentFromState(assignment, response.state);
  }

  async complete(
    assignment: WorkerAssignment,
    commandId: string,
    summary: string,
    outputs: WorkerOutputDraft[],
  ): Promise<void> {
    await this.command(assignment, "complete", { commandId, summary, outputs });
  }

  async requestApproval(assignment: WorkerAssignment, input: {
    commandId: string;
    approvalId: string;
    actionKey: string;
    toolName: string;
    risk: "read_only" | "bounded_write" | "privileged" | "destructive";
    rationale: string;
    inputRef: string;
  }): Promise<void> {
    await this.command(assignment, "request-approval", input);
  }

  async fail(assignment: WorkerAssignment, commandId: string, reason: string): Promise<void> {
    await this.command(assignment, "fail", { commandId, reason });
  }

  async block(assignment: WorkerAssignment, commandId: string, reason: string): Promise<void> {
    await this.command(assignment, "block", { commandId, reason });
  }

  private command(assignment: WorkerAssignment, action: string, body: Record<string, unknown>): Promise<CommandResponse> {
    return this.request(
      "POST",
      `/api/scenarios/runs/${encodeURIComponent(assignment.runId)}/work/${encodeURIComponent(assignment.work.id)}/${action}`,
      {
        ...body,
        expectedRevision: assignment.runRevision,
        workerId: assignment.work.workerId,
        leaseId: assignment.leaseId,
      },
    ) as Promise<CommandResponse>;
  }

  private assignmentFromState(previous: WorkerAssignment, state: ScenarioRunState): WorkerAssignment {
    const work = state.workItems.find((candidate) => candidate.id === previous.work.id);
    if (!work || work.status !== "running" || work.leaseId !== previous.leaseId || !work.leaseExpiresAt) {
      throw new LeaseLostError(`Lease ${previous.leaseId} no longer owns work ${previous.work.id}`);
    }
    return {
      ...previous,
      runRevision: state.revision,
      leaseExpiresAt: work.leaseExpiresAt,
      runContext: {
        ...previous.runContext,
        activePhaseId: state.activePhaseId,
        directives: state.directives.filter((directive) => directive.targetWorkId === work.id),
      },
      work,
    };
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    if (encoded && Buffer.byteLength(encoded) > this.limits.maximumRequestBytes) throw new Error("Worker control-plane request exceeds its size limit");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("Worker control-plane request timed out")), this.limits.timeoutMs);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await this.fetcher(new URL(path, this.baseUrl), {
        method, redirect: "error", signal: controller.signal,
        headers: encoded === undefined ? undefined : { "content-type": "application/json" }, body: encoded,
      });
      if (Number(response.headers.get("content-length")) > this.limits.maximumResponseBytes) {
        void response.body?.cancel().catch(() => {});
        throw new Error("Worker control-plane response exceeds its size limit");
      }
      const chunks: Uint8Array[] = []; let bytes = 0;
      reader = response.body?.getReader();
      if (reader) while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > this.limits.maximumResponseBytes) throw new Error("Worker control-plane response exceeds its size limit");
        chunks.push(chunk.value);
      }
      let payload: unknown;
      try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { throw new Error(`Worker control plane returned invalid JSON (HTTP ${response.status})`); }
      if (response.ok) return payload;
      const detail = payload && typeof payload === "object" && "error" in payload ? payload.error : undefined;
      const message = typeof detail === "string" ? detail.slice(0, 1024) : `Control plane returned HTTP ${response.status}`;
      if (response.status === 409 || response.status === 403 || response.status === 404) throw new LeaseLostError(message);
      throw new Error(message);
    } finally {
      clearTimeout(timer);
      if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
      controller.abort();
    }
  }
}
