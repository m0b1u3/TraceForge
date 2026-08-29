import type {
  CommandResult,
  OutputPredicate,
  ScenarioCommand,
  ScenarioDefinition,
  ScenarioEvent,
  ScenarioPhaseDefinition,
  ScenarioRunState,
  ScenarioTransition,
  ScenarioWorkItem,
  WorkKind,
} from "./model.js";

const terminalWork = new Set(["completed", "blocked", "failed", "cancelled"]);

function requireFuture(instant: string, after: string, label: string): void {
  const value = Date.parse(instant);
  const lowerBound = Date.parse(after);
  if (!Number.isFinite(value) || !Number.isFinite(lowerBound) || value <= lowerBound) {
    throw new Error(`${label} must be later than ${after}`);
  }
}

function requireInstant(instant: string, label: string): void {
  if (!Number.isFinite(Date.parse(instant))) throw new Error(`${label} must be a valid timestamp`);
}

function requirePhase(definition: ScenarioDefinition, phaseId: string): ScenarioPhaseDefinition {
  const phase = definition.phases.find((candidate) => candidate.id === phaseId);
  if (!phase) throw new Error(`Scenario definition ${definition.kind}@${definition.version} has no phase ${phaseId}`);
  return phase;
}

function requireWorkKind(definition: ScenarioDefinition, kind: WorkKind) {
  const workKind = definition.workKinds.find((candidate) => candidate.id === kind);
  if (!workKind) throw new Error(`Scenario definition ${definition.kind}@${definition.version} has no work kind ${kind}`);
  return workKind;
}

function missingCapabilities(required: string[], available: string[]): string[] {
  const inventory = new Set(available);
  return [...new Set(required)].filter((capability) => !inventory.has(capability));
}

function outputCount(state: ScenarioRunState, predicate: OutputPredicate): number {
  return state.outputs.filter((output) => output.phaseId === state.activePhaseId && output.kind === predicate.kind).length;
}

function satisfies(predicate: OutputPredicate, state: ScenarioRunState): boolean {
  return outputCount(state, predicate) >= (predicate.minimum ?? 1);
}

function outstanding(state: ScenarioRunState, kinds: WorkKind[]): ScenarioWorkItem[] {
  const selected = new Set(kinds);
  return state.workItems.filter((work) => selected.has(work.kind) && !terminalWork.has(work.status));
}

export function transitionAllowed(state: ScenarioRunState, transition: ScenarioTransition): { allowed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  for (const predicate of transition.allOf ?? []) {
    if (!satisfies(predicate, state)) reasons.push(`requires ${predicate.minimum ?? 1} ${predicate.kind} output(s)`);
  }
  if (transition.anyOf?.length && !transition.anyOf.some((predicate) => satisfies(predicate, state))) {
    reasons.push(`requires one of: ${transition.anyOf.map((predicate) => predicate.kind).join(", ")}`);
  }
  for (const predicate of transition.noneOf ?? []) {
    if (satisfies(predicate, state)) reasons.push(`requires no ${predicate.kind} outputs`);
  }
  const active = outstanding(state, transition.noOutstandingWorkKinds ?? []);
  if (active.length) reasons.push(`outstanding work: ${active.map((work) => work.id).join(", ")}`);
  return { allowed: reasons.length === 0, reasons };
}

