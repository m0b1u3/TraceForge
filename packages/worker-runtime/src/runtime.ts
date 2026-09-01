import type { WorkerDescriptor, ScenarioRunState } from "@traceforge/orchestration-core";
import { AgentHarness } from "@traceforge/agent-runtime";
import { waitForCancellation } from "./cancellation.js";
import { ToolInvocationRecoveryRequiredError } from "./tool-gateway.js";
import { validateWorkerCheckpoint } from "./checkpoint-store.js";
import { executionToolContractFingerprint } from "./tool-provider-contract.js";
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

export interface WorkerHostOptions {
  maxTurns: number;
  maxDistilledCharacters: number;
  renewBeforeMs: number;
  repeatedFailureLimit: number;
  ownershipPollMs: number;
  onLifecycleEvent?: (event: WorkerLifecycleEvent) => void;
}

export type WorkerLifecycleEvent =
  | { type: "turn_progress"; assignment: WorkerAssignment; turnId: string; phase: WorkerTurnPhase; summary: string; refs: string[] }
  | { type: "turn_completed"; assignment: WorkerAssignment; turnId: string; status: "completed" | "failed" | "interrupted"; outcome: WorkerTurnOutcome | null; checkpointRef: string | null; error: string | null }
  | { type: "tool_started"; assignment: WorkerAssignment; turnId: string; invocationId: string; tool: string; risk: ExecutionRisk }
  | { type: "tool_completed"; assignment: WorkerAssignment; turnId: string; invocationId: string; tool: string; risk: ExecutionRisk; status: "completed" | "failed" | "waitingApproval"; summary: string; refs: string[] };

export type WorkerTurnPhase = "actionRequested" | "toolExecuted" | "observationApplied" | "checkpointed";
export type WorkerTurnOutcome = "continue" | "finish" | "waitingApproval" | "blocked";

export interface WorkerRunResult {
  runId: string;
  workId: string;
  outcome: "completed" | "waiting_approval" | "blocked" | "failed" | "lease_lost";
  turns: number;
  reason?: string;
}

export const defaultWorkerRuntimeOptions: Readonly<WorkerHostOptions> = {
  maxTurns: 24,
  maxDistilledCharacters: 8_000,
  renewBeforeMs: 20_000,
  repeatedFailureLimit: 3,
  ownershipPollMs: 1000,
};

export class LeaseLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeaseLostError";
  }
}

export class WorkerHost {
  private readonly options: WorkerHostOptions;
  private readonly active = new Map<string, { assignment: WorkerAssignment; controller: AbortController }>();

  cancelAll(reason = "Worker stopping"): void {
    for (const entry of this.active.values()) entry.controller.abort(new LeaseLostError(reason));
  }

  reconcileRun(run: ScenarioRunState): void {
    for (const entry of this.active.values()) {
      if (entry.assignment.runId !== run.id) continue;
      const work = run.workItems.find((w) => w.id === entry.assignment.work.id);
      if (run.status !== "running" || !work || work.status !== "running" || work.leaseId !== entry.assignment.leaseId || work.workerId !== this.worker.id) {
        entry.controller.abort(new LeaseLostError("Control plane revoked active execution ownership"));
      }
    }
  }

