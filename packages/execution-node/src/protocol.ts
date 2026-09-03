import { createHash } from "node:crypto";
import type { EffectivePermissionProfile } from "@traceforge/orchestration-core";

export const EXECUTION_PROTOCOL_VERSION = { major: 1, minor: 8 } as const;

export interface ExecutionProtocolVersion {
  major: number;
  minor: number;
}

export type ExecutionCapabilityName =
  | "process.spawn"
  | "process.stdio"
  | "process.tty"
  | "process.adopt"
  | "process.resource_limits"
  | "process.execution_observation"
  | "process.operation_observation"
  | "filesystem.canonicalize"
  | "filesystem.read"
  | "filesystem.write"
  | "filesystem.list"
  | "filesystem.stat"
  | "network.brokered"
  | "http.request"
  | "http.streaming";

export interface ExecutionNodeCapabilities {
  process: {
    spawn: boolean;
    stdio: boolean;
    tty: boolean;
    adoption: boolean;
    resourceLimits: boolean;
    executionObservation?: boolean;
    operationObservation?: boolean;
    signals: ProcessSignal[];
  };
  filesystem: {
    canonicalize: boolean;
    read: boolean;
    write: boolean;
    list: boolean;
    stat: boolean;
    maximumChunkBytes: number;
    maximumListEntries: number;
  };
  network: { brokered: boolean };
  http: { request: boolean; streaming: boolean };
  sandbox: {
    backends: string[];
    /** SHA-256 of the exact native helper accepted during host startup. */
    measurements?: Record<string, string>;
  };
}

export interface ExecutionNodeDescriptor {
  id: string;
  protocol: ExecutionProtocolVersion;
  platform: EffectivePermissionProfile["platform"];
  architecture: string;
  capabilities: ExecutionNodeCapabilities;
  limits: {
    maximumProcesses: number;
    maximumOutputBytesPerProcess: number;
    maximumRetainedEventsPerProcess: number;
    maximumCpuTimeMsPerProcess: number;
    maximumMemoryBytesPerProcess: number;
    maximumProcessesPerExecution: number;
    maximumWriteBytesPerProcess: number;
    maximumHttpRequestBytes: number;
    maximumHttpResponseBytes: number;
    maximumHttpHeaders: number;
    maximumConcurrentHttpRequests: number;
  };
  startedAt: string;
}

export interface ExecutionHandshakeRequest {
  clientId: string;
  protocol: ExecutionProtocolVersion;
  requiredCapabilities: ExecutionCapabilityName[];
}

export interface ExecutionHandshakeResponse {
  node: ExecutionNodeDescriptor;
  negotiatedProtocol: ExecutionProtocolVersion;
  capabilities: ExecutionCapabilityName[];
}

export interface ExecutionAttribution {
  caseId: string;
  runId: string;
  workId: string;
  workerId: string;
  scopeRef: string;
  leaseId: string;
  leaseExpiresAt: string;
  actionId: string;
  idempotencyKey: string;
}

export type ProcessSignal = "interrupt" | "terminate" | "kill" | "hangup" | "user1" | "user2";
export type ProcessState = "starting" | "running" | "terminating" | "exited" | "failed";
export type ProcessOutputStream = "stdout" | "stderr" | "pty";

export interface ProcessTerminalRequest {
  columns: number;
  rows: number;
  terminalType?: string;
}

export interface ExecutionResourceLimits {
  cpuTimeMs: number;
  memoryBytes: number;
  maximumProcesses: number;
  writeBytes: number;
}

export type ResourceLimitKind = "cpu_time" | "memory" | "process_count" | "write_bytes";

function canonicalResourceJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalResourceJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalResourceJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function resourceLimitsFingerprint(limits: ExecutionResourceLimits): string {
  return createHash("sha256").update(canonicalResourceJson(limits)).digest("hex");
}

export interface StartProcessRequest {
  requestId: string;
  attribution: ExecutionAttribution;
  executable: string;
  arguments: string[];
  workingDirectory: string;
  environment: Record<string, string>;
  stdin: "closed" | "pipe";
  terminal?: ProcessTerminalRequest;
  timeoutMs: number;
  outputLimitBytes: number;
  resources: ExecutionResourceLimits;
  permissions: EffectivePermissionProfile;
}

