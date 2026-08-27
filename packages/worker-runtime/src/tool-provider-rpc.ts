import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ExecutionToolSpec, ToolExecutionContext, ToolExecutionResult } from "./model.js";
import type { ExecutionToolAdapter } from "./tool-gateway.js";
import type { ExecutionToolDiscoverySource } from "./tool-discovery.js";

export const TOOL_PROVIDER_RPC_VERSION = 1 as const;

export type ToolProviderRpcMethod = "provider.handshake" | "tools.list" | "tools.call";

export interface ToolProviderRpcRequest {
  version: typeof TOOL_PROVIDER_RPC_VERSION;
  id: string;
  method: ToolProviderRpcMethod;
  params: unknown;
}

export type ToolProviderRpcResponse =
  | { version: typeof TOOL_PROVIDER_RPC_VERSION; id: string; ok: true; result: unknown }
  | { version: typeof TOOL_PROVIDER_RPC_VERSION; id: string; ok: false; error: { code: string; message: string; retryable: boolean } };

export interface ToolProviderHandshake {
  providerId: string;
  providerVersion: string;
  protocolVersion: typeof TOOL_PROVIDER_RPC_VERSION;
}

export interface ToolProviderProcessAttestation {
  sandboxed: boolean;
  backend: string;
  network: "deny" | "brokered" | "direct";
}

export interface ToolProviderProcessOptions {
  executable: string;
  arguments?: string[];
  workingDirectory: string;
  environment?: Record<string, string>;
  attestation: ToolProviderProcessAttestation;
  allowUnsandboxedDevelopment?: boolean;
  requestTimeoutMs?: number;
  maximumFrameBytes?: number;
  maximumInFlightRequests?: number;
  maximumStderrBytes?: number;
}

export interface ToolProviderProcessStatus {
  state: "stopped" | "starting" | "ready" | "failed";
  pid: number | null;
  generation: number;
  provider: ToolProviderHandshake | null;
  lastExit: { code: number | null; signal: string | null } | null;
  lastError: string | null;
  attestation: ToolProviderProcessAttestation;
}

export class ToolProviderRpcRemoteError extends Error {
  constructor(readonly code: string, message: string, readonly retryable: boolean) {
    super(message);
    this.name = "ToolProviderRpcRemoteError";
  }
}

export class ToolProviderRpcTransportError extends Error {
  readonly retryable = true;
  constructor(message: string) {
    super(message);
    this.name = "ToolProviderRpcTransportError";
  }
}

export interface ToolProviderRpcClient {
  listTools(): Promise<ExecutionToolSpec[]>;
  callTool(tool: string, input: unknown, context: ToolExecutionContext): Promise<ToolExecutionResult>;
  restart(): Promise<void>;
  close(): Promise<void>;
  status(): ToolProviderProcessStatus;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class ToolProviderProcessClient implements ToolProviderRpcClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private decoder: LengthPrefixedJsonDecoder;
  private readonly pending = new Map<string, PendingRequest>();
  private startPromise: Promise<void> | null = null;
  private closing = false;
  private generation = 0;
  private provider: ToolProviderHandshake | null = null;
  private lastExit: ToolProviderProcessStatus["lastExit"] = null;
  private lastError: string | null = null;
  private stderr = Buffer.alloc(0);
  private state: ToolProviderProcessStatus["state"] = "stopped";
  private readonly requestTimeoutMs: number;
  private readonly maximumFrameBytes: number;
  private readonly maximumInFlight: number;
  private readonly maximumStderrBytes: number;

  constructor(private readonly options: ToolProviderProcessOptions) {
    if (!isAbsolute(options.executable)) throw new Error("Tool Provider executable must use an absolute path");
    if (!isAbsolute(options.workingDirectory)) throw new Error("Tool Provider working directory must use an absolute path");
    if (!options.attestation.sandboxed && !options.allowUnsandboxedDevelopment) {
      throw new Error("Tool Provider requires a sandbox attestation in production mode");
    }
    this.requestTimeoutMs = positiveInteger(options.requestTimeoutMs ?? 15_000, "request timeout");
    this.maximumFrameBytes = positiveInteger(options.maximumFrameBytes ?? 4 * 1024 * 1024, "frame limit");
    if (this.maximumFrameBytes < 256) throw new Error("Tool Provider frame limit must be at least 256 bytes");
    this.maximumInFlight = positiveInteger(options.maximumInFlightRequests ?? 16, "in-flight request limit");
    this.maximumStderrBytes = positiveInteger(options.maximumStderrBytes ?? 16 * 1024, "stderr limit");
    this.decoder = new LengthPrefixedJsonDecoder(this.maximumFrameBytes);
  }