export function evolve(state: ScenarioRunState | undefined, event: ScenarioEvent): ScenarioRunState {
  if (event.type === "run_started") return { ...event.state, scenarioPackage: event.state.scenarioPackage ?? null };
  if (!state) throw new Error(`Cannot apply ${event.type} before run_started`);
  const revision = state.revision + 1;
  switch (event.type) {
    case "work_proposed":
      return { ...state, workItems: [...state.workItems, event.work], revision, updatedAt: event.at };
    case "work_claimed":
      return updateWork(state, event.workId, (work) => ({
        ...work,
        status: "running",
        workerId: event.workerId,
        leaseId: event.leaseId,
        leaseExpiresAt: event.leaseExpiresAt,
        attempt: work.attempt + (event.resumedFromCheckpoint ? 0 : 1),
        resumeFromCheckpoint: false,
        startedAt: event.at,
      }), event.at);
    case "work_lease_renewed":
      return updateWork(state, event.workId, (work) => ({ ...work, leaseExpiresAt: event.leaseExpiresAt }), event.at);
    case "work_checkpointed":
      return updateWork(state, event.workId, (work) => ({ ...work, latestCheckpoint: event.checkpoint }), event.at);
    case "work_requeued":
      return updateWork(state, event.workId, (work) => ({
        ...work,
        status: "queued",
        workerId: null,
        leaseId: null,
        leaseExpiresAt: null,
        error: event.reason,
        startedAt: null,
        resumeFromCheckpoint: Boolean(work.latestCheckpoint),
      }), event.at);
    case "work_approval_requested":
      return updateWork(state, event.workId, (work) => ({
        ...work,
        status: "waiting_approval",
        workerId: null,
        leaseId: null,
        leaseExpiresAt: null,
        pendingApproval: event.approval,
        error: null,
      }), event.at);
    case "work_approval_resolved":
      return updateWork(state, event.workId, (work) => {
        const pending = work.pendingApproval;
        if (!pending || pending.id !== event.approvalId) throw new Error(`Cannot apply resolution for unknown approval ${event.approvalId}`);
        const resolved = {
          ...pending,
          status: event.approved ? "approved" as const : "rejected" as const,
          resolvedAt: event.at,
          resolutionReason: event.reason,
        };
        return {
          ...work,
          status: event.approved ? "queued" : "blocked",
          pendingApproval: null,
          resumeFromCheckpoint: event.approved,
          approvalHistory: [...work.approvalHistory, resolved],
          grantedActionKeys: event.approved ? [...new Set([...work.grantedActionKeys, pending.actionKey])] : work.grantedActionKeys,
          error: event.approved ? null : event.reason,
          finishedAt: event.approved ? null : event.at,
        };
      }, event.at);
    case "work_completed": {
      const next = updateWork(state, event.workId, (work) => ({
        ...work,
        status: "completed",
        resultSummary: event.summary,
        resumeFromCheckpoint: false,
        finishedAt: event.at,
      }), event.at);
      return { ...next, outputs: [...next.outputs, ...event.outputs] };
    }
    case "work_failed":
      return updateWork(state, event.workId, (work) => ({ ...work, status: "failed", error: event.error, resumeFromCheckpoint: false, finishedAt: event.at }), event.at);
    case "work_blocked":
      return updateWork(state, event.workId, (work) => ({ ...work, status: "blocked", error: event.reason, resumeFromCheckpoint: false, finishedAt: event.at }), event.at);
    case "work_cancelled":
      return updateWork(state, event.workId, (work) => {
        const cancelledApproval = work.pendingApproval ? {
          ...work.pendingApproval,
          status: "cancelled" as const,
          resolvedAt: event.at,
          resolutionReason: event.reason,
        } : null;
        return {
          ...work,
          status: "cancelled",
          resultSummary: event.reason,
          finishedAt: event.at,
          pendingApproval: null,
          resumeFromCheckpoint: false,
          approvalHistory: cancelledApproval ? [...work.approvalHistory, cancelledApproval] : work.approvalHistory,
        };
      }, event.at);
    case "work_reprioritized":
      return updateWork(state, event.workId, (work) => ({ ...work, priority: event.priority }), event.at);
    case "directive_issued":
      return { ...state, directives: [...state.directives, event.directive], revision, updatedAt: event.at };
    case "phase_advanced":
      return { ...state, activePhaseId: event.to, revision, updatedAt: event.at, blockedReason: null };
    case "run_paused":
      return {
        ...state,
        status: "paused",
        workItems: state.workItems.map((work) => work.status === "running" ? {
          ...work,
          status: "queued",
          workerId: null,
          leaseId: null,
          leaseExpiresAt: null,
          resumeFromCheckpoint: Boolean(work.latestCheckpoint),
          startedAt: null,
        } : work),
        suspension: { reason: event.reason, requestedBy: event.requestedBy, pausedAt: event.at },
        revision,
        updatedAt: event.at,
        blockedReason: event.reason,
      };
    case "run_resumed":
      return {
        ...state,
        status: "running",
        suspension: null,
        revision,
        updatedAt: event.at,
        blockedReason: null,
      };
    case "run_completed":
      return { ...state, status: "completed", suspension: null, revision, updatedAt: event.at, completedAt: event.at, blockedReason: null };
    case "run_cancelled":
      return {
        ...state,
        status: "cancelled",
        workItems: state.workItems.map((work) => {
          if (terminalWork.has(work.status)) return work;
          const cancelledApproval = work.pendingApproval ? {
            ...work.pendingApproval,
            status: "cancelled" as const,
            resolvedAt: event.at,
            resolutionReason: event.reason,
          } : null;
          return {
            ...work,
            status: "cancelled",
            workerId: null,
            leaseId: null,
            leaseExpiresAt: null,
            pendingApproval: null,
            resumeFromCheckpoint: false,
            approvalHistory: cancelledApproval ? [...work.approvalHistory, cancelledApproval] : work.approvalHistory,
            resultSummary: event.reason,
            finishedAt: event.at,
          };
        }),
        revision,
        updatedAt: event.at,
        completedAt: event.at,
        suspension: null,
        blockedReason: event.reason,
      };
  }
}

