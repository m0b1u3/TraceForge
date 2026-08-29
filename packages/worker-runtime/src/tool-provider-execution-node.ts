import { randomUUID } from "node:crypto";
import {
  EXECUTION_PROTOCOL_VERSION,
  permissionProfileFingerprint,
  resourceLimitsFingerprint,
  type ExecutionAttribution,
  type ExecutionNode,
  type ExecutionResourceLimits,
  type ProcessAccess,
  type ProcessDescriptor,
} from "@traceforge/execution-node";
import type { EffectivePermissionProfile } from "@traceforge/orchestration-core";
import type { ExecutionToolSpec, ToolExecutionContext, ToolExecutionResult } from "./model.js";
import {
  LengthPrefixedJsonDecoder,
  TOOL_PROVIDER_RPC_VERSION,
  ToolProviderRpcRemoteError,
  ToolProviderRpcTransportError,
  encodeLengthPrefixedJson,
  validateToolProviderHandshake,
  validateToolProviderResult,
  validateToolProviderSpec,
  type ToolProviderHandshake,
  type ToolProviderProcessAttestation,
  type ToolProviderProcessStatus,
  type ToolProviderRpcClient,
  type ToolProviderCommandMethod,
  type ToolProviderRpcRequest,
  type ToolProviderRpcResponse,
  type ProviderHostCapabilityCallParams,
  validateProviderHostCapabilityCall,
} from "./tool-provider-rpc.js";
import type { ProviderCapabilityHost, ProviderCapabilityInvocation } from "./provider-capability-broker.js";
import {
  createToolProviderDiagnostic,
  diagnosticPublicMessage,
  publicToolProviderDiagnosticSummary,
  type ToolProviderDiagnosticCategory,
  type ToolProviderDiagnosticWriter,
} from "./tool-provider-diagnostics.js";

export interface ExecutionNodeToolProviderOptions {
  node: ExecutionNode;
  executable: string;
  arguments?: string[];
  workingDirectory: string;
  environment?: Record<string, string>;
  attribution: ExecutionAttribution;
  permissions: EffectivePermissionProfile;
  resources: ExecutionResourceLimits;
  expectedSandboxBackend?: string;
  processTimeoutMs?: number;
  outputLimitBytes?: number;
  requestTimeoutMs?: number;
  maximumFrameBytes?: number;
  maximumInFlightRequests?: number;
  maximumStderrBytes?: number;
  expectedProviderId?: string;
  expectedProviderVersion?: string;
  capabilityHost?: ProviderCapabilityHost;
  diagnosticWriter?: ToolProviderDiagnosticWriter;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  context?: ToolExecutionContext;
}

export class ExecutionNodeToolProviderClient implements ToolProviderRpcClient {
  private access: ProcessAccess | null = null;
  private descriptor: ProcessDescriptor | null = null;
  private provider: ToolProviderHandshake | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private decoder: LengthPrefixedJsonDecoder;
  private startPromise: Promise<void> | null = null;
  private generation = 0;
  private epoch = 0;
  private cursor = 0;
  private closing = false;
  private state: ToolProviderProcessStatus["state"] = "stopped";
  private lastExit: ToolProviderProcessStatus["lastExit"] = null;
  private lastError: string | null = null;
  private lastDiagnosticRef: string | null = null;
  private stderr = Buffer.alloc(0);
  private omittedStderrBytes = 0;
  private attestation: ToolProviderProcessAttestation;
  private readonly processTimeoutMs: number;
  private readonly outputLimitBytes: number;
  private readonly requestTimeoutMs: number;
  private readonly maximumFrameBytes: number;
  private readonly maximumInFlight: number;
  private readonly maximumStderrBytes: number;
  private readonly reversePending = new Set<string>();

