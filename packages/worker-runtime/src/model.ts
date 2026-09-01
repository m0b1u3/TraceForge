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
  source: string;
  version: string;
  priority: number;
  description: string;
  inputSchema: Record<string, unknown>;
  providedCapabilities: string[];
  dependencyCapabilities: string[];
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
  /** Host-local cancellation only; it is intentionally non-enumerable on RPC-bound contexts. */
  signal?: AbortSignal;
}

export interface WorkerOutputDraft {
  id: string;
  kind: ScenarioOutputKind;
  summary: string;
  refs: string[];
}

export type WorkerDecision =
  | { type: "invoke_tool"; invocation: ToolInvocation }
  | { type: "complete"; summary: string; outputs: WorkerOutputDraft[] }
  | { type: "block"; reason: string };

export interface WorkerTranscriptEntry {
  turn: number;
  kind: "model" | "tool" | "observer" | "system";
  summary: string;
  refs: string[];
  /** Host-created durable receipt identity, never copied from a tool's payload. */
  receiptKey?: string;
}

export interface WorkerModelContextPolicy {
  recordDecision?(request: WorkerModelRequest, snapshotId: string): Promise<void>;
  prepare(request: WorkerModelRequest): Promise<{ request: WorkerModelRequest; manifest: Record<string, unknown> }>;
}

export interface WorkerModelRequest {
  turnId: string;
  worker: WorkerDescriptor;
  assignment: WorkerAssignment;
  tools: ExecutionToolSpec[];
  toolResolution: {
    requestedCapabilities: string[];
    unresolvedCapabilities: string[];
    registryRevision: number;
  };
  transcript: WorkerTranscriptEntry[];
  steering: string[];
}

export interface ExecutionToolCatalog {
  tools: ExecutionToolSpec[];
  requestedCapabilities: string[];
  unresolvedCapabilities: string[];
  registryRevision: number;
}

export interface WorkerModel {
  decide(request: WorkerModelRequest, signal?: AbortSignal): Promise<WorkerDecision>;
}

export interface ExecutionToolGateway {
  /** Recovery must not dispatch an external action. */
  recover?(request: Parameters<ExecutionToolGateway["execute"]>[0]): Promise<ToolInvocationRecovery>;
  validateCheckpoint?(assignment: WorkerAssignment, checkpoint: WorkerCheckpointDocument): Promise<void>;
  catalog(worker: WorkerDescriptor, assignment: WorkerAssignment, signal?: AbortSignal): Promise<ExecutionToolCatalog>;
  execute(request: {
    worker: WorkerDescriptor;
    assignment: WorkerAssignment;
    invocation: ToolInvocation;
    idempotencyKey: string;
    expectedContractFingerprint?: string;
    signal?: AbortSignal;
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
  version: 1 | 2;
  /** Required for v2; legacy documents cannot authorize partial Work continuation. */
  caseId?: string;
  workKey?: string;
  consecutiveFailures?: number;
  pendingInvocation?: {
    turn: number;
    invocation: ToolInvocation;
    risk: ExecutionRisk;
    contractFingerprint: string;
  } | null;
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

export type ToolInvocationRecovery =
  | { status: "recorded"; result: ToolExecutionResult }
  | { status: "not_started" }
  | { status: "no_effect"; auditRef: string };

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