  async listTools(): Promise<ExecutionToolSpec[]> {
    const result = await this.request("tools.list", {});
    if (!Array.isArray(result)) throw new Error("Tool Provider returned an invalid tool list");
    return result.map(validateToolProviderSpec);
  }

  async callTool(tool: string, input: unknown, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    return validateToolProviderResult(await this.request("tools.call", { tool, input, context }));
  }

  async restart(): Promise<void> {
    await this.stopChild();
    this.closing = false;
    await this.ensureReady();
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.stopChild();
  }

  status(): ToolProviderProcessStatus {
    return {
      state: this.state,
      pid: this.child?.pid ?? null,
      generation: this.generation,
      provider: this.provider ? { ...this.provider } : null,
      lastExit: this.lastExit ? { ...this.lastExit } : null,
      lastError: this.lastError,
      attestation: { ...this.options.attestation },
    };
  }

  private async request(method: ToolProviderRpcMethod, params: unknown): Promise<unknown> {
    await this.ensureReady();
    return this.send(method, params);
  }

  private ensureReady(): Promise<void> {
    if (this.child && this.state === "ready") return Promise.resolve();
    if (this.closing) return Promise.reject(new Error("Tool Provider client is closed"));
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.start().finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  private async start(): Promise<void> {
    this.state = "starting";
    this.provider = null;
    this.stderr = Buffer.alloc(0);
    this.decoder = new LengthPrefixedJsonDecoder(this.maximumFrameBytes);
    const child = spawn(this.options.executable, this.options.arguments ?? [], {
      cwd: this.options.workingDirectory,
      env: this.options.environment ?? {},
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.generation += 1;
    child.stdout.on("data", (chunk: Buffer) => this.onStdout(child, chunk));
    child.stderr.on("data", (chunk: Buffer) => this.onStderr(chunk));
    child.once("error", (error) => this.failChild(child, error));
    child.once("exit", (code, signal) => this.onExit(child, code, signal));
    try {
      const handshake = validateToolProviderHandshake(await this.send("provider.handshake", { protocolVersion: TOOL_PROVIDER_RPC_VERSION }));
      this.provider = handshake;
      this.state = "ready";
      this.lastError = null;
    } catch (error) {
      this.state = "failed";
      this.lastError = error instanceof Error ? error.message : "Tool Provider handshake failed";
      await this.stopChild();
      throw error;
    }
  }

  private send(method: ToolProviderRpcMethod, params: unknown): Promise<unknown> {
    const child = this.child;
    if (!child || child.stdin.destroyed) return Promise.reject(new ToolProviderRpcTransportError("Tool Provider process is unavailable"));
    if (this.pending.size >= this.maximumInFlight) return Promise.reject(new Error("Tool Provider in-flight request limit exceeded"));
    const id = randomUUID();
    const request: ToolProviderRpcRequest = { version: TOOL_PROVIDER_RPC_VERSION, id, method, params };
    let frame: Buffer;
    try {
      frame = encodeLengthPrefixedJson(request, this.maximumFrameBytes);
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ToolProviderRpcTransportError(`Tool Provider request ${method} timed out after ${this.requestTimeoutMs}ms`));
        child.kill();
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(frame, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(error);
      });
    });
  }

  private onStdout(child: ChildProcessWithoutNullStreams, chunk: Buffer): void {
    if (child !== this.child) return;
    let frames: unknown[];
    try {
      frames = this.decoder.push(chunk);
    } catch (error) {
      this.failChild(child, error instanceof Error ? error : new Error("Invalid Tool Provider frame"));
      return;
    }
    for (const value of frames) this.onResponse(child, value);
  }

  private onResponse(child: ChildProcessWithoutNullStreams, value: unknown): void {
    if (!isRecord(value) || value.version !== TOOL_PROVIDER_RPC_VERSION || typeof value.id !== "string" || typeof value.ok !== "boolean") {
      this.failChild(child, new Error("Tool Provider returned an invalid RPC response"));
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
    } else {
      pending.reject(new Error("Tool Provider returned an invalid RPC error"));
    }
  }

  private onStderr(chunk: Buffer): void {
    this.stderr = Buffer.concat([this.stderr, chunk]).subarray(-this.maximumStderrBytes);
  }

  private failChild(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (child !== this.child) return;
    this.lastError = error.message;
    this.state = "failed";
    child.kill();
    this.rejectPending(error);
  }