  constructor(
    private readonly worker: WorkerDescriptor,
    private readonly control: WorkerControlPlaneClient,
    private readonly model: WorkerModel,
    private readonly tools: ExecutionToolGateway,
    private readonly observer: WorkerObserver,
    private readonly checkpoints: WorkerCheckpointStore,
    private readonly distiller: OutputDistiller,
    options: Partial<WorkerHostOptions> = {},
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.options = { ...defaultWorkerRuntimeOptions, ...options };
    if (!Number.isSafeInteger(this.options.ownershipPollMs) || this.options.ownershipPollMs < 10 || this.options.ownershipPollMs > 30000) throw new Error("Invalid ownership polling interval");
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
    if (this.active.has(initialAssignment.leaseId)) throw new Error("Worker lease already executing");
    const entry = { assignment: initialAssignment, controller: new AbortController() };
    this.active.set(initialAssignment.leaseId, entry);
    let checking = false;
    const timer = setInterval(() => {
      if (checking || entry.controller.signal.aborted) return;
      checking = true;
      const guard = new AbortController();
      const deadline = setTimeout(() => guard.abort(new LeaseLostError("Execution ownership check timed out")), this.options.ownershipPollMs);
      void waitForCancellation(() => this.control.refresh(entry.assignment), guard.signal).then((current) => {
        if (current.leaseId !== initialAssignment.leaseId || current.work.status !== "running" || current.work.workerId !== this.worker.id
          || !Number.isFinite(Date.parse(current.leaseExpiresAt)) || Date.parse(current.leaseExpiresAt) <= Date.parse(this.now())) {
          throw new LeaseLostError("Execution ownership or lease expired");
        }
        entry.assignment = current;
      }).catch((error) => entry.controller.abort(new LeaseLostError(error instanceof Error ? error.message : "Cannot verify execution ownership")))
        .finally(() => { clearTimeout(deadline); checking = false; });
    }, this.options.ownershipPollMs);
    timer.unref();
    try { return await this.executeOwned(initialAssignment, entry.controller.signal); }
    finally { clearInterval(timer); this.active.delete(initialAssignment.leaseId); }
  }