function updateWork(
  state: ScenarioRunState,
  workId: string,
  update: (work: ScenarioWorkItem) => ScenarioWorkItem,
  at: string,
): ScenarioRunState {
  return {
    ...state,
    workItems: state.workItems.map((work) => work.id === workId ? update(work) : work),
    revision: state.revision + 1,
    updatedAt: at,
  };
}

function applyEvents(state: ScenarioRunState | undefined, events: ScenarioEvent[]): ScenarioRunState {
  let next = state;
  for (const event of events) next = evolve(next, event);
  if (!next) throw new Error("Command emitted no state");
  return next;
}

function requireActive(state: ScenarioRunState | undefined): ScenarioRunState {
  if (!state) throw new Error("Scenario run has not started");
  if (state.status !== "running") throw new RunLifecycleConflictError(state.id, state.status, "execute active command");
  return state;
}

export class RunLifecycleConflictError extends Error {
  constructor(readonly runId: string, readonly status: ScenarioRunState["status"], readonly operation: string) {
    super(`Scenario run ${runId} is ${status}; cannot ${operation}`);
    this.name = "RunLifecycleConflictError";
  }
}

function requireWork(state: ScenarioRunState, workId: string): ScenarioWorkItem {
  const work = state.workItems.find((candidate) => candidate.id === workId);
  if (!work) throw new Error(`Unknown work item ${workId}`);
  return work;
}

function requireLease(work: ScenarioWorkItem, leaseId: string): void {
  if (work.status !== "running") throw new Error(`Work ${work.id} is ${work.status}, not running`);
  if (work.leaseId !== leaseId) throw new Error(`Lease ${leaseId} does not own work ${work.id}`);
}

function requireLiveLease(work: ScenarioWorkItem, leaseId: string, at: string): void {
  requireLease(work, leaseId);
  if (!work.leaseExpiresAt || Date.parse(at) >= Date.parse(work.leaseExpiresAt)) {
    throw new Error(`Lease ${leaseId} for work ${work.id} has expired`);
  }
}

