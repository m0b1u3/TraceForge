export type ScenarioKind = "web_blackbox" | "code_audit" | "red_team_lateral";

export type WorkKind = "research" | "validation" | "review" | "report";
export type WorkStatus = "queued" | "running" | "waiting_approval" | "completed" | "blocked" | "failed" | "cancelled";
export type RunStatus = "running" | "paused" | "blocked" | "completed" | "cancelled";
export type WorkerRole = "coordinator" | "observer" | "researcher" | "validator" | "reviewer" | "reporter";
export type WorkerStatus = "online" | "draining" | "offline";

export type ExecutionWorkerRole = "researcher" | "validator" | "reviewer" | "reporter";
export type WorkerPoolActivation = "resident" | "on_demand";

export interface ScenarioWorkerPoolDefinition {
  id: string;
  role: ExecutionWorkerRole;
  activation: WorkerPoolActivation;
  minimumInstances: number;
  maximumInstances: number;
  maxConcurrentWork: number;
  capabilities: string[];
}

export interface ScenarioAgentTopology {
  planner: {
    enabled: boolean;
    pollIntervalMs: number;
    maximumGraphNodes: number;
    maximumRecentEvents: number;
    maximumRunItems: number;
    maximumProposalsPerEvaluation: number;
  };
  observer: { enabled: boolean; pollIntervalMs: number; maximumGraphNodes: number; maximumRecentEvents: number; maximumRunItems: number };
  workerPools: ScenarioWorkerPoolDefinition[];
}

export interface WorkerDescriptor {
  id: string;
  roles: WorkerRole[];
  capabilities: string[];
  maxConcurrentWork: number;
  status: WorkerStatus;
  heartbeatAt: string;
}

export interface ExecutionCheckpoint {
  id: string;
  workId: string;
  leaseId: string;
  progressSummary: string;
  payloadRef: string;
  createdAt: string;
}

export type WorkActionRisk = "read_only" | "bounded_write" | "privileged" | "destructive";
export type WorkApprovalStatus = "pending" | "approved" | "rejected" | "cancelled";

export interface WorkApprovalRecord {
  id: string;
  workId: string;
  actionKey: string;
  toolName: string;
  risk: WorkActionRisk;
  rationale: string;
  inputRef: string;
  status: WorkApprovalStatus;
  requestedByWorkerId: string;
  createdAt: string;
  resolvedAt: string | null;
  resolutionReason: string | null;
}

export type ScenarioOutputKind =
  | "scope_snapshot"
  | "capability_inventory"
  | "surface_observation"
  | "coverage_assessment"
  | "hypothesis"
  | "evidence"
  | "validation_conclusion"
  | "limitation"
  | "evidence_review"
  | "report";

export interface ScenarioOutput {
  id: string;
  kind: ScenarioOutputKind;
  summary: string;
  refs: string[];
  phaseId: string;
  producedByWorkId: string;
  createdAt: string;
}