  private async executeOwned(initialAssignment: WorkerAssignment, signal: AbortSignal): Promise<WorkerRunResult> {
    let assignment = initialAssignment;
    let checkpoint: WorkerCheckpointDocument;
    try {
      checkpoint = await waitForCancellation(() => this.restore(assignment), signal);
    } catch (error) {
      if (signal.aborted) return { runId: assignment.runId, workId: assignment.work.id, outcome: "lease_lost", turns: 0, reason: String(signal.reason) };
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
    let repeatedFailureCount = checkpoint.consecutiveFailures ?? 0;
    let activeTurnId: string | undefined;

    try {
      await this.tools.validateCheckpoint?.(assignment, checkpoint);
      if (repeatedFailureCount >= this.options.repeatedFailureLimit || checkpoint.turn >= this.options.maxTurns) {
        throw new ToolInvocationRecoveryRequiredError("Checkpoint execution budget exhausted; continuation cannot reset safety limits");
      }
      const sessionId = `worker:${encodeURIComponent(this.worker.id)}:run:${encodeURIComponent(assignment.runId)}:work:${encodeURIComponent(assignment.work.id)}:lease:${encodeURIComponent(assignment.leaseId)}`;
      const session = new AgentHarness().openSession<WorkerRunResult>(sessionId, { maxTurns: this.options.maxTurns });
      const sessionResult = await session.run(checkpoint.turn + 1, signal, async (turn) => {
        // Work names and attempt numbers are only local identities; a new lease is a distinct model evaluation.
        const turnId = `worker:${encodeURIComponent(this.worker.id)}:run:${encodeURIComponent(assignment.runId)}:work:${encodeURIComponent(assignment.work.id)}:lease:${encodeURIComponent(assignment.leaseId)}:attempt:${assignment.work.attempt}:turn:${turn}`;
        activeTurnId = undefined;
        assignment = await waitForCancellation(() => this.control.refresh(assignment), signal);
        this.applyRunDirectives(assignment, checkpoint);
        assignment = await this.renewIfNeeded(assignment, turn);
        signal.throwIfAborted();
        this.active.get(initialAssignment.leaseId)!.assignment = assignment;
        const pending = checkpoint.pendingInvocation;
        if (pending && !this.tools.recover) throw new ToolInvocationRecoveryRequiredError("Pending invocation requires durable recovery support");
        const recovery = pending ? await this.tools.recover!({ worker: this.worker, assignment, invocation: pending.invocation,
          idempotencyKey: `${assignment.work.idempotencyKey}:${pending.invocation.id}` }) : undefined;
        const recovered = recovery?.status === "recorded" || recovery?.status === "no_effect";
        const catalog = recovered ? { tools: [], requestedCapabilities: [], unresolvedCapabilities: [], registryRevision: 0 }
          : await waitForCancellation(() => this.tools.catalog(this.worker, assignment, signal), signal);
        if (pending && !recovered) {
          const spec = catalog.tools.find((tool) => tool.name === pending.invocation.tool);
          if (!spec || executionToolContractFingerprint(spec) !== pending.contractFingerprint) {
            throw new ToolInvocationRecoveryRequiredError("Pending invocation tool contract changed or is no longer authorized");
          }
        }
        const modelContext = {
          turnId,
          worker: this.worker,
          assignment,
          tools: catalog.tools,
          toolResolution: {
            requestedCapabilities: catalog.requestedCapabilities,
            unresolvedCapabilities: catalog.unresolvedCapabilities,
            registryRevision: catalog.registryRevision,
          },
          transcript: checkpoint.transcript,
          steering: checkpoint.steering,
        };
        activeTurnId = turnId;
        const evaluation = pending
          ? { intent: { type: "invoke_tool" as const, invocation: pending.invocation }, observation: { action: "continue" as const } }
          : await session.evaluate({ context: modelContext, signal,
            decide: (context, evaluationSignal) => waitForCancellation(() => this.model.decide(context, evaluationSignal), evaluationSignal),
            recordIntent: (intent) => checkpoint.transcript.push({ turn, kind: "model", summary: this.describeDecision(intent), refs: [] }),
            observe: (_context, intent, evaluationSignal) => waitForCancellation(() => this.observer.review({
              worker: this.worker, assignment, turn, decision: intent, transcript: checkpoint.transcript, repeatedFailureCount,
            }), evaluationSignal),
          });
        const decision = evaluation.intent;
        const observation = evaluation.observation;
        if (observation.action === "stop") {
          this.turnProgress(assignment, turnId, "observationApplied", observation.reason, []);
          assignment = await this.persistCheckpoint(assignment, checkpoint, turn, observation.reason, turnId);
          await this.control.block(assignment, `block:${assignment.leaseId}:observer:${turn}`, observation.reason);
          this.turnCompleted(assignment, turnId, "blocked", assignment.work.latestCheckpoint?.payloadRef ?? null);
          return { outcome: "finished", value: { runId: assignment.runId, workId: assignment.work.id, outcome: "blocked", turns: turn, reason: observation.reason } };
        }
        if (observation.action === "steer") {
          checkpoint.steering.push(observation.instruction);
          checkpoint.transcript.push({ turn, kind: "observer", summary: observation.instruction, refs: [] });
          this.turnProgress(assignment, turnId, "observationApplied", observation.instruction, []);
          assignment = await this.persistCheckpoint(assignment, checkpoint, turn, "Observer correction persisted", turnId);
          this.turnCompleted(assignment, turnId, "continue", assignment.work.latestCheckpoint?.payloadRef ?? null);
          return { outcome: "continue" };
        }

        if (decision.type === "complete") {
          const invalidOutput = this.invalidOutputReason(assignment, checkpoint.transcript, decision.outputs);
          if (invalidOutput) {
            checkpoint.steering.push(invalidOutput);
            checkpoint.transcript.push({ turn, kind: "observer", summary: invalidOutput, refs: [] });
            this.turnProgress(assignment, turnId, "observationApplied", invalidOutput, []);
            assignment = await this.persistCheckpoint(assignment, checkpoint, turn, "Ungrounded output rejected", turnId);
            this.turnCompleted(assignment, turnId, "continue", assignment.work.latestCheckpoint?.payloadRef ?? null);
            return { outcome: "continue" };
          }
          await this.control.complete(assignment, `complete:${assignment.leaseId}`, decision.summary, decision.outputs);
          this.turnCompleted(assignment, turnId, "finish", null);
          return { outcome: "finished", value: { runId: assignment.runId, workId: assignment.work.id, outcome: "completed", turns: turn } };
        }
        if (decision.type === "block") {
          assignment = await this.persistCheckpoint(assignment, checkpoint, turn, decision.reason, turnId);
          await this.control.block(assignment, `block:${assignment.leaseId}:model`, decision.reason);
          this.turnCompleted(assignment, turnId, "blocked", assignment.work.latestCheckpoint?.payloadRef ?? null);
          return { outcome: "finished", value: { runId: assignment.runId, workId: assignment.work.id, outcome: "blocked", turns: turn, reason: decision.reason } };
        }

        const knownTool = recovered || catalog.tools.some((tool) => tool.name === decision.invocation.tool);
        let failureLimitReached = false;
        const intentDisposition = session.classifyToolIntent(
          { id: decision.invocation.id, name: decision.invocation.tool }, checkpoint.completedInvocationIds, knownTool,
        );
        if (intentDisposition === "duplicate") {
          checkpoint.steering.push(`Invocation ${decision.invocation.id} was already committed; choose a new action or complete the work.`);
          this.turnProgress(assignment, turnId, "observationApplied", "Duplicate invocation suppressed", []);
          assignment = await this.persistCheckpoint(assignment, checkpoint, turn, "Duplicate invocation suppressed", turnId);
          this.turnCompleted(assignment, turnId, "continue", assignment.work.latestCheckpoint?.payloadRef ?? null);
          return { outcome: "continue" };
        }
        this.turnProgress(assignment, turnId, "actionRequested", `Action requested: ${decision.invocation.tool}`, []);
        if (intentDisposition === "unavailable") {
          const observationPolicy = session.applyToolObservation(
            "failed", repeatedFailureCount, this.options.repeatedFailureLimit,
          );
          repeatedFailureCount = observationPolicy.consecutiveFailures;
          failureLimitReached = observationPolicy.failureLimitReached;
          checkpoint.transcript.push({ turn, kind: "tool", summary: `Rejected unknown or unauthorized tool ${decision.invocation.tool}`, refs: [] });
          this.turnProgress(assignment, turnId, "toolExecuted", `Rejected unknown or unauthorized tool ${decision.invocation.tool}`, []);
          this.turnProgress(assignment, turnId, "observationApplied", "Unauthorized action rejection applied", []);
        } else {
          const toolSpec = catalog.tools.find((tool) => tool.name === decision.invocation.tool);
          const risk = pending?.risk ?? toolSpec!.risk;
          if (!pending) {
            checkpoint.pendingInvocation = { turn, invocation: structuredClone(decision.invocation), risk,
              contractFingerprint: executionToolContractFingerprint(toolSpec!) };
            checkpoint.consecutiveFailures = repeatedFailureCount;
            assignment = await this.persistCheckpoint(assignment, checkpoint, turn, "Exact invocation persisted before dispatch", turnId, "pending");
          }
          this.options.onLifecycleEvent?.({
            type: "tool_started", assignment, turnId, invocationId: decision.invocation.id,
            tool: decision.invocation.tool, risk,
          });
          let result;
          try {
            result = recovery?.status === "recorded" ? recovery.result : recovery?.status === "no_effect" ? {
              status: "failed" as const, summary: "Invocation independently confirmed to have no effect; its old key remains fenced",
              raw: "", refs: [recovery.auditRef], retryable: false,
            } : await this.tools.execute({
              worker: this.worker,
              assignment,
              invocation: checkpoint.pendingInvocation!.invocation,
              idempotencyKey: `${assignment.work.idempotencyKey}:${decision.invocation.id}`,
              expectedContractFingerprint: checkpoint.pendingInvocation!.contractFingerprint,
              signal,
            });
          } catch (error) {
            this.options.onLifecycleEvent?.({
              type: "tool_completed", assignment, turnId, invocationId: decision.invocation.id,
              tool: decision.invocation.tool, risk, status: "failed",
              summary: error instanceof Error ? error.message : String(error), refs: [],
            });
            throw error;
          }
          signal.throwIfAborted();
          const distilled = await waitForCancellation(() => this.distiller.distill(result, this.options.maxDistilledCharacters), signal);
          this.turnProgress(assignment, turnId, "toolExecuted", `Tool ${decision.invocation.tool} returned ${result.status}`, result.refs);
          this.options.onLifecycleEvent?.({
            type: "tool_completed", assignment, turnId, invocationId: decision.invocation.id,
            tool: decision.invocation.tool, risk,
            status: result.status === "succeeded" ? "completed" : result.status === "approval_required" ? "waitingApproval" : "failed",
            summary: distilled.summary, refs: distilled.refs,
          });
          checkpoint.transcript.push({ turn, kind: "tool", summary: distilled.summary, refs: distilled.refs,
            ...(result.status === "approval_required" || recovery?.status === "no_effect" ? {} : {
              receiptKey: `${assignment.work.idempotencyKey}:${decision.invocation.id}`,
            }) });
          this.turnProgress(assignment, turnId, "observationApplied", distilled.summary, distilled.refs);
          const observationPolicy = session.applyToolObservation(
            result.status, repeatedFailureCount, this.options.repeatedFailureLimit,
          );
          repeatedFailureCount = observationPolicy.consecutiveFailures;
          failureLimitReached = observationPolicy.failureLimitReached;
          if (observationPolicy.requiresApproval) {
            const approvalId = result.approvalRef ?? `approval:${assignment.work.id}:${decision.invocation.id}`;
            const actionKey = `${assignment.work.idempotencyKey}:${decision.invocation.id}`;
            const reason = `Tool ${decision.invocation.tool} requires approval (${approvalId}); retry this exact invocation after approval.`;
            checkpoint.steering.push(reason);
            checkpoint.consecutiveFailures = repeatedFailureCount;
            assignment = await this.persistCheckpoint(assignment, checkpoint, turn, reason, turnId, "approval");
            const inputRef = assignment.work.latestCheckpoint?.payloadRef;
            if (!inputRef) throw new Error("Approval checkpoint was not reflected in the assignment");
            await this.control.requestApproval(assignment, {
              commandId: `request-approval:${approvalId}`,
              approvalId,
              actionKey,
              toolName: decision.invocation.tool,
              risk,
              rationale: decision.invocation.rationale,
              inputRef,
            });
            this.turnCompleted(assignment, turnId, "waitingApproval", assignment.work.latestCheckpoint?.payloadRef ?? null);
            return { outcome: "finished", value: { runId: assignment.runId, workId: assignment.work.id, outcome: "waiting_approval", turns: turn, reason } };
          }
          if (observationPolicy.commitInvocation) checkpoint.completedInvocationIds.push(decision.invocation.id);
          checkpoint.pendingInvocation = null;
        }

        checkpoint.consecutiveFailures = repeatedFailureCount;
        assignment = await this.persistCheckpoint(assignment, checkpoint, turn, `Turn ${turn} committed`, turnId);
        if (failureLimitReached) {
          const reason = `Execution stopped after ${repeatedFailureCount} consecutive failed or unauthorized actions`;
          await this.control.block(assignment, `block:${assignment.leaseId}:failures`, reason);
          this.turnCompleted(assignment, turnId, "blocked", assignment.work.latestCheckpoint?.payloadRef ?? null);
          return { outcome: "finished", value: { runId: assignment.runId, workId: assignment.work.id, outcome: "blocked", turns: turn, reason } };
        }
        if (turn < this.options.maxTurns) {
          this.turnCompleted(assignment, turnId, "continue", assignment.work.latestCheckpoint?.payloadRef ?? null);
        }
        return { outcome: "continue" };
      });
      if (sessionResult.outcome === "finished") return sessionResult.value;
      const reason = `Agent Session turn budget exhausted after ${sessionResult.turns} turns`;
      await this.control.block(assignment, `block:${assignment.leaseId}:budget`, reason);
      if (activeTurnId) this.turnCompleted(assignment, activeTurnId, "blocked", assignment.work.latestCheckpoint?.payloadRef ?? null);
      return { runId: assignment.runId, workId: assignment.work.id, outcome: "blocked", turns: sessionResult.turns, reason };
    } catch (error) {
      if (signal.aborted) {
        const reason = signal.reason instanceof Error ? signal.reason.message : "Execution cancelled";
        if (activeTurnId) this.turnFailed(assignment, activeTurnId, "interrupted", reason);
        return { runId: assignment.runId, workId: assignment.work.id, outcome: "lease_lost", turns: checkpoint.turn, reason };
      }
      if (error instanceof LeaseLostError) {
        if (activeTurnId) this.turnFailed(assignment, activeTurnId, "interrupted", error.message);
        return { runId: assignment.runId, workId: assignment.work.id, outcome: "lease_lost", turns: checkpoint.turn, reason: error.message };
      }
      const reason = error instanceof Error ? error.message : "Unknown worker runtime failure";
      try {
        if (error instanceof ToolInvocationRecoveryRequiredError) {
          await this.control.block(assignment, `block:${assignment.leaseId}:invocation-recovery`, reason);
        } else await this.control.fail(assignment, `fail:${assignment.leaseId}`, reason);
      } catch (failure) {
        if (failure instanceof LeaseLostError) {
          if (activeTurnId) this.turnFailed(assignment, activeTurnId, "interrupted", failure.message);
          return { runId: assignment.runId, workId: assignment.work.id, outcome: "lease_lost", turns: checkpoint.turn, reason };
        }
        throw failure;
      }
      if (activeTurnId) this.turnFailed(assignment, activeTurnId, "failed", reason);
      return { runId: assignment.runId, workId: assignment.work.id,
        outcome: error instanceof ToolInvocationRecoveryRequiredError ? "blocked" : "failed", turns: checkpoint.turn, reason };
    }
  }

  private async restore(assignment: WorkerAssignment): Promise<WorkerCheckpointDocument> {
    const existing = assignment.work.latestCheckpoint;
    if (existing) {
      const document = validateWorkerCheckpoint(await this.checkpoints.load(existing.payloadRef));
      if (document.runId !== assignment.runId || document.workId !== assignment.work.id) throw new Error("Checkpoint does not belong to this assignment");
      if (document.version === 2 && (document.caseId !== assignment.runContext.caseId || document.workKey !== assignment.work.idempotencyKey)) {
        throw new Error("Checkpoint execution identity mismatch");
      }
      return { ...document, version: 2, caseId: assignment.runContext.caseId, workKey: assignment.work.idempotencyKey,
        consecutiveFailures: document.consecutiveFailures ?? 0, pendingInvocation: document.pendingInvocation ?? null, leaseId: assignment.leaseId };
    }
    return {
      version: 2,
      caseId: assignment.runContext.caseId,
      workKey: assignment.work.idempotencyKey,
      consecutiveFailures: 0,
      pendingInvocation: null,
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
    turnId: string,
    phase: "committed" | "pending" | "approval" = "committed",
  ): Promise<WorkerAssignment> {
    const signal = this.active.get(assignment.leaseId)?.controller.signal;
    signal?.throwIfAborted();
    checkpoint.turn = phase === "committed" ? turn : turn - 1;
    checkpoint.leaseId = assignment.leaseId;
    checkpoint.savedAt = this.now();
    validateWorkerCheckpoint(checkpoint);
    const payloadRef = await this.checkpoints.save(checkpoint);
    signal?.throwIfAborted();
    const updated = await this.control.checkpoint(assignment, {
      commandId: `checkpoint:${assignment.leaseId}:${turn}:${phase}`,
      checkpointId: `${assignment.work.id}:${assignment.leaseId}:${turn}:${phase}`,
      progressSummary,
      payloadRef,
    });
    signal?.throwIfAborted();
    this.turnProgress(updated, turnId, "checkpointed", progressSummary, [payloadRef]);
    return updated;
  }

  private turnProgress(assignment: WorkerAssignment, turnId: string, phase: WorkerTurnPhase, summary: string, refs: string[]): void {
    this.options.onLifecycleEvent?.({ type: "turn_progress", assignment, turnId, phase, summary, refs });
  }

  private turnCompleted(assignment: WorkerAssignment, turnId: string, outcome: WorkerTurnOutcome, checkpointRef: string | null): void {
    this.options.onLifecycleEvent?.({ type: "turn_completed", assignment, turnId, status: "completed", outcome, checkpointRef, error: null });
  }

  private turnFailed(assignment: WorkerAssignment, turnId: string, status: "failed" | "interrupted", error: string): void {
    this.options.onLifecycleEvent?.({ type: "turn_completed", assignment, turnId, status, outcome: null, checkpointRef: null, error });
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