export class ScenarioKernel {
  constructor(readonly definition: ScenarioDefinition) {
    if (!definition.kind.trim()) throw new Error("Scenario kind is required");
    if (!Number.isInteger(definition.version) || definition.version < 1) throw new Error("Scenario version must be a positive integer");
    requirePhase(definition, definition.initialPhaseId);
    const workKindIds = new Set<string>();
    for (const workKind of definition.workKinds) {
      if (!workKind.id.trim() || workKindIds.has(workKind.id)) throw new Error(`Duplicate or empty work kind ${workKind.id}`);
      workKindIds.add(workKind.id);
      if (workKind.defaultWorkerRoles.length === 0) throw new Error(`Work kind ${workKind.id} requires a default Worker role`);
      if (workKind.maximumActiveItems !== undefined && workKind.maximumActiveItems < 1) {
        throw new Error(`Work kind ${workKind.id} has an invalid active item limit`);
      }
      if (workKind.minimumHypothesisRefs !== undefined && workKind.minimumHypothesisRefs < 0) {
        throw new Error(`Work kind ${workKind.id} has an invalid Hypothesis reference minimum`);
      }
      if (workKind.completion && workKind.completion.anyOfOutputKinds.length === 0) {
        throw new Error(`Work kind ${workKind.id} has an empty completion output policy`);
      }
    }
    const ids = new Set<string>();
    for (const phase of definition.phases) {
      if (ids.has(phase.id)) throw new Error(`Duplicate phase ${phase.id}`);
      ids.add(phase.id);
      if (phase.maxParallelWork < 1) throw new Error(`Phase ${phase.id} must allow at least one work item`);
    }
    const poolIds = new Set<string>();
    for (const pool of definition.agentTopology.workerPools) {
      if (!pool.id.trim() || poolIds.has(pool.id)) throw new Error(`Duplicate or empty Worker pool id ${pool.id}`);
      poolIds.add(pool.id);
      if (pool.minimumInstances < 0 || pool.maximumInstances < 1 || pool.minimumInstances > pool.maximumInstances || pool.maxConcurrentWork < 1) {
        throw new Error(`Worker pool ${pool.id} has invalid capacity`);
      }
      if (pool.capabilities.length === 0) throw new Error(`Worker pool ${pool.id} requires capabilities`);
      if (pool.workKinds.length === 0 || pool.workKinds.some((kind) => !workKindIds.has(kind))) {
        throw new Error(`Worker pool ${pool.id} references no valid work kinds`);
      }
    }
    if (definition.agentTopology.observer.enabled && definition.agentTopology.observer.pollIntervalMs < 100) {
      throw new Error("Observer poll interval must be at least 100ms");
    }
    if (definition.agentTopology.observer.enabled && [
      definition.agentTopology.observer.maximumGraphNodes,
      definition.agentTopology.observer.maximumRecentEvents,
      definition.agentTopology.observer.maximumRunItems,
    ].some((limit) => limit < 1)) throw new Error("Observer context limits must be positive");
    if (definition.agentTopology.planner.enabled && definition.agentTopology.planner.pollIntervalMs < 100) {
      throw new Error("Planner poll interval must be at least 100ms");
    }
    if (definition.agentTopology.planner.enabled && [
      definition.agentTopology.planner.maximumGraphNodes,
      definition.agentTopology.planner.maximumRecentEvents,
      definition.agentTopology.planner.maximumRunItems,
      definition.agentTopology.planner.maximumProposalsPerEvaluation,
    ].some((limit) => limit < 1)) throw new Error("Planner context limits must be positive");
    for (const phase of definition.phases) {
      if (phase.allowedWorkKinds.some((kind) => !workKindIds.has(kind))) {
        throw new Error(`Phase ${phase.id} references an unknown work kind`);
      }
      for (const transition of phase.transitions) {
        if (transition.to !== "complete" && !ids.has(transition.to)) {
          throw new Error(`Phase ${phase.id} transitions to unknown phase ${transition.to}`);
        }
      }
    }
  }

  execute(state: ScenarioRunState | undefined, command: ScenarioCommand): CommandResult {
    const events = this.decide(state, command);
    return { state: applyEvents(state, events), events };
  }