  private onExit(child: ChildProcessWithoutNullStreams, code: number | null, signal: NodeJS.Signals | null): void {
    if (child !== this.child) return;
    this.lastExit = { code, signal };
    this.child = null;
    this.provider = null;
    if (!this.closing && this.state !== "failed") this.state = "stopped";
    if (!this.closing && !this.lastError && code !== 0) {
      const detail = this.stderr.toString("utf8").trim();
      this.lastError = detail ? `Tool Provider exited with code ${String(code)}: ${detail}` : `Tool Provider exited with code ${String(code)}`;
    }
    this.rejectPending(new ToolProviderRpcTransportError(this.lastError ?? "Tool Provider process exited"));
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private async stopChild(): Promise<void> {
    const child = this.child;
    if (!child) {
      this.state = "stopped";
      return;
    }
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill();
    await exited;
    this.child = null;
    this.provider = null;
    this.state = "stopped";
  }
}

export class RpcExecutionToolDiscoverySource implements ExecutionToolDiscoverySource {
  constructor(readonly source: string, private readonly client: ToolProviderRpcClient) {
    if (!source.trim()) throw new Error("RPC Tool Provider source is required");
  }

  async discover(): Promise<ExecutionToolAdapter[]> {
    const tools = await this.client.listTools();
    return tools.map((tool) => {
      if (tool.source !== this.source) throw new Error(`RPC Tool Provider returned tool ${tool.name} for unexpected source ${tool.source}`);
      return { ...tool, execute: (input, context) => this.client.callTool(tool.name, input, context) };
    });
  }

  close(): Promise<void> { return this.client.close(); }
  restart(): Promise<void> { return this.client.restart(); }
  status(): ToolProviderProcessStatus { return this.client.status(); }
  diagnostics(): Record<string, unknown> { return { process: this.client.status() }; }
}

export class LengthPrefixedJsonDecoder {
  private buffered = Buffer.alloc(0);
  constructor(private readonly maximumFrameBytes: number) {}

  push(chunk: Buffer): unknown[] {
    this.buffered = this.buffered.length ? Buffer.concat([this.buffered, chunk]) : Buffer.from(chunk);
    const values: unknown[] = [];
    while (this.buffered.length >= 4) {
      const length = this.buffered.readUInt32BE(0);
      if (length < 1 || length > this.maximumFrameBytes) throw new Error(`Tool Provider frame length ${length} is invalid`);
      if (this.buffered.length < length + 4) break;
      const payload = this.buffered.subarray(4, length + 4);
      this.buffered = this.buffered.subarray(length + 4);
      values.push(JSON.parse(payload.toString("utf8")));
    }
    if (this.buffered.length > this.maximumFrameBytes + 4) throw new Error("Tool Provider partial frame exceeds the configured limit");
    return values;
  }
}

export function encodeLengthPrefixedJson(value: unknown, maximumFrameBytes: number): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.length < 1 || payload.length > maximumFrameBytes) throw new Error(`Tool Provider payload exceeds the ${maximumFrameBytes}-byte frame limit`);
  const frame = Buffer.allocUnsafe(payload.length + 4);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

export function validateToolProviderHandshake(value: unknown): ToolProviderHandshake {
  if (!isRecord(value) || typeof value.providerId !== "string" || !value.providerId.trim()
    || typeof value.providerVersion !== "string" || !value.providerVersion.trim()
    || value.protocolVersion !== TOOL_PROVIDER_RPC_VERSION) throw new Error("Tool Provider handshake is incompatible");
  return value as unknown as ToolProviderHandshake;
}

export function validateToolProviderSpec(value: unknown): ExecutionToolSpec {
  if (!isRecord(value) || typeof value.name !== "string" || typeof value.source !== "string" || typeof value.version !== "string"
    || typeof value.priority !== "number" || typeof value.description !== "string" || !isRecord(value.inputSchema)
    || !stringArray(value.providedCapabilities) || !stringArray(value.dependencyCapabilities) || !isRecord(value.permissionRequirements)
    || !["read_only", "bounded_write", "privileged", "destructive"].includes(String(value.risk))
    || !Number.isInteger(value.timeoutMs) || Number(value.timeoutMs) < 1) throw new Error("Tool Provider returned an invalid tool specification");
  return value as unknown as ExecutionToolSpec;
}

export function validateToolProviderResult(value: unknown): ToolExecutionResult {
  if (!isRecord(value) || !["succeeded", "failed", "approval_required"].includes(String(value.status))
    || typeof value.summary !== "string" || typeof value.raw !== "string" || !stringArray(value.refs)
    || typeof value.retryable !== "boolean") throw new Error("Tool Provider returned an invalid tool result");
  return value as unknown as ToolExecutionResult;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`Tool Provider ${label} must be a positive integer`);
  return value;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string" && Boolean(entry.trim()));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
