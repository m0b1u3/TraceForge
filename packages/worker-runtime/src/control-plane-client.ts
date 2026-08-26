import type { ScenarioRunState, WorkerDescriptor } from "@traceforge/orchestration-core";
import { LeaseLostError } from "./runtime.js";
import type {
  WorkerAssignment,
  WorkerControlPlaneClient,
  WorkerOutputDraft,
} from "./model.js";

interface CommandResponse { state: ScenarioRunState }

export class HttpWorkerControlPlaneClient implements WorkerControlPlaneClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

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
    const response = await this.fetcher(new URL(path, this.baseUrl), {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({ error: `HTTP ${response.status}` })) as { error?: string };
    if (response.ok) return payload;
    const message = payload.error ?? `Control plane returned HTTP ${response.status}`;
    if (response.status === 409 || response.status === 403 || response.status === 404) throw new LeaseLostError(message);
    throw new Error(message);
  }
}