  private decide(current: ScenarioRunState | undefined, command: ScenarioCommand): ScenarioEvent[] {
    requireInstant(command.at, "Command time");
    if (command.type === "start_run") {
      if (current) throw new Error(`Scenario run ${current.id} already started`);
      if (!command.goal.trim()) throw new Error("Scenario goal is required");
      if (!command.scopeRef.trim()) throw new Error("An authorized scope reference is required");
      if (!command.scenarioPackage.id.trim() || !command.scenarioPackage.version.trim() || command.scenarioPackage.schemaRevision < 1) {
        throw new Error("A valid Scenario Package binding is required");
      }
      const missing = missingCapabilities(this.definition.requiredCapabilities, command.availableCapabilities);
      if (missing.length) throw new Error(`Scenario cannot start; missing capabilities: ${missing.join(", ")}`);
      return [{
        type: "run_started",
        state: {
          id: command.runId,
          caseId: command.caseId,
          definitionKind: this.definition.kind,
          definitionVersion: this.definition.version,
          scenarioPackage: { ...command.scenarioPackage },
          goal: command.goal,
          scopeRef: command.scopeRef,
          status: "running",
          activePhaseId: this.definition.initialPhaseId,
          availableCapabilities: [...new Set(command.availableCapabilities)].sort(),
          workItems: [],
          outputs: [],
          directives: [],
          suspension: null,
          revision: 1,
          blockedReason: null,
          createdAt: command.at,
          updatedAt: command.at,
          completedAt: null,
        },
      }];
    }

    if (command.type === "pause_run") {
      const state = requireActive(current);
      if (!command.reason.trim()) throw new Error("Pausing a Run requires a reason");
      return [{ type: "run_paused", reason: command.reason, requestedBy: command.requestedBy, at: command.at }];
    }
    if (command.type === "resume_run") {
      if (!current) throw new Error("Scenario run has not started");
      if (current.status !== "paused") throw new RunLifecycleConflictError(current.id, current.status, "resume Run");
      if (!command.reason.trim()) throw new Error("Resuming a Run requires a reason");
      return [{ type: "run_resumed", reason: command.reason, requestedBy: command.requestedBy, at: command.at }];
    }
    if (command.type === "cancel_run") {
      if (!current) throw new Error("Scenario run has not started");
      if (current.status === "completed" || current.status === "cancelled") {
        throw new RunLifecycleConflictError(current.id, current.status, "cancel Run");
      }
      if (!command.reason.trim()) throw new Error("Cancelling a Run requires a reason");
      return [{ type: "run_cancelled", reason: command.reason, at: command.at }];
    }

    const state = requireActive(current);
    const phase = requirePhase(this.definition, state.activePhaseId);
    switch (command.type) {
      case "propose_work": {
        if (state.workItems.some((work) => work.id === command.proposal.id)) throw new Error(`Duplicate work item ${command.proposal.id}`);
        if (state.workItems.some((work) => work.idempotencyKey === command.proposal.idempotencyKey)) {
          throw new Error(`Duplicate work idempotency key ${command.proposal.idempotencyKey}`);
        }
        if (!phase.allowedWorkKinds.includes(command.proposal.kind)) {
          throw new Error(`Phase ${phase.id} does not allow ${command.proposal.kind} work`);
        }
        const workKind = requireWorkKind(this.definition, command.proposal.kind);
        if (!command.proposal.title.trim() || !command.proposal.objective.trim()) throw new Error("Work title and objective are required");
        const required = [...new Set([...phase.requiredCapabilities, ...(command.proposal.requiredCapabilities ?? [])])];
        const missing = missingCapabilities(required, state.availableCapabilities);
        if (missing.length) throw new Error(`Work ${command.proposal.id} requires unavailable capabilities: ${missing.join(", ")}`);
        const work: ScenarioWorkItem = {
          id: command.proposal.id,
          runId: state.id,
          phaseId: phase.id,
          kind: command.proposal.kind,
          title: command.proposal.title,
          objective: command.proposal.objective,
          priority: Math.max(0, Math.min(100, Math.round(command.proposal.priority ?? 50))),
          status: "queued",
          allowedWorkerRoles: [...new Set(command.proposal.allowedWorkerRoles ?? workKind.defaultWorkerRoles)],
          requiredCapabilities: required,
          hypothesisIds: [...new Set(command.proposal.hypothesisIds ?? [])],
          evidenceRefs: [...new Set(command.proposal.evidenceRefs ?? [])],
          workerId: null,
          leaseId: null,
          leaseExpiresAt: null,
          attempt: 0,
          maxAttempts: Math.max(1, Math.min(20, Math.round(command.proposal.maxAttempts ?? 3))),
          idempotencyKey: command.proposal.idempotencyKey,
          latestCheckpoint: null,
          resumeFromCheckpoint: false,
          pendingApproval: null,
          approvalHistory: [],
          grantedActionKeys: [],
          resultSummary: null,
          error: null,
          createdAt: command.at,
          startedAt: null,
          finishedAt: null,
        };
        if (!work.idempotencyKey.trim()) throw new Error("Work idempotency key is required");
        if (work.allowedWorkerRoles.length === 0) throw new Error("Work must allow at least one worker role");
        return [{ type: "work_proposed", work, at: command.at }];
      }
      case "claim_work": {
        const work = requireWork(state, command.workId);
        const workKind = requireWorkKind(this.definition, work.kind);
        if (work.status !== "queued") throw new Error(`Work ${work.id} is ${work.status}, not queued`);
        if (!work.resumeFromCheckpoint && work.attempt >= work.maxAttempts) throw new Error(`Work ${work.id} exhausted its attempt limit`);
        requireFuture(command.leaseExpiresAt, command.at, "Lease expiry");
        if (!work.allowedWorkerRoles.some((role) => command.workerRoles.includes(role))) {
          throw new Error(`Worker ${command.workerId} has no permitted role for work ${work.id}`);
        }
        const workerMissing = missingCapabilities(work.requiredCapabilities, command.workerCapabilities);
        if (workerMissing.length) throw new Error(`Worker ${command.workerId} lacks capabilities: ${workerMissing.join(", ")}`);
        if (command.workerMaxConcurrentWork < 1 || command.workerCurrentWork < 0 || command.workerCurrentWork >= command.workerMaxConcurrentWork) {
          throw new Error(`Worker ${command.workerId} has no execution capacity`);
        }
        const activeInPhase = state.workItems.filter((candidate) => candidate.phaseId === phase.id && candidate.status === "running");
        if (activeInPhase.length >= phase.maxParallelWork) throw new Error(`Phase ${phase.id} has reached its parallel work limit`);
        if (workKind.maximumActiveItems !== undefined) {
          const active = state.workItems.filter((candidate) => candidate.kind === work.kind && candidate.status === "running");
          if (active.length >= workKind.maximumActiveItems) throw new Error(`Work kind ${work.kind} has reached its active item limit`);
        }
        if (work.hypothesisIds.length < (workKind.minimumHypothesisRefs ?? 0)) {
          throw new Error(`Work ${work.id} requires at least ${workKind.minimumHypothesisRefs} Hypothesis reference(s)`);
        }
        return [{
          type: "work_claimed",
          workId: work.id,
          workerId: command.workerId,
          leaseId: command.leaseId,
          leaseExpiresAt: command.leaseExpiresAt,
          resumedFromCheckpoint: work.resumeFromCheckpoint,
          at: command.at,
        }];
      }
      case "renew_lease": {
        const work = requireWork(state, command.workId);
        requireLiveLease(work, command.leaseId, command.at);
        requireFuture(command.leaseExpiresAt, command.at, "Lease expiry");
        if (Date.parse(command.leaseExpiresAt) <= Date.parse(work.leaseExpiresAt!)) {
          throw new Error(`Lease renewal for work ${work.id} must extend the current expiry`);
        }
        return [{ type: "work_lease_renewed", workId: work.id, leaseId: command.leaseId, leaseExpiresAt: command.leaseExpiresAt, at: command.at }];
      }
      case "checkpoint_work": {
        const work = requireWork(state, command.workId);
        requireLiveLease(work, command.leaseId, command.at);
        if (!command.checkpointId.trim() || !command.progressSummary.trim() || !command.payloadRef.trim()) {
          throw new Error("Checkpoint id, summary, and payload reference are required");
        }
        if (work.latestCheckpoint?.id === command.checkpointId) throw new Error(`Duplicate checkpoint ${command.checkpointId}`);
        return [{
          type: "work_checkpointed",
          workId: work.id,
          checkpoint: {
            id: command.checkpointId,
            workId: work.id,
            leaseId: command.leaseId,
            progressSummary: command.progressSummary,
            payloadRef: command.payloadRef,
            createdAt: command.at,
          },
          at: command.at,
        }];
      }
      case "expire_lease": {
        const work = requireWork(state, command.workId);
        requireLease(work, command.leaseId);
        if (!work.leaseExpiresAt || Date.parse(command.at) < Date.parse(work.leaseExpiresAt)) {
          throw new Error(`Lease ${command.leaseId} for work ${work.id} has not expired`);
        }
        if (work.attempt >= work.maxAttempts && !work.latestCheckpoint) {
          return [{ type: "work_failed", workId: work.id, leaseId: command.leaseId, error: "Execution lease expired after the maximum number of attempts", at: command.at }];
        }
        return [{ type: "work_requeued", workId: work.id, leaseId: command.leaseId, reason: "Execution lease expired; work returned to the queue", at: command.at }];
      }
      case "interrupt_work": {
        const work = requireWork(state, command.workId);
        requireLease(work, command.leaseId);
        if (!command.reason.trim()) throw new Error("Interrupting Work requires a reason");
        if (work.attempt >= work.maxAttempts && !work.latestCheckpoint) {
          return [{
            type: "work_blocked",
            workId: work.id,
            leaseId: command.leaseId,
            reason: `${command.reason}; no recoverable checkpoint and the attempt limit is exhausted`,
            at: command.at,
          }];
        }
        return [{ type: "work_requeued", workId: work.id, leaseId: command.leaseId, reason: command.reason, at: command.at }];
      }
      case "request_work_approval": {
        const work = requireWork(state, command.workId);
        requireLiveLease(work, command.leaseId, command.at);
        if (!work.latestCheckpoint) throw new Error(`Work ${work.id} must persist a checkpoint before requesting approval`);
        if (![command.approvalId, command.actionKey, command.toolName, command.rationale, command.inputRef].every((value) => value.trim())) {
          throw new Error("Approval id, action key, tool name, rationale, and input reference are required");
        }
        if (command.inputRef !== work.latestCheckpoint.payloadRef) {
          throw new Error(`Approval input must reference the latest checkpoint for work ${work.id}`);
        }
        const duplicateApproval = state.workItems.some((candidate) =>
          candidate.pendingApproval?.id === command.approvalId || candidate.approvalHistory.some((approval) => approval.id === command.approvalId));
        if (duplicateApproval) throw new Error(`Duplicate approval ${command.approvalId}`);
        return [{
          type: "work_approval_requested",
          workId: work.id,
          leaseId: command.leaseId,
          approval: {
            id: command.approvalId,
            workId: work.id,
            actionKey: command.actionKey,
            toolName: command.toolName,
            risk: command.risk,
            rationale: command.rationale,
            inputRef: command.inputRef,
            status: "pending",
            requestedByWorkerId: work.workerId!,
            createdAt: command.at,
            resolvedAt: null,
            resolutionReason: null,
          },
          at: command.at,
        }];
      }
      case "resolve_work_approval": {
        const work = requireWork(state, command.workId);
        if (work.status !== "waiting_approval" || work.pendingApproval?.id !== command.approvalId) {
          throw new Error(`Work ${work.id} is not waiting for approval ${command.approvalId}`);
        }
        if (!command.reason.trim()) throw new Error("Approval resolution reason is required");
        return [{
          type: "work_approval_resolved",
          workId: work.id,
          approvalId: command.approvalId,
          approved: command.approved,
          reason: command.reason,
          at: command.at,
        }];
      }
      case "complete_work": {
        const work = requireWork(state, command.workId);
        const workKind = requireWorkKind(this.definition, work.kind);
        requireLiveLease(work, command.leaseId, command.at);
        const duplicate = command.outputs.find((output) => state.outputs.some((existing) => existing.id === output.id));
        if (duplicate) throw new Error(`Duplicate output ${duplicate.id}`);
        const outputs = command.outputs.map((output) => ({
          ...output,
          schemaVersion: output.schemaVersion ?? null,
          phaseId: work.phaseId,
          producedByWorkId: work.id,
        }));
        if (workKind.completion && !outputs.some((output) => workKind.completion!.anyOfOutputKinds.includes(output.kind))) {
          throw new Error(`Work ${work.id} must produce one of: ${workKind.completion.anyOfOutputKinds.join(", ")}`);
        }
        return [{ type: "work_completed", workId: work.id, leaseId: command.leaseId, summary: command.summary, outputs, at: command.at }];
      }
      case "fail_work": {
        const work = requireWork(state, command.workId);
        requireLiveLease(work, command.leaseId, command.at);
        return [{ type: "work_failed", workId: work.id, leaseId: command.leaseId, error: command.error, at: command.at }];
      }
      case "block_work": {
        const work = requireWork(state, command.workId);
        requireLiveLease(work, command.leaseId, command.at);
        return [{ type: "work_blocked", workId: work.id, leaseId: command.leaseId, reason: command.reason, at: command.at }];
      }
      case "cancel_work": {
        const work = requireWork(state, command.workId);
        if (terminalWork.has(work.status)) throw new Error(`Work ${work.id} is already ${work.status}`);
        if (work.status === "running") {
          if (!command.leaseId) throw new Error(`Cancelling running work ${work.id} requires its lease`);
          requireLease(work, command.leaseId);
        }
        return [{ type: "work_cancelled", workId: work.id, reason: command.reason, at: command.at }];
      }
      case "reprioritize_work": {
        const work = requireWork(state, command.workId);
        if (work.status !== "queued") throw new Error(`Only queued work can be reprioritized; ${work.id} is ${work.status}`);
        if (!command.reason.trim()) throw new Error("Work reprioritization requires a reason");
        const priority = Math.max(0, Math.min(100, Math.round(command.priority)));
        if (priority === work.priority) throw new Error(`Work ${work.id} already has priority ${priority}`);
        return [{ type: "work_reprioritized", workId: work.id, priority, reason: command.reason, at: command.at }];
      }
      case "issue_directive": {
        const work = requireWork(state, command.directive.targetWorkId);
        if (terminalWork.has(work.status)) throw new Error(`Cannot steer terminal work ${work.id}`);
        if (!command.directive.id.trim() || !command.directive.instruction.trim() || !command.directive.rationale.trim()) {
          throw new Error("Observer directive id, instruction and rationale are required");
        }
        if (state.directives.some((directive) => directive.id === command.directive.id)) {
          throw new Error(`Duplicate Observer directive ${command.directive.id}`);
        }
        return [{ type: "directive_issued", directive: { ...command.directive, createdAt: command.at }, at: command.at }];
      }
      case "advance_phase": {
        const unsettled = state.workItems.filter((work) => work.phaseId === phase.id && !terminalWork.has(work.status));
        if (unsettled.length) {
          throw new Error(`Phase ${phase.id} still has unsettled work: ${unsettled.map((work) => work.id).join(", ")}`);
        }
        const transition = phase.transitions.find((candidate) => candidate.to === command.to);
        if (!transition) throw new Error(`Phase ${phase.id} cannot transition to ${command.to}`);
        const decision = transitionAllowed(state, transition);
        if (!decision.allowed) throw new Error(`Phase ${phase.id} cannot advance: ${decision.reasons.join("; ")}`);
        return command.to === "complete"
          ? [{ type: "run_completed", at: command.at }]
          : [{ type: "phase_advanced", from: phase.id, to: command.to, at: command.at }];
      }
    }
  }
}
