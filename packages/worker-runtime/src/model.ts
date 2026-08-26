import type {
  EffectivePermissionProfile,
  PermissionRequirements,
  RunDirective,
  ScenarioOutputKind,
  ScenarioWorkItem,
  WorkerDescriptor,
} from "@traceforge/orchestration-core";

export interface WorkerRunContext {
  caseId: string;
  goal: string;
  scopeRef: string;
  activePhaseId: string;
  directives: RunDirective[];
}

export interface WorkerAssignment {
  runId: string;
  leaseId: string;
  leaseExpiresAt: string;
  runRevision: number;
  runContext: WorkerRunContext;
  work: ScenarioWorkItem;
}

export type ExecutionRisk = "read_only" | "bounded_write" | "privileged" | "destructive";

export interface ExecutionToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  requiredCapabilities: string[];
  permissionRequirements: PermissionRequirements;
  risk: ExecutionRisk;
  timeoutMs: number;
}

export interface ToolInvocation {
  id: string;
  tool: string;
  input: unknown;
  rationale: string;
}

export interface ToolExecutionResult {
  status: "succeeded" | "failed" | "approval_required";
  summary: string;
  raw: string;
  refs: string[];
  retryable: boolean;
  approvalRef?: string;
  metadata?: Record<string, unknown>;
}

export interface ToolExecutionContext {
  workerId: string;
  runId: string;
  workId: string;
  caseId: string;
  scopeRef: string;
  leaseId: string;
  leaseExpiresAt: string;
  idempotencyKey: string;
  effectivePermissions: EffectivePermissionProfile;
}

export interface WorkerOutputDraft {
  id: string;
  kind: ScenarioOutputKind;
  summary: string;
  refs: string[];
}

export type WorkerDecision =
  | { type: "invoke_tool"; invocation: ToolInvocation; protocolTurnId?: string }
  | { type: "complete"; summary: string; outputs: WorkerOutputDraft[]; protocolTurnId?: string }
  | { type: "block"; reason: string; protocolTurnId?: string };

export interface WorkerTranscriptEntry {
  turn: number;
  kind: "model" | "tool" | "observer" | "system";
  summary: string;
  refs: string[];
}

export interface WorkerModelRequest {
  worker: WorkerDescriptor;
  assignment: WorkerAssignment;
  tools: ExecutionToolSpec[];
  transcript: WorkerTranscriptEntry[];
  steering: string[];
}

export interface WorkerModel {
  decide(request: WorkerModelRequest): Promise<WorkerDecision>;
}

export interface ExecutionToolGateway {
  catalog(worker: WorkerDescriptor, assignment: WorkerAssignment): Promise<ExecutionToolSpec[]>;
  execute(request: {
    worker: WorkerDescriptor;
    assignment: WorkerAssignment;
    invocation: ToolInvocation;
    idempotencyKey: string;
  }): Promise<ToolExecutionResult>;
}

export interface WorkerObserverSnapshot {
  worker: WorkerDescriptor;
  assignment: WorkerAssignment;
  turn: number;
  decision: WorkerDecision;
  transcript: WorkerTranscriptEntry[];
  repeatedFailureCount: number;
}

export type WorkerObserverDecision =
  | { action: "continue" }
  | { action: "steer"; instruction: string }
  | { action: "stop"; reason: string };

export interface WorkerObserver {
  review(snapshot: WorkerObserverSnapshot): Promise<WorkerObserverDecision>;
}

export interface WorkerCheckpointDocument {
  version: 1;
  workerId: string;
  runId: string;
  workId: string;
  leaseId: string;
  turn: number;
  transcript: WorkerTranscriptEntry[];
  steering: string[];
  completedInvocationIds: string[];
  savedAt: string;
}

export interface WorkerCheckpointStore {
  save(document: WorkerCheckpointDocument): Promise<string>;
  load(ref: string): Promise<WorkerCheckpointDocument>;
}

export interface WorkerControlPlaneClient {
  register(worker: WorkerDescriptor): Promise<void>;
  heartbeat(workerId: string): Promise<void>;
  assignments(workerId: string): Promise<WorkerAssignment[]>;
  refresh(assignment: WorkerAssignment): Promise<WorkerAssignment>;
  renew(assignment: WorkerAssignment, commandId: string): Promise<WorkerAssignment>;
  checkpoint(assignment: WorkerAssignment, input: {
    commandId: string;
    checkpointId: string;
    progressSummary: string;
    payloadRef: string;
  }): Promise<WorkerAssignment>;
  requestApproval(assignment: WorkerAssignment, input: {
    commandId: string;
    approvalId: string;
    actionKey: string;
    toolName: string;
    risk: ExecutionRisk;
    rationale: string;
    inputRef: string;
  }): Promise<void>;
  complete(assignment: WorkerAssignment, commandId: string, summary: string, outputs: WorkerOutputDraft[]): Promise<void>;
  fail(assignment: WorkerAssignment, commandId: string, reason: string): Promise<void>;
  block(assignment: WorkerAssignment, commandId: string, reason: string): Promise<void>;
}

export interface OutputDistiller {
  distill(result: ToolExecutionResult, maximumCharacters: number): Promise<{ summary: string; refs: string[] }>;
}