export interface ProcessDescriptor {
  id: string;
  nodeId: string;
  pid: number;
  state: ProcessState;
  attribution: ExecutionAttribution;
  executable: string;
  arguments: string[];
  workingDirectory: string;
  terminal: ProcessTerminalRequest | null;
  enforcement: ProcessEnforcementAttestation;
  startedAt: string;
  updatedAt: string;
  exitedAt: string | null;
  exitCode: number | null;
  exitSignal: string | null;
  resourceLimitExceeded: ResourceLimitKind | null;
  capturedOutputBytes: number;
  omittedOutputBytes: number;
  lastEventSequence: number;
}

export interface StartProcessResponse {
  process: ProcessDescriptor;
  adoptionToken: string;
  replayed: boolean;
}

export interface ProcessAccess {
  processId: string;
  adoptionToken: string;
}

/** Authenticated host query. An absent/claimed record NEVER proves that execution did not happen. */
export interface ProcessExecutionQuery {
  idempotencyKey: string;
  requestId: string;
  caseId: string;
  runId: string;
  workId: string;
  leaseId: string;
}

export interface ProcessExecutionObservation {
  schemaVersion: 1 | 2;
  /** V2 host-generated identity; absence in legacy observations cannot be repaired by guessing. */
  launch?: ProcessLaunchIdentity;
  identity: ProcessExecutionQuery;
  nodeId: string;
  requestFingerprint: string;
  status: "claimed" | "exit_observed" | "failure_observed";
  /** A main-process exit is not a process-tree cleanup attestation. */
  cleanup: "unverified";
  process: ProcessDescriptor | null;
  events: ProcessEvent[];
  lostEvents: boolean;
  updatedAt: string;
  /** History payload only; launch identity and the permanent execution claim remain intact. */
  historyRetention?: { purgedAt: string; originalDigest: string };
}

export interface ProcessLaunchIdentity {
  nodeId: string;
  generationId: string;
  launchId: string;
  requestFingerprint: string;
  requestId: string;
}

export interface ProcessExecutionJournal {
  claim(observation: ProcessExecutionObservation): void;
  settle(observation: ProcessExecutionObservation): void;
  get(idempotencyKey: string): ProcessExecutionObservation | undefined;
}

export type ProcessOperationKind = "process.writeInput" | "process.resizeTerminal" | "process.signal" | "process.terminate" | "process.adopt";

export interface ProcessOperationIdentity {
  operationId: string;
  operation: ProcessOperationKind;
  processId: string;
  requestFingerprint: string;
}

export interface ProcessOperationObservation {
  schemaVersion: 1;
  identity: ProcessOperationIdentity;
  nodeId: string;
  state: "claimed" | "completed";
  response: ProcessDescriptor | AdoptProcessResponse | null;
  updatedAt: string;
}

export interface ProcessOperationJournal {
  claim(observation: ProcessOperationObservation): void;
  complete(observation: ProcessOperationObservation): void;
  get(operationId: string): ProcessOperationObservation | undefined;
}

export interface ProcessOperationQuery extends ProcessOperationIdentity {}

export interface ProcessOperationAccess extends ProcessAccess {
  /** Stable caller-generated identity for exactly one process-side effect. */
  operationId: string;
}

export interface AdoptProcessRequest extends ProcessOperationAccess {
  attribution: ExecutionAttribution;
}

export interface AdoptProcessResponse {
  process: ProcessDescriptor;
  adoptionToken: string;
}

export interface ProcessEventBase {
  sequence: number;
  processId: string;
  at: string;
}

export type ProcessEvent =
  | ProcessEventBase & { type: "process.started"; pid: number }
  | ProcessEventBase & { type: "process.output"; stream: ProcessOutputStream; dataBase64: string; bytes: number }
  | ProcessEventBase & { type: "process.output_truncated"; outputLimitBytes: number }
  | ProcessEventBase & { type: "process.stdin_closed" }
  | ProcessEventBase & { type: "process.signal_sent"; signal: ProcessSignal }
  | ProcessEventBase & { type: "process.resource_limit_exceeded"; resource: ResourceLimitKind }
  | ProcessEventBase & { type: "process.exited"; exitCode: number | null; signal: string | null }
  | ProcessEventBase & { type: "process.failed"; error: string };

