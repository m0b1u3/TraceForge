import type { WorkerDescriptor } from "@traceforge/orchestration-core";
import type {
  ExecutionRisk,
  ExecutionToolGateway,
  OutputDistiller,
  WorkerAssignment,
  WorkerCheckpointDocument,
  WorkerCheckpointStore,
  WorkerControlPlaneClient,
  WorkerModel,
  WorkerObserver,
  WorkerTranscriptEntry,
} from "./model.js";

export interface LeaseWorkerOptions {
  maxTurns: number;
  maxDistilledCharacters: number;
  renewBeforeMs: number;
  repeatedFailureLimit: number;
  onLifecycleEvent?: (event: WorkerLifecycleEvent) => void;
}

export type WorkerLifecycleEvent =
  | { type: "tool_started"; assignment: WorkerAssignment; turnId: string; invocationId: string; tool: string; risk: ExecutionRisk }
  | { type: "tool_completed"; assignment: WorkerAssignment; turnId: string; invocationId: string; tool: string; risk: ExecutionRisk; status: "completed" | "failed" | "waitingApproval"; summary: string; refs: string[] };

export interface WorkerRunResult {
  runId: string;
  workId: string;
  outcome: "completed" | "waiting_approval" | "blocked" | "failed" | "lease_lost";
  turns: number;
  reason?: string;
}

const defaults: LeaseWorkerOptions = {
  maxTurns: 24,
  maxDistilledCharacters: 8_000,
  renewBeforeMs: 20_000,
  repeatedFailureLimit: 3,
};

export class LeaseLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeaseLostError";
  }
}

export class LeaseWorkerRuntime {
  private readonly options: LeaseWorkerOptions;

  constructor(
    private readonly worker: WorkerDescriptor,
    private readonly control: WorkerControlPlaneClient,
    private readonly model: WorkerModel,
    private readonly tools: ExecutionToolGateway,
    private readonly observer: WorkerObserver,
    private readonly checkpoints: WorkerCheckpointStore,
    private readonly distiller: OutputDistiller,
    options: Partial<LeaseWorkerOptions> = {},
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.options = { ...defaults, ...options };
    if (this.options.maxTurns < 1 || this.options.maxDistilledCharacters < 256 || this.options.renewBeforeMs < 1 || this.options.repeatedFailureLimit < 1) {
      throw new Error("Worker runtime limits must be positive and distilled output must allow at least 256 characters");
    }
  }

  async register(): Promise<void> {
    await this.control.register({ ...this.worker, heartbeatAt: this.now() });
  }

  async pollOnce(): Promise<WorkerRunResult | undefined> {
    await this.control.heartbeat(this.worker.id);
    const assignments = await this.control.assignments(this.worker.id);
    const assignment = assignments
      .filter((candidate) => candidate.work.status === "running")
      .sort((left, right) => right.work.priority - left.work.priority || left.work.createdAt.localeCompare(right.work.createdAt))[0];
    if (!assignment) return undefined;
    return this.execute(assignment);
  }