  constructor(private readonly options: ExecutionNodeToolProviderOptions) {
    if (options.permissions.network === "direct") throw new Error("Execution Node Tool Provider cannot use direct networking");
    if (options.permissions.process.access !== "sandboxed") throw new Error("Execution Node Tool Provider requires sandboxed process access");
    if (options.permissions.secrets === "plaintext") throw new Error("Execution Node Tool Provider cannot receive plaintext secrets");
    this.processTimeoutMs = positiveInteger(options.processTimeoutMs ?? 24 * 60 * 60 * 1_000, "process timeout");
    this.outputLimitBytes = positiveInteger(options.outputLimitBytes ?? 64 * 1024 * 1024, "output limit");
    this.requestTimeoutMs = positiveInteger(options.requestTimeoutMs ?? 15_000, "request timeout");
    this.maximumFrameBytes = positiveInteger(options.maximumFrameBytes ?? 4 * 1024 * 1024, "frame limit");
    if (this.maximumFrameBytes < 256) throw new Error("Execution Node Tool Provider frame limit must be at least 256 bytes");
    this.maximumInFlight = positiveInteger(options.maximumInFlightRequests ?? 16, "in-flight request limit");
    this.maximumStderrBytes = positiveInteger(options.maximumStderrBytes ?? 16 * 1024, "stderr limit");
    this.decoder = new LengthPrefixedJsonDecoder(this.maximumFrameBytes);
    this.attestation = { sandboxed: false, backend: "execution-node:pending", network: options.permissions.network };
  }

  async listTools(): Promise<ExecutionToolSpec[]> {
    const result = await this.request("tools.list", {});
    if (!Array.isArray(result)) throw new Error("Execution Node Tool Provider returned an invalid tool list");
    return result.map(validateToolProviderSpec);
  }

  async callTool(tool: string, input: unknown, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const { signal: _signal, ...rpcContext } = context;
    return validateToolProviderResult(await this.request("tools.call", { tool, input, context: rpcContext }, context));
  }

  async restart(): Promise<void> {
    await this.stopProcess();
    this.closing = false;
    await this.ensureReady();
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.stopProcess();
  }

  status(): ToolProviderProcessStatus {
    return {
      state: this.state,
      pid: this.descriptor?.pid ?? null,
      generation: this.generation,
      provider: this.provider ? { ...this.provider } : null,
      lastExit: this.lastExit ? { ...this.lastExit } : null,
      lastError: this.lastError,
      lastDiagnosticRef: this.lastDiagnosticRef,
      attestation: { ...this.attestation },
    };
  }

  private async request(method: ToolProviderCommandMethod, params: unknown, context?: ToolExecutionContext): Promise<unknown> {
    if (Date.parse(this.options.attribution.leaseExpiresAt) <= Date.now()) {
      await this.stopProcess();
      throw new Error(`Tool Provider service lease ${this.options.attribution.leaseId} has expired`);
    }
    await this.ensureReady();
    return this.send(method, params, context);
  }