export interface ReadProcessEventsRequest extends ProcessAccess {
  afterSequence: number;
  maximumEvents: number;
}

export interface ReadProcessEventsResponse {
  process: ProcessDescriptor;
  events: ProcessEvent[];
  nextSequence: number;
  lostEvents: boolean;
}

export interface WriteProcessInputRequest extends ProcessOperationAccess {
  dataBase64: string;
  closeAfterWrite?: boolean;
}

export interface ResizeProcessTerminalRequest extends ProcessOperationAccess {
  columns: number;
  rows: number;
}

export interface SignalProcessRequest extends ProcessOperationAccess {
  signal: ProcessSignal;
}

export interface TerminateProcessRequest extends ProcessOperationAccess {
  force?: boolean;
}

export interface ProcessEnforcementAttestation {
  sandboxBackend: string;
  /** SHA-256 of the helper executable used for this launch, when the backend is measured. */
  backendMeasurement?: string;
  sandboxed: boolean;
  filesystemPolicyApplied: boolean;
  permissionProfileFingerprint: string;
  resourceLimitsApplied: boolean;
  resourceLimitsFingerprint: string;
  network: "deny" | "brokered" | "direct";
  /** Native helper accepted the child into its owned process-tree boundary before releasing exec. */
  atomicProcessTreeAssignment?: boolean;
  /** Helper does not report terminal until its owned OS process tree is empty. */
  processTreeEmptyBarrier?: boolean;
  linux?: {namespaces:readonly ("user"|"mount"|"pid"|"ipc"|"uts"|"network")[];cgroupV2:true;seccomp:true;noNewPrivileges:true};
}

function canonicalPermissionJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalPermissionJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalPermissionJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function permissionProfileFingerprint(profile: EffectivePermissionProfile): string {
  return createHash("sha256").update(canonicalPermissionJson(profile)).digest("hex");
}

export interface FileOperationContext {
  requestId: string;
  attribution: ExecutionAttribution;
  permissions: EffectivePermissionProfile;
}

export interface CanonicalizePathRequest extends FileOperationContext {
  path: string;
  access: "read" | "write";
}

export interface ReadFileChunkRequest extends FileOperationContext {
  path: string;
  offset: number;
  length: number;
}

export interface ReadFileChunkResponse {
  canonicalPath: string;
  offset: number;
  dataBase64: string;
  bytes: number;
  size: number;
  eof: boolean;
}

export interface WriteFileChunkRequest extends FileOperationContext {
  path: string;
  offset: number;
  dataBase64: string;
  create: boolean;
  truncate: boolean;
}

export interface WriteFileChunkResponse {
  canonicalPath: string;
  bytesWritten: number;
  size: number;
  replayed: boolean;
}

export interface ListDirectoryRequest extends FileOperationContext {
  path: string;
  maximumEntries: number;
}

export interface DirectoryEntry {
  name: string;
  kind: "file" | "directory" | "symlink" | "other";
}

export interface ListDirectoryResponse {
  canonicalPath: string;
  entries: DirectoryEntry[];
  omittedEntries: number;
}

export interface StatPathRequest extends FileOperationContext {
  path: string;
}

export interface StatPathResponse {
  canonicalPath: string;
  kind: DirectoryEntry["kind"];
  size: number;
  modifiedAt: string;
}

export interface BrokeredHttpHeader {
  name: string;
  value: string;
}

export interface BrokeredHttpRequest {
  requestId: string;
  attribution: ExecutionAttribution;
  permissions: EffectivePermissionProfile;
  authorizationAction: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  bodyBase64?: string;
  timeoutMs: number;
  responseLimitBytes: number;
}

export interface BrokeredNetworkReceipt {
  id: string;
  nodeId: string;
  requestId: string;
  attribution: ExecutionAttribution;
  authorizationRef: string;
  authorizationAction: string;
  url: string;
  method: string;
  status: number;
  requestBytes: number;
  responseBytes: number;
  responseBodyTruncated: boolean;
  permissionProfileFingerprint: string;
  redirectFollowed: false;
  startedAt: string;
  completedAt: string;
}