export interface ScenarioWorkItem {
  id: string;
  runId: string;
  phaseId: string;
  kind: WorkKind;
  title: string;
  objective: string;
  priority: number;
  status: WorkStatus;
  allowedWorkerRoles: WorkerRole[];
  requiredCapabilities: string[];
  hypothesisIds: string[];
  evidenceRefs: string[];
  workerId: string | null;
  leaseId: string | null;
  leaseExpiresAt: string | null;
  attempt: number;
  maxAttempts: number;
  idempotencyKey: string;
  latestCheckpoint: ExecutionCheckpoint | null;
  resumeFromCheckpoint: boolean;
  pendingApproval: WorkApprovalRecord | null;
  approvalHistory: WorkApprovalRecord[];
  grantedActionKeys: string[];
  resultSummary: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface RunSuspension {
  reason: string;
  requestedBy: "operator" | "system";
  pausedAt: string;
}

export interface OutputPredicate {
  kind: ScenarioOutputKind;
  minimum?: number;
}

export interface ScenarioTransition {
  to: string | "complete";
  allOf?: OutputPredicate[];
  anyOf?: OutputPredicate[];
  noneOf?: OutputPredicate[];
  noOutstandingWorkKinds?: WorkKind[];
}

export interface ScenarioPhaseDefinition {
  id: string;
  title: string;
  objective: string;
  allowedWorkKinds: WorkKind[];
  maxParallelWork: number;
  requiredCapabilities: string[];
  transitions: ScenarioTransition[];
}

export interface ScenarioDefinition {
  kind: ScenarioKind;
  version: number;
  title: string;
  authorizationActions: string[];
  requiredCapabilities: string[];
  initialPhaseId: string;
  agentTopology: ScenarioAgentTopology;
  phases: ScenarioPhaseDefinition[];
}

export interface RunDirective {
  id: string;
  kind: "steer";
  targetWorkId: string;
  instruction: string;
  rationale: string;
  issuedBy: "observer";
  createdAt: string;
}

export interface ScenarioRunState {
  id: string;
  caseId: string;
  definitionKind: ScenarioKind;
  definitionVersion: number;
  goal: string;
  scopeRef: string;
  status: RunStatus;
  activePhaseId: string;
  availableCapabilities: string[];
  workItems: ScenarioWorkItem[];
  outputs: ScenarioOutput[];
  directives: RunDirective[];
  suspension: RunSuspension | null;
  revision: number;
  blockedReason: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface WorkProposal {
  id: string;
  kind: WorkKind;
  title: string;
  objective: string;
  priority?: number;
  allowedWorkerRoles?: WorkerRole[];
  requiredCapabilities?: string[];
  hypothesisIds?: string[];
  evidenceRefs?: string[];
  maxAttempts?: number;
  idempotencyKey: string;
}

export type ScenarioCommand =
  | {
      type: "start_run";
      runId: string;
      caseId: string;
      goal: string;
      scopeRef: string;
      availableCapabilities: string[];
      at: string;
    }
  | { type: "propose_work"; proposal: WorkProposal; at: string }
  | {
      type: "claim_work";
      workId: string;
      workerId: string;
      workerRoles: WorkerRole[];
      workerCapabilities: string[];
      workerCurrentWork: number;
      workerMaxConcurrentWork: number;
      leaseId: string;
      leaseExpiresAt: string;
      at: string;
    }
  | { type: "renew_lease"; workId: string; leaseId: string; leaseExpiresAt: string; at: string }
  | { type: "checkpoint_work"; workId: string; leaseId: string; checkpointId: string; progressSummary: string; payloadRef: string; at: string }
  | { type: "expire_lease"; workId: string; leaseId: string; at: string }
  | { type: "interrupt_work"; workId: string; leaseId: string; reason: string; at: string }
  | {
      type: "request_work_approval";
      workId: string;
      leaseId: string;
      approvalId: string;
      actionKey: string;
      toolName: string;
      risk: WorkActionRisk;
      rationale: string;
      inputRef: string;
      at: string;
    }
  | { type: "resolve_work_approval"; workId: string; approvalId: string; approved: boolean; reason: string; at: string }
  | { type: "complete_work"; workId: string; leaseId: string; summary: string; outputs: Omit<ScenarioOutput, "phaseId" | "producedByWorkId">[]; at: string }
  | { type: "fail_work"; workId: string; leaseId: string; error: string; at: string }
  | { type: "block_work"; workId: string; leaseId: string; reason: string; at: string }
  | { type: "cancel_work"; workId: string; leaseId?: string; reason: string; at: string }
  | { type: "reprioritize_work"; workId: string; priority: number; reason: string; at: string }
  | { type: "issue_directive"; directive: Omit<RunDirective, "createdAt">; at: string }
  | { type: "advance_phase"; to: string | "complete"; at: string }
  | { type: "pause_run"; reason: string; requestedBy: "operator" | "system"; at: string }
  | { type: "resume_run"; reason: string; requestedBy: "operator" | "system"; at: string }
  | { type: "cancel_run"; reason: string; at: string };

export type ScenarioEvent =
  | { type: "run_started"; state: ScenarioRunState }
  | { type: "work_proposed"; work: ScenarioWorkItem; at: string }
  | { type: "work_claimed"; workId: string; workerId: string; leaseId: string; leaseExpiresAt: string; resumedFromCheckpoint: boolean; at: string }
  | { type: "work_lease_renewed"; workId: string; leaseId: string; leaseExpiresAt: string; at: string }
  | { type: "work_checkpointed"; workId: string; checkpoint: ExecutionCheckpoint; at: string }
  | { type: "work_requeued"; workId: string; leaseId: string; reason: string; at: string }
  | { type: "work_approval_requested"; workId: string; leaseId: string; approval: WorkApprovalRecord; at: string }
  | { type: "work_approval_resolved"; workId: string; approvalId: string; approved: boolean; reason: string; at: string }
  | { type: "work_completed"; workId: string; leaseId: string; summary: string; outputs: ScenarioOutput[]; at: string }
  | { type: "work_failed"; workId: string; leaseId: string; error: string; at: string }
  | { type: "work_blocked"; workId: string; leaseId: string; reason: string; at: string }
  | { type: "work_cancelled"; workId: string; reason: string; at: string }
  | { type: "work_reprioritized"; workId: string; priority: number; reason: string; at: string }
  | { type: "directive_issued"; directive: RunDirective; at: string }
  | { type: "phase_advanced"; from: string; to: string; at: string }
  | { type: "run_paused"; reason: string; requestedBy: "operator" | "system"; at: string }
  | { type: "run_resumed"; reason: string; requestedBy: "operator" | "system"; at: string }
  | { type: "run_completed"; at: string }
  | { type: "run_cancelled"; reason: string; at: string };

export interface CommandResult {
  state: ScenarioRunState;
  events: ScenarioEvent[];
}

export interface CommandEnvelope {
  commandId: string;
  runId: string;
  expectedRevision: number;
  definitionKind?: ScenarioKind;
  definitionVersion?: number;
  command: ScenarioCommand;
}

export interface DurableCommandResult extends CommandResult {
  idempotentReplay: boolean;
}