  async execute(initialAssignment: WorkerAssignment): Promise<WorkerRunResult> {
    let assignment = initialAssignment;
    let checkpoint: WorkerCheckpointDocument;
    try {
      checkpoint = await this.restore(assignment);
    } catch (error) {
      const reason = `Checkpoint recovery failed: ${error instanceof Error ? error.message : String(error)}`;
      try {
        await this.control.block(assignment, `block:${assignment.leaseId}:checkpoint-recovery`, reason);
      } catch (failure) {
        if (failure instanceof LeaseLostError) {
          return { runId: assignment.runId, workId: assignment.work.id, outcome: "lease_lost", turns: 0, reason };
        }
        throw failure;
      }
      return { runId: assignment.runId, workId: assignment.work.id, outcome: "blocked", turns: 0, reason };
    }
    let repeatedFailureCount = 0;

    try {
      for (let turn = checkpoint.turn + 1; turn <= this.options.maxTurns; turn += 1) {
        assignment = await this.control.refresh(assignment);
        this.applyRunDirectives(assignment, checkpoint);
        assignment = await this.renewIfNeeded(assignment, turn);
        const catalog = await this.tools.catalog(this.worker, assignment);
        const decision = await this.model.decide({
          worker: this.worker,
          assignment,
          tools: catalog,
          transcript: checkpoint.transcript,
          steering: checkpoint.steering,
        });
        checkpoint.transcript.push({ turn, kind: "model", summary: this.describeDecision(decision), refs: [] });

        const observation = await this.observer.review({
          worker: this.worker,
          assignment,
          turn,
          decision,
          transcript: checkpoint.transcript,
          repeatedFailureCount,
        });
        if (observation.action === "stop") {
          assignment = await this.persistCheckpoint(assignment, checkpoint, turn, observation.reason);
          await this.control.block(assignment, `block:${assignment.leaseId}:observer:${turn}`, observation.reason);
          return { runId: assignment.runId, workId: assignment.work.id, outcome: "blocked", turns: turn, reason: observation.reason };
        }
        if (observation.action === "steer") {
          checkpoint.steering.push(observation.instruction);
          checkpoint.transcript.push({ turn, kind: "observer", summary: observation.instruction, refs: [] });
          assignment = await this.persistCheckpoint(assignment, checkpoint, turn, "Observer correction persisted");
          continue;
        }

        if (decision.type === "complete") {
          const invalidOutput = this.invalidOutputReason(assignment, checkpoint.transcript, decision.outputs);
          if (invalidOutput) {
            checkpoint.steering.push(invalidOutput);
            checkpoint.transcript.push({ turn, kind: "observer", summary: invalidOutput, refs: [] });
            assignment = await this.persistCheckpoint(assignment, checkpoint, turn, "Ungrounded output rejected");
            continue;
          }
          await this.control.complete(assignment, `complete:${assignment.leaseId}`, decision.summary, decision.outputs);
          return { runId: assignment.runId, workId: assignment.work.id, outcome: "completed", turns: turn };
        }
        if (decision.type === "block") {
          assignment = await this.persistCheckpoint(assignment, checkpoint, turn, decision.reason);
          await this.control.block(assignment, `block:${assignment.leaseId}:model`, decision.reason);
          return { runId: assignment.runId, workId: assignment.work.id, outcome: "blocked", turns: turn, reason: decision.reason };
        }

        if (checkpoint.completedInvocationIds.includes(decision.invocation.id)) {
          checkpoint.steering.push(`Invocation ${decision.invocation.id} was already committed; choose a new action or complete the work.`);
          assignment = await this.persistCheckpoint(assignment, checkpoint, turn, "Duplicate invocation suppressed");
          continue;
        }
        const knownTool = catalog.some((tool) => tool.name === decision.invocation.tool);
        if (!knownTool) {
          repeatedFailureCount += 1;
          checkpoint.transcript.push({ turn, kind: "tool", summary: `Rejected unknown or unauthorized tool ${decision.invocation.tool}`, refs: [] });
        } else {
          const toolSpec = catalog.find((tool) => tool.name === decision.invocation.tool)!;
          const turnId = decision.protocolTurnId ?? `work:${assignment.work.id}:attempt:${assignment.work.attempt}`;
          this.options.onLifecycleEvent?.({
            type: "tool_started", assignment, turnId, invocationId: decision.invocation.id,
            tool: decision.invocation.tool, risk: toolSpec.risk,
          });
          let result;
          try {
            result = await this.tools.execute({
              worker: this.worker,
              assignment,
              invocation: decision.invocation,
              idempotencyKey: `${assignment.work.idempotencyKey}:${decision.invocation.id}`,
            });
          } catch (error) {
            this.options.onLifecycleEvent?.({
              type: "tool_completed", assignment, turnId, invocationId: decision.invocation.id,
              tool: decision.invocation.tool, risk: toolSpec.risk, status: "failed",
              summary: error instanceof Error ? error.message : String(error), refs: [],
            });
            throw error;
          }
          const distilled = await this.distiller.distill(result, this.options.maxDistilledCharacters);
          this.options.onLifecycleEvent?.({
            type: "tool_completed", assignment, turnId, invocationId: decision.invocation.id,
            tool: decision.invocation.tool, risk: toolSpec.risk,
            status: result.status === "succeeded" ? "completed" : result.status === "approval_required" ? "waitingApproval" : "failed",
            summary: distilled.summary, refs: distilled.refs,
          });
          checkpoint.transcript.push({ turn, kind: "tool", summary: distilled.summary, refs: distilled.refs });
          repeatedFailureCount = result.status === "succeeded" ? 0 : repeatedFailureCount + 1;
          if (result.status === "approval_required") {
            const approvalId = result.approvalRef ?? `approval:${assignment.work.id}:${decision.invocation.id}`;
            const actionKey = `${assignment.work.idempotencyKey}:${decision.invocation.id}`;
            const reason = `Tool ${decision.invocation.tool} requires approval (${approvalId}); retry this exact invocation after approval.`;
            checkpoint.steering.push(reason);
            assignment = await this.persistCheckpoint(assignment, checkpoint, turn, reason);
            const inputRef = assignment.work.latestCheckpoint?.payloadRef;
            if (!inputRef) throw new Error("Approval checkpoint was not reflected in the assignment");
            const risk = catalog.find((tool) => tool.name === decision.invocation.tool)?.risk;
            if (!risk) throw new Error(`Approval tool ${decision.invocation.tool} disappeared from the catalog`);
            await this.control.requestApproval(assignment, {
              commandId: `request-approval:${approvalId}`,
              approvalId,
              actionKey,
              toolName: decision.invocation.tool,
              risk,
              rationale: decision.invocation.rationale,
              inputRef,
            });
            return { runId: assignment.runId, workId: assignment.work.id, outcome: "waiting_approval", turns: turn, reason };
          }
          checkpoint.completedInvocationIds.push(decision.invocation.id);
        }

        assignment = await this.persistCheckpoint(assignment, checkpoint, turn, `Turn ${turn} committed`);
        if (repeatedFailureCount >= this.options.repeatedFailureLimit) {
          const reason = `Execution stopped after ${repeatedFailureCount} consecutive failed or unauthorized actions`;
          await this.control.block(assignment, `block:${assignment.leaseId}:failures`, reason);
          return { runId: assignment.runId, workId: assignment.work.id, outcome: "blocked", turns: turn, reason };
        }
      }
      const reason = `Worker turn budget exhausted after ${this.options.maxTurns} turns`;
      assignment = await this.persistCheckpoint(assignment, checkpoint, this.options.maxTurns, reason);
      await this.control.block(assignment, `block:${assignment.leaseId}:budget`, reason);
      return { runId: assignment.runId, workId: assignment.work.id, outcome: "blocked", turns: this.options.maxTurns, reason };
    } catch (error) {
      if (error instanceof LeaseLostError) {
        return { runId: assignment.runId, workId: assignment.work.id, outcome: "lease_lost", turns: checkpoint.turn, reason: error.message };
      }
      const reason = error instanceof Error ? error.message : "Unknown worker runtime failure";
      try {
        await this.control.fail(assignment, `fail:${assignment.leaseId}`, reason);
      } catch (failure) {
        if (failure instanceof LeaseLostError) return { runId: assignment.runId, workId: assignment.work.id, outcome: "lease_lost", turns: checkpoint.turn, reason };
        throw failure;
      }
      return { runId: assignment.runId, workId: assignment.work.id, outcome: "failed", turns: checkpoint.turn, reason };
    }
  }

