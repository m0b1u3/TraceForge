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
  type ToolProviderRpcMethod,
  type ToolProviderRpcRequest,
  type ToolProviderRpcResponse,
} from "./tool-provider-rpc.js";

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
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
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
  private stderr = Buffer.alloc(0);
  private attestation: ToolProviderProcessAttestation;
  private readonly processTimeoutMs: number;
  private readonly outputLimitBytes: number;
  private readonly requestTimeoutMs: number;
  private readonly maximumFrameBytes: number;
  private readonly maximumInFlight: number;
  private readonly maximumStderrBytes: number;

  constructor(private readonly options: ExecutionNodeToolProviderOptions) {
    if (options.permissions.network === "direct") throw new Error("Execution Node Tool Provider cannot use direct networking");
    if (options.permissions.process.access !== "sandboxed") throw new Error("Execution Node Tool Provider requires sandboxed process access");
    if (options.permissions.secrets !== "handles_only") throw new Error("Execution Node Tool Provider requires handle-only secret access");
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
    return validateToolProviderResult(await this.request("tools.call", { tool, input, context }));
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
      attestation: { ...this.attestation },
    };
  }

  private async request(method: ToolProviderRpcMethod, params: unknown): Promise<unknown> {
    if (Date.parse(this.options.attribution.leaseExpiresAt) <= Date.now()) {
      await this.stopProcess();
      throw new Error(`Tool Provider service lease ${this.options.attribution.leaseId} has expired`);
    }
    await this.ensureReady();
    return this.send(method, params);
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
      this.provider = validateToolProviderHandshake(await this.send("provider.handshake", { protocolVersion: TOOL_PROVIDER_RPC_VERSION }));
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

  private send(method: ToolProviderRpcMethod, params: unknown): Promise<unknown> {
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
      this.pending.set(id, { resolve, reject, timer });
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
    for (const value of values) this.onResponse(value);
  }

  private onResponse(value: unknown): void {
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
      pending.reject(new ToolProviderRpcRemoteError(response.error.code, response.error.message, response.error.retryable));
    } else pending.reject(new Error("Execution Node Tool Provider returned an invalid RPC error"));
  }

  private onStderr(chunk: Buffer): void {
    this.stderr = Buffer.concat([this.stderr, chunk]).subarray(-this.maximumStderrBytes);
  }

  private processExited(process: ProcessDescriptor): void {
    this.lastExit = { code: process.exitCode, signal: process.exitSignal };
    this.descriptor = null;
    this.access = null;
    this.provider = null;
    if (!this.closing) this.state = process.exitCode === 0 ? "stopped" : "failed";
    const detail = this.stderr.toString("utf8").trim();
    this.lastError = process.exitCode === 0 ? null
      : detail ? `Tool Provider exited with code ${String(process.exitCode)}: ${detail}` : `Tool Provider exited with code ${String(process.exitCode)}`;
    this.rejectPending(new ToolProviderRpcTransportError(this.lastError ?? "Execution Node Tool Provider process exited"));
  }

  private transportFailed(error: Error): void {
    this.lastError = error.message;
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