  private ensureReady(): Promise<void> {
    if (this.access && this.state === "ready") return Promise.resolve();
    if (this.closing) return Promise.reject(new Error("Execution Node Tool Provider client is closed"));
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.start().finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  private async start(): Promise<void> {
    this.state = "starting";
    this.provider = null;
    this.stderr = Buffer.alloc(0);
    this.omittedStderrBytes = 0;
    this.decoder = new LengthPrefixedJsonDecoder(this.maximumFrameBytes);
    this.cursor = 0;
    try {
      const leaseRemainingMs = Date.parse(this.options.attribution.leaseExpiresAt) - Date.now();
      if (leaseRemainingMs <= 0) throw new Error(`Tool Provider service lease ${this.options.attribution.leaseId} has expired`);
      await this.options.node.handshake({
        clientId: `tool-provider:${this.options.attribution.workerId}`,
        protocol: EXECUTION_PROTOCOL_VERSION,
        requiredCapabilities: ["process.spawn", "process.stdio", "process.resource_limits"],
      });
      const started = await this.options.node.startProcess({
        requestId: `tool-provider:${this.options.attribution.idempotencyKey}:generation:${this.generation + 1}`,
        attribution: this.options.attribution,
        executable: this.options.executable,
        arguments: this.options.arguments ?? [],
        workingDirectory: this.options.workingDirectory,
        environment: this.options.environment ?? {},
        stdin: "pipe",
        timeoutMs: Math.min(this.processTimeoutMs, leaseRemainingMs),
        outputLimitBytes: this.outputLimitBytes,
        resources: this.options.resources,
        permissions: this.options.permissions,
      });
      this.access = { processId: started.process.id, adoptionToken: started.adoptionToken };
      this.descriptor = started.process;
      this.verifyEnforcement(started.process);
      this.generation += 1;
      const epoch = ++this.epoch;
      void this.pump(epoch);
      this.provider = validateToolProviderHandshake(await this.send("provider.handshake", {
        protocolVersion: TOOL_PROVIDER_RPC_VERSION,
        hostMethods: this.options.capabilityHost ? ["host.capability.call"] : [],
      }));
      if (this.options.expectedProviderId && this.provider.providerId !== this.options.expectedProviderId) {
        throw new Error(`Execution Node Tool Provider identity mismatch: expected ${this.options.expectedProviderId}`);
      }
      if (this.options.expectedProviderVersion && this.provider.providerVersion !== this.options.expectedProviderVersion) {
        throw new Error(`Execution Node Tool Provider version mismatch: expected ${this.options.expectedProviderVersion}`);
      }
      this.state = "ready";
      this.lastError = null;
    } catch (error) {
      this.state = "failed";
      this.lastError = error instanceof Error ? error.message : "Execution Node Tool Provider failed to start";
      await this.stopProcess();
      throw error;
    }
  }

  private verifyEnforcement(process: ProcessDescriptor): void {
    const enforcement = process.enforcement;
    if (!enforcement.sandboxed || !enforcement.filesystemPolicyApplied || !enforcement.resourceLimitsApplied) {
      throw new Error("Execution Node did not enforce the Tool Provider sandbox policy");
    }
    if (this.options.expectedSandboxBackend && enforcement.sandboxBackend !== this.options.expectedSandboxBackend) {
      throw new Error(`Execution Node used unexpected Tool Provider sandbox backend ${enforcement.sandboxBackend}`);
    }
    if (enforcement.permissionProfileFingerprint !== permissionProfileFingerprint(this.options.permissions)) {
      throw new Error("Execution Node Tool Provider permission attestation does not match the requested profile");
    }
    if (enforcement.resourceLimitsFingerprint !== resourceLimitsFingerprint(this.options.resources)) {
      throw new Error("Execution Node Tool Provider resource attestation does not match the requested limits");
    }
    if (enforcement.network !== this.options.permissions.network) {
      throw new Error("Execution Node Tool Provider network attestation does not match the requested policy");
    }
    this.attestation = { sandboxed: true, backend: enforcement.sandboxBackend, network: enforcement.network };
  }

  private send(method: ToolProviderCommandMethod, params: unknown, context?: ToolExecutionContext): Promise<unknown> {
    const access = this.access;
    if (!access) return Promise.reject(new ToolProviderRpcTransportError("Execution Node Tool Provider process is unavailable"));
    if (this.pending.size >= this.maximumInFlight) return Promise.reject(new Error("Execution Node Tool Provider in-flight request limit exceeded"));
    const id = randomUUID();
    const request: ToolProviderRpcRequest = { version: TOOL_PROVIDER_RPC_VERSION, id, method, params };
    const frame = encodeLengthPrefixedJson(request, this.maximumFrameBytes);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ToolProviderRpcTransportError(`Execution Node Tool Provider request ${method} timed out after ${this.requestTimeoutMs}ms`));
        void this.stopProcess();
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer, context });
      void this.options.node.writeProcessInput({ ...access, dataBase64: frame.toString("base64") }).catch((error) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(error instanceof Error ? error : new ToolProviderRpcTransportError("Execution Node Tool Provider input failed"));
      });
    });
  }

  private async pump(epoch: number): Promise<void> {
    while (this.access && epoch === this.epoch && !this.closing) {
      try {
        const batch = await this.options.node.waitProcessEvents({
          ...this.access, afterSequence: this.cursor, maximumEvents: 256,
        }, 1_000);
        if (epoch !== this.epoch) return;
        this.descriptor = batch.process;
        this.cursor = batch.nextSequence;
        if (batch.lostEvents) {
          this.transportFailed(new Error("Execution Node Tool Provider event stream lost protocol bytes"));
          return;
        }
        for (const event of batch.events) {
          if (event.type === "process.output" && event.stream === "stdout") this.onStdout(Buffer.from(event.dataBase64, "base64"));
          else if (event.type === "process.output" && event.stream === "stderr") this.onStderr(Buffer.from(event.dataBase64, "base64"));
          else if (event.type === "process.output" && event.stream === "pty") {
            this.transportFailed(new Error("Execution Node Tool Provider emitted unexpected PTY output"));
            return;
          } else if (event.type === "process.output_truncated") {
            this.transportFailed(new Error("Execution Node Tool Provider output exceeded its protocol limit"));
            return;
          } else if (event.type === "process.resource_limit_exceeded") {
            this.transportFailed(new Error(`Execution Node Tool Provider exceeded ${event.resource} quota`));
            return;
          }
        }
        if (batch.process.state === "exited" || batch.process.state === "failed") {
          this.processExited(batch.process);
          return;
        }
      } catch (error) {
        if (epoch !== this.epoch || this.closing) return;
        this.transportFailed(error instanceof Error ? error : new Error("Execution Node Tool Provider event stream failed"));
        return;
      }
    }
  }

  private onStdout(chunk: Buffer): void {
    let values: unknown[];
    try {
      values = this.decoder.push(chunk);
    } catch (error) {
      this.transportFailed(error instanceof Error ? error : new Error("Execution Node Tool Provider returned an invalid frame"));
      return;
    }
    for (const value of values) this.onFrame(value);
  }

  private onFrame(value: unknown): void {
    if (isProviderHostRpcRequest(value)) {
      this.onProviderRequest(value);
      return;
    }
    if (!isRecord(value) || value.version !== TOOL_PROVIDER_RPC_VERSION || typeof value.id !== "string" || typeof value.ok !== "boolean") {
      this.transportFailed(new Error("Execution Node Tool Provider returned an invalid RPC response"));
      return;
    }
    const response = value as unknown as ToolProviderRpcResponse;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(response.id);
    if (response.ok) pending.resolve(response.result);
    else if (isRecord(response.error) && typeof response.error.code === "string" && typeof response.error.message === "string" && typeof response.error.retryable === "boolean") {
      pending.reject(new ToolProviderRpcRemoteError(
        response.error.code,
        this.diagnostic("remote_error", "Tool Provider reported an error", `${response.error.code}: ${response.error.message}`, pending.context),
        response.error.retryable,
      ));
    } else pending.reject(new Error("Execution Node Tool Provider returned an invalid RPC error"));
  }

  private onProviderRequest(request: ToolProviderRpcRequest): void {
    const access = this.access;
    const generation = this.generation;
    if (!access) return;
    if (request.method !== "host.capability.call") {
      void this.writeHostResponse(access, generation, request.id, false,
        rpcError("method_not_found", `Provider host method ${request.method} is not supported`));
      return;
    }
    let params: ProviderHostCapabilityCallParams;
    try {
      params = validateProviderHostCapabilityCall(request.params);
    } catch (error) {
      void this.writeHostResponse(access, generation, request.id, false, rpcError("invalid_params", errorMessage(error)));
      return;
    }
    const context = this.pending.get(params.parentRequestId)?.context;
    if (!context) {
      void this.writeHostResponse(access, generation, request.id, false,
        rpcError("unknown_parent", "Provider capability parent tools.call is not active"));
      return;
    }
    const provider = this.provider;
    if (!provider || !this.options.capabilityHost) {
      void this.writeHostResponse(access, generation, request.id, false,
        rpcError("capability_unavailable", "Provider host capability broker is unavailable"));
      return;
    }
    if (this.reversePending.has(request.id) || this.reversePending.size >= this.maximumInFlight) {
      void this.writeHostResponse(access, generation, request.id, false,
        rpcError("reverse_limit", "Provider host capability in-flight limit exceeded", true));
      return;
    }
    const invocation: ProviderCapabilityInvocation = {
      provider: { id: provider.providerId, version: provider.providerVersion, generation },
      parentRequestId: params.parentRequestId,
      capability: params.capability,
      action: params.action,
      idempotencyKey: params.idempotencyKey,
      input: params.input,
      attribution: context,
      depth: 1,
    };
    this.reversePending.add(request.id);
    void this.options.capabilityHost.invoke(invocation)
      .then((receipt) => this.writeHostResponse(access, generation, request.id, true, receipt))
      .catch((error) => this.writeHostResponse(access, generation, request.id, false,
        rpcError("capability_failed", errorMessage(error), isRetryableError(error))))
      .finally(() => { this.reversePending.delete(request.id); });
  }

  private async writeHostResponse(
    access: ProcessAccess,
    generation: number,
    id: string,
    ok: boolean,
    value: unknown,
  ): Promise<void> {
    if (!this.access || this.access.processId !== access.processId || this.access.adoptionToken !== access.adoptionToken
      || this.generation !== generation) return;
    const response: ToolProviderRpcResponse = ok
      ? { version: TOOL_PROVIDER_RPC_VERSION, id, ok: true, result: value }
      : { version: TOOL_PROVIDER_RPC_VERSION, id, ok: false, error: value as { code: string; message: string; retryable: boolean } };
    let frame: Buffer;
    try {
      frame = encodeLengthPrefixedJson(response, this.maximumFrameBytes);
    } catch (error) {
      this.transportFailed(error instanceof Error ? error : new Error("Provider host response exceeded protocol limits"));
      return;
    }
    await this.options.node.writeProcessInput({ ...access, dataBase64: frame.toString("base64") }).catch((error) => {
      if (this.access?.processId === access.processId && this.access.adoptionToken === access.adoptionToken
        && this.generation === generation) {
        this.transportFailed(error instanceof Error ? error : new Error("Execution Node Provider host response failed"));
      }
    });
  }

  private onStderr(chunk: Buffer): void {
    const combined = Buffer.concat([this.stderr, chunk]);
    this.omittedStderrBytes += Math.max(0, combined.length - this.maximumStderrBytes);
    this.stderr = combined.subarray(-this.maximumStderrBytes);
  }

  private processExited(process: ProcessDescriptor): void {
    this.lastExit = { code: process.exitCode, signal: process.exitSignal };
    this.descriptor = null;
    this.access = null;
    this.provider = null;
    if (!this.closing) this.state = process.exitCode === 0 ? "stopped" : "failed";
    const detail = this.stderr.toString("utf8").trim();
    if (process.exitCode === 0) this.lastError = null;
    else if (!this.lastError) this.lastError = this.diagnostic(
      "process_exit", `Tool Provider exited with code ${String(process.exitCode)}`, detail, undefined, this.omittedStderrBytes,
    );
    this.rejectPending(new ToolProviderRpcTransportError(this.lastError ?? "Execution Node Tool Provider process exited"));
  }

  private transportFailed(error: Error): void {
    this.lastError = this.diagnostic("transport", "Tool Provider transport failed", error.message);
    this.state = "failed";
    this.rejectPending(error instanceof ToolProviderRpcTransportError ? error : new ToolProviderRpcTransportError(error.message));
    void this.stopProcess();
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.reversePending.clear();
  }

  private diagnostic(
    category: ToolProviderDiagnosticCategory,
    summary: string,
    detail: string,
    context?: ToolExecutionContext,
    previouslyOmittedDetailBytes = 0,
  ): string {
    if (!this.options.diagnosticWriter) return publicToolProviderDiagnosticSummary(summary);
    const identity = this.provider
      ? { id: this.provider.providerId, version: this.provider.providerVersion, generation: this.generation }
      : this.options.expectedProviderId && this.options.expectedProviderVersion
        ? { id: this.options.expectedProviderId, version: this.options.expectedProviderVersion, generation: this.generation }
        : null;
    const record = createToolProviderDiagnostic({
      provider: identity,
      category,
      summary,
      detail, previouslyOmittedDetailBytes,
      attribution: context
        ? { caseId: context.caseId, runId: context.runId, workId: context.workId }
        : { caseId: this.options.attribution.caseId, runId: this.options.attribution.runId, workId: this.options.attribution.workId },
    });
    try { this.options.diagnosticWriter.write(record); }
    catch { return publicToolProviderDiagnosticSummary(summary); }
    this.lastDiagnosticRef = record.id;
    return diagnosticPublicMessage(record);
  }

  private async stopProcess(): Promise<void> {
    const access = this.access;
    this.access = null;
    this.descriptor = null;
    this.provider = null;
    this.epoch += 1;
    if (access) await this.options.node.terminateProcess({ ...access, force: true }).catch(() => undefined);
    this.rejectPending(new ToolProviderRpcTransportError("Execution Node Tool Provider process stopped"));
    this.state = "stopped";
  }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`Execution Node Tool Provider ${label} must be a positive integer`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isProviderHostRpcRequest(value: unknown): value is ToolProviderRpcRequest {
  return isRecord(value) && value.version === TOOL_PROVIDER_RPC_VERSION
    && typeof value.id === "string" && typeof value.method === "string" && "params" in value;
}

function rpcError(code: string, message: string, retryable = false): { code: string; message: string; retryable: boolean } {
  return { code, message, retryable };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown Provider host capability failure";
}

function isRetryableError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "retryable" in error && error.retryable === true);
}