  private async restore(assignment: WorkerAssignment): Promise<WorkerCheckpointDocument> {
    const existing = assignment.work.latestCheckpoint;
    if (existing) {
      const document = await this.checkpoints.load(existing.payloadRef);
      if (document.runId !== assignment.runId || document.workId !== assignment.work.id) throw new Error("Checkpoint does not belong to this assignment");
      return { ...document, leaseId: assignment.leaseId };
    }
    return {
      version: 1,
      workerId: this.worker.id,
      runId: assignment.runId,
      workId: assignment.work.id,
      leaseId: assignment.leaseId,
      turn: 0,
      transcript: [{
        turn: 0,
        kind: "system",
        summary: "Work execution started",
        refs: [...new Set([assignment.runContext.scopeRef, ...assignment.work.evidenceRefs, ...assignment.work.hypothesisIds])],
      }],
      steering: [],
      completedInvocationIds: [],
      savedAt: this.now(),
    };
  }

  private async renewIfNeeded(assignment: WorkerAssignment, turn: number): Promise<WorkerAssignment> {
    if (Date.parse(assignment.leaseExpiresAt) - Date.parse(this.now()) > this.options.renewBeforeMs) return assignment;
    return this.control.renew(assignment, `renew:${assignment.leaseId}:${turn}`);
  }

  private applyRunDirectives(assignment: WorkerAssignment, checkpoint: WorkerCheckpointDocument): void {
    const consumed = new Set(checkpoint.transcript.flatMap((entry) => entry.refs.filter((ref) => ref.startsWith("run-directive:"))));
    for (const directive of assignment.runContext.directives) {
      const ref = `run-directive:${directive.id}`;
      if (consumed.has(ref)) continue;
      checkpoint.steering.push(directive.instruction);
      checkpoint.transcript.push({ turn: checkpoint.turn, kind: "observer", summary: directive.instruction, refs: [ref] });
    }
  }

  private async persistCheckpoint(
    assignment: WorkerAssignment,
    checkpoint: WorkerCheckpointDocument,
    turn: number,
    progressSummary: string,
  ): Promise<WorkerAssignment> {
    checkpoint.turn = turn;
    checkpoint.leaseId = assignment.leaseId;
    checkpoint.savedAt = this.now();
    const payloadRef = await this.checkpoints.save(checkpoint);
    return this.control.checkpoint(assignment, {
      commandId: `checkpoint:${assignment.leaseId}:${turn}`,
      checkpointId: `${assignment.work.id}:${assignment.work.attempt}:${turn}`,
      progressSummary,
      payloadRef,
    });
  }

  private describeDecision(decision: Awaited<ReturnType<WorkerModel["decide"]>>): string {
    if (decision.type === "invoke_tool") return `Invoke ${decision.invocation.tool}: ${decision.invocation.rationale}`;
    if (decision.type === "complete") return `Complete work: ${decision.summary}`;
    return `Block work: ${decision.reason}`;
  }

  private invalidOutputReason(
    assignment: WorkerAssignment,
    transcript: WorkerTranscriptEntry[],
    outputs: Array<{ id: string; refs: string[] }>,
  ): string | undefined {
    const known = new Set([
      assignment.runContext.scopeRef,
      ...assignment.work.evidenceRefs,
      ...assignment.work.hypothesisIds,
      ...transcript.flatMap((entry) => entry.refs),
    ]);
    for (const output of outputs) {
      if (output.refs.length === 0) return `Output ${output.id} has no traceable references; use only references present in the Work Package or tool results.`;
      const unknown = output.refs.filter((ref) => !known.has(ref));
      if (unknown.length) return `Output ${output.id} contains ungrounded references: ${unknown.join(", ")}.`;
    }
    return undefined;
  }
}