export interface BrokeredHttpResponse {
  receipt: BrokeredNetworkReceipt;
  status: number;
  headers: BrokeredHttpHeader[];
  bodyBase64: string;
  responseBytes: number;
  bodyTruncated: boolean;
  replayed: boolean;
}

export interface ExecutionNode {
  lookupProcessExecution?(query: ProcessExecutionQuery): Promise<ProcessExecutionObservation | undefined>;
  lookupProcessOperation?(query: ProcessOperationQuery): Promise<ProcessOperationObservation | undefined>;
  handshake(request: ExecutionHandshakeRequest): Promise<ExecutionHandshakeResponse>;
  startProcess(request: StartProcessRequest): Promise<StartProcessResponse>;
  describeProcess(access: ProcessAccess): Promise<ProcessDescriptor>;
  readProcessEvents(request: ReadProcessEventsRequest): Promise<ReadProcessEventsResponse>;
  waitProcessEvents(request: ReadProcessEventsRequest, timeoutMs: number): Promise<ReadProcessEventsResponse>;
  writeProcessInput(request: WriteProcessInputRequest): Promise<ProcessDescriptor>;
  resizeProcessTerminal(request: ResizeProcessTerminalRequest): Promise<ProcessDescriptor>;
  signalProcess(request: SignalProcessRequest): Promise<ProcessDescriptor>;
  terminateProcess(request: TerminateProcessRequest): Promise<ProcessDescriptor>;
  adoptProcess(request: AdoptProcessRequest): Promise<AdoptProcessResponse>;
  canonicalizePath(request: CanonicalizePathRequest): Promise<string>;
  readFileChunk(request: ReadFileChunkRequest): Promise<ReadFileChunkResponse>;
  writeFileChunk(request: WriteFileChunkRequest): Promise<WriteFileChunkResponse>;
  listDirectory(request: ListDirectoryRequest): Promise<ListDirectoryResponse>;
  statPath(request: StatPathRequest): Promise<StatPathResponse>;
  requestHttp(request: BrokeredHttpRequest): Promise<BrokeredHttpResponse>;
}

export function capabilityNames(capabilities: ExecutionNodeCapabilities): ExecutionCapabilityName[] {
  const names: ExecutionCapabilityName[] = [];
  if (capabilities.process.spawn) names.push("process.spawn");
  if (capabilities.process.stdio) names.push("process.stdio");
  if (capabilities.process.tty) names.push("process.tty");
  if (capabilities.process.adoption) names.push("process.adopt");
  if (capabilities.process.resourceLimits) names.push("process.resource_limits");
  if (capabilities.process.executionObservation) names.push("process.execution_observation");
  if (capabilities.process.operationObservation) names.push("process.operation_observation");
  if (capabilities.filesystem.canonicalize) names.push("filesystem.canonicalize");
  if (capabilities.filesystem.read) names.push("filesystem.read");
  if (capabilities.filesystem.write) names.push("filesystem.write");
  if (capabilities.filesystem.list) names.push("filesystem.list");
  if (capabilities.filesystem.stat) names.push("filesystem.stat");
  if (capabilities.network.brokered) names.push("network.brokered");
  if (capabilities.http.request) names.push("http.request");
  if (capabilities.http.streaming) names.push("http.streaming");
  return names;
}

export function negotiateExecutionProtocol(
  request: ExecutionHandshakeRequest,
  node: ExecutionNodeDescriptor,
): ExecutionHandshakeResponse {
  if (!request.clientId.trim()) throw new Error("Execution client id is required");
  if (request.protocol.major !== node.protocol.major) {
    throw new Error(`Execution protocol major version mismatch: client=${request.protocol.major}, node=${node.protocol.major}`);
  }
  const available = capabilityNames(node.capabilities);
  const missing = [...new Set(request.requiredCapabilities)].filter((capability) => !available.includes(capability));
  if (missing.length) throw new Error(`Execution node is missing required capabilities: ${missing.join(", ")}`);
  return {
    node,
    negotiatedProtocol: { major: node.protocol.major, minor: Math.min(request.protocol.minor, node.protocol.minor) },
    capabilities: available,
  };
}
