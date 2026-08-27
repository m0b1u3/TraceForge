import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection, createServer, type AddressInfo, type Server, type Socket } from "node:net";
import type {
  AdoptProcessRequest,
  AdoptProcessResponse,
  BrokeredHttpRequest,
  BrokeredHttpResponse,
  CanonicalizePathRequest,
  ExecutionHandshakeRequest,
  ExecutionHandshakeResponse,
  ExecutionNode,
  ListDirectoryRequest,
  ListDirectoryResponse,
  ProcessAccess,
  ProcessDescriptor,
  ReadFileChunkRequest,
  ReadFileChunkResponse,
  ReadProcessEventsRequest,
  ReadProcessEventsResponse,
  ResizeProcessTerminalRequest,
  SignalProcessRequest,
  StartProcessRequest,
  StartProcessResponse,
  StatPathRequest,
  StatPathResponse,
  TerminateProcessRequest,
  WriteFileChunkRequest,
  WriteFileChunkResponse,
  WriteProcessInputRequest,
} from "./protocol.js";

export const EXECUTION_RPC_WIRE_VERSION = 2 as const;

export type ExecutionRpcMethod =
  | "node.handshake"
  | "process.start"
  | "process.describe"
  | "process.readEvents"
  | "process.waitEvents"
  | "process.writeInput"
  | "process.resizeTerminal"
  | "process.signal"
  | "process.terminate"
  | "process.adopt"
  | "filesystem.canonicalize"
  | "filesystem.readChunk"
  | "filesystem.writeChunk"
  | "filesystem.list"
  | "filesystem.stat"
  | "network.httpRequest";

export interface ExecutionRpcRequest {
  version: typeof EXECUTION_RPC_WIRE_VERSION;
  id: string;
  authToken: string;
  method: ExecutionRpcMethod;
  params: unknown;
}

export type ExecutionRpcResponse =
  | { version: typeof EXECUTION_RPC_WIRE_VERSION; id: string; ok: true; result: unknown }
  | {
      version: typeof EXECUTION_RPC_WIRE_VERSION;
      id: string;
      ok: false;
      error: { code: string; message: string; retryable: boolean };
    };

export type ExecutionRpcAddress =
  | { kind: "pipe"; path: string }
  | { kind: "tcp"; host: "127.0.0.1" | "::1"; port: number };

export class ExecutionRpcRemoteError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ExecutionRpcRemoteError";
  }
}

export class ExecutionRpcTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionRpcTransportError";
  }
}

export class ExecutionFrameDecoder {
  private buffered = Buffer.alloc(0);

  constructor(readonly maximumFrameBytes: number) {
    if (!Number.isInteger(maximumFrameBytes) || maximumFrameBytes < 256) throw new Error("Execution RPC frame limit must be at least 256 bytes");
  }

  push(chunk: Buffer): Buffer[] {
    if (!chunk.length) return [];
    this.buffered = this.buffered.length ? Buffer.concat([this.buffered, chunk]) : Buffer.from(chunk);
    const frames: Buffer[] = [];
    while (this.buffered.length >= 4) {
      const length = this.buffered.readUInt32BE(0);
      if (length < 1 || length > this.maximumFrameBytes) throw new Error(`Execution RPC frame length ${length} is invalid`);
      if (this.buffered.length < length + 4) {
        if (this.buffered.length > this.maximumFrameBytes + 4) throw new Error("Execution RPC partial frame exceeds the configured limit");
        break;
      }
      frames.push(this.buffered.subarray(4, length + 4));
      this.buffered = this.buffered.subarray(length + 4);
    }
    return frames;
  }
}

export function encodeExecutionFrame(value: unknown, maximumFrameBytes: number): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.length < 1 || payload.length > maximumFrameBytes) throw new Error(`Execution RPC payload exceeds the ${maximumFrameBytes}-byte frame limit`);
  const frame = Buffer.allocUnsafe(payload.length + 4);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

export function createExecutionRpcAuthToken(): string {
  return randomBytes(32).toString("base64url");
}

export function defaultExecutionRpcPipe(nodeId: string, runtimeDirectory = tmpdir()): ExecutionRpcAddress {
  const safe = nodeId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80) || "node";
  if (process.platform === "win32") return { kind: "pipe", path: `\\\\.\\pipe\\traceforge-execution-${safe}` };
  // Darwin limits AF_UNIX paths to roughly 104 bytes. User-local runtime
  // directories are often already long, so bind the identity through a hash
  // instead of embedding an unbounded node id in the socket filename.
  const identity = createHash("sha256").update(nodeId).digest("hex").slice(0, 16);
  const path = join(runtimeDirectory, `tf-exec-${identity}.sock`);
  if (Buffer.byteLength(path) > 100) throw new Error("Execution RPC runtime directory is too long for a local socket");
  return { kind: "pipe", path };
}

export class ExecutionRpcDispatcher {
  constructor(private readonly node: ExecutionNode) {}

  async dispatch(method: ExecutionRpcMethod, params: unknown): Promise<unknown> {
    switch (method) {
      case "node.handshake": return this.node.handshake(params as ExecutionHandshakeRequest);
      case "process.start": return this.node.startProcess(params as StartProcessRequest);
      case "process.describe": return this.node.describeProcess(params as ProcessAccess);
      case "process.readEvents": return this.node.readProcessEvents(params as ReadProcessEventsRequest);
      case "process.waitEvents": {
        const value = params as { request: ReadProcessEventsRequest; timeoutMs: number };
        return this.node.waitProcessEvents(value.request, value.timeoutMs);
      }
      case "process.writeInput": return this.node.writeProcessInput(params as WriteProcessInputRequest);
      case "process.resizeTerminal": return this.node.resizeProcessTerminal(params as ResizeProcessTerminalRequest);
      case "process.signal": return this.node.signalProcess(params as SignalProcessRequest);
      case "process.terminate": return this.node.terminateProcess(params as TerminateProcessRequest);
      case "process.adopt": return this.node.adoptProcess(params as AdoptProcessRequest);
      case "filesystem.canonicalize": return this.node.canonicalizePath(params as CanonicalizePathRequest);
      case "filesystem.readChunk": return this.node.readFileChunk(params as ReadFileChunkRequest);
      case "filesystem.writeChunk": return this.node.writeFileChunk(params as WriteFileChunkRequest);
      case "filesystem.list": return this.node.listDirectory(params as ListDirectoryRequest);
      case "filesystem.stat": return this.node.statPath(params as StatPathRequest);
      case "network.httpRequest": return this.node.requestHttp(params as BrokeredHttpRequest);
      default: throw new Error(`Unknown Execution RPC method ${String(method)}`);
    }
  }
}

export interface ExecutionNodeRpcServerOptions {
  authToken: string;
  maximumFrameBytes?: number;
  maximumInFlightRequestsPerConnection?: number;
}

export class ExecutionNodeRpcServer {
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private readonly token: Buffer;
  private readonly maximumFrameBytes: number;
  private readonly maximumInFlight: number;
  private listeningAddress: ExecutionRpcAddress | null = null;

  constructor(private readonly dispatcher: ExecutionRpcDispatcher, options: ExecutionNodeRpcServerOptions) {
    if (options.authToken.length < 32) throw new Error("Execution RPC authentication token must contain at least 32 characters");
    this.token = Buffer.from(options.authToken);
    this.maximumFrameBytes = options.maximumFrameBytes ?? 8 * 1024 * 1024;
    this.maximumInFlight = options.maximumInFlightRequestsPerConnection ?? 64;
    if (this.maximumInFlight < 1) throw new Error("Execution RPC in-flight request limit must be positive");
    this.server = createServer((socket) => this.accept(socket));
  }

  async listen(address: ExecutionRpcAddress): Promise<ExecutionRpcAddress> {
    if (this.listeningAddress) throw new Error("Execution RPC server is already listening");
    if (address.kind === "tcp" && address.host !== "127.0.0.1" && address.host !== "::1") throw new Error("Execution RPC TCP transport is restricted to loopback");
    await new Promise<void>((resolvePromise, reject) => {
      const onError = (error: Error) => { this.server.off("listening", onListening); reject(error); };
      const onListening = () => { this.server.off("error", onError); resolvePromise(); };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      if (address.kind === "pipe") this.server.listen(address.path);
      else this.server.listen(address.port, address.host);
    });
    if (address.kind === "pipe") {
      this.listeningAddress = address;
      if (process.platform !== "win32") await chmod(address.path, 0o600);
    } else {
      const resolved = this.server.address() as AddressInfo;
      this.listeningAddress = { kind: "tcp", host: address.host, port: resolved.port };
    }
    return this.listeningAddress;
  }

  async close(): Promise<void> {
    if (!this.listeningAddress) return;
    const address = this.listeningAddress;
    this.listeningAddress = null;
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolvePromise, reject) => this.server.close((error) => error ? reject(error) : resolvePromise()));
    if (address.kind === "pipe" && process.platform !== "win32") await unlink(address.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket);
    const decoder = new ExecutionFrameDecoder(this.maximumFrameBytes);
    let inFlight = 0;
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", () => undefined);
    socket.on("data", (chunk) => {
      let frames: Buffer[];
      try {
        frames = decoder.push(chunk);
      } catch {
        socket.destroy();
        return;
      }
      for (const frame of frames) {
        if (inFlight >= this.maximumInFlight) {
          socket.destroy();
          return;
        }
        inFlight += 1;
        void this.handleFrame(socket, frame).finally(() => { inFlight -= 1; });
      }
    });
  }

  private async handleFrame(socket: Socket, frame: Buffer): Promise<void> {
    let request: ExecutionRpcRequest;
    try {
      request = JSON.parse(frame.toString("utf8")) as ExecutionRpcRequest;
    } catch {
      socket.destroy();
      return;
    }
    if (request.version !== EXECUTION_RPC_WIRE_VERSION || typeof request.id !== "string" || !request.id || request.id.length > 128) {
      socket.destroy();
      return;
    }
    if (!this.authenticated(request.authToken)) {
      await this.write(socket, this.failure(request.id, "AUTHENTICATION_FAILED", "Execution RPC authentication failed", false)).catch(() => undefined);
      socket.destroy();
      return;
    }
    try {
      const result = await this.dispatcher.dispatch(request.method, request.params);
      await this.write(socket, { version: EXECUTION_RPC_WIRE_VERSION, id: request.id, ok: true, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Execution RPC request failed";
      await this.write(socket, this.failure(request.id, "REQUEST_REJECTED", message, false)).catch(() => socket.destroy());
    }
  }

  private authenticated(value: unknown): boolean {
    if (typeof value !== "string") return false;
    const candidate = Buffer.from(value);
    return candidate.length === this.token.length && timingSafeEqual(candidate, this.token);
  }

  private failure(id: string, code: string, message: string, retryable: boolean): ExecutionRpcResponse {
    return { version: EXECUTION_RPC_WIRE_VERSION, id, ok: false, error: { code, message, retryable } };
  }

  private async write(socket: Socket, response: ExecutionRpcResponse): Promise<void> {
    const frame = encodeExecutionFrame(response, this.maximumFrameBytes);
    if (socket.destroyed) throw new ExecutionRpcTransportError("Execution RPC connection is closed");
    if (socket.write(frame)) return;
    await new Promise<void>((resolvePromise, reject) => {
      socket.once("drain", resolvePromise);
      socket.once("error", reject);
    });
  }
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export interface ExecutionNodeRpcClientOptions {
  authToken: string;
  maximumFrameBytes?: number;
  connectTimeoutMs?: number;
}

export class ExecutionNodeRpcClient implements ExecutionNode {
  private socket: Socket | null = null;
  private connecting: Promise<Socket> | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly maximumFrameBytes: number;
  private readonly connectTimeoutMs: number;

  constructor(private readonly address: ExecutionRpcAddress, private readonly options: ExecutionNodeRpcClientOptions) {
    if (options.authToken.length < 32) throw new Error("Execution RPC authentication token must contain at least 32 characters");
    this.maximumFrameBytes = options.maximumFrameBytes ?? 8 * 1024 * 1024;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 5_000;
  }

  handshake(request: ExecutionHandshakeRequest): Promise<ExecutionHandshakeResponse> { return this.call("node.handshake", request); }
  startProcess(request: StartProcessRequest): Promise<StartProcessResponse> { return this.call("process.start", request); }
  describeProcess(access: ProcessAccess): Promise<ProcessDescriptor> { return this.call("process.describe", access); }
  readProcessEvents(request: ReadProcessEventsRequest): Promise<ReadProcessEventsResponse> { return this.call("process.readEvents", request); }
  waitProcessEvents(request: ReadProcessEventsRequest, timeoutMs: number): Promise<ReadProcessEventsResponse> {
    return this.call("process.waitEvents", { request, timeoutMs });
  }
  writeProcessInput(request: WriteProcessInputRequest): Promise<ProcessDescriptor> { return this.call("process.writeInput", request); }
  resizeProcessTerminal(request: ResizeProcessTerminalRequest): Promise<ProcessDescriptor> { return this.call("process.resizeTerminal", request); }
  signalProcess(request: SignalProcessRequest): Promise<ProcessDescriptor> { return this.call("process.signal", request); }
  terminateProcess(request: TerminateProcessRequest): Promise<ProcessDescriptor> { return this.call("process.terminate", request); }
  adoptProcess(request: AdoptProcessRequest): Promise<AdoptProcessResponse> { return this.call("process.adopt", request); }
  canonicalizePath(request: CanonicalizePathRequest): Promise<string> { return this.call("filesystem.canonicalize", request); }
  readFileChunk(request: ReadFileChunkRequest): Promise<ReadFileChunkResponse> { return this.call("filesystem.readChunk", request); }
  writeFileChunk(request: WriteFileChunkRequest): Promise<WriteFileChunkResponse> { return this.call("filesystem.writeChunk", request); }
  listDirectory(request: ListDirectoryRequest): Promise<ListDirectoryResponse> { return this.call("filesystem.list", request); }
  statPath(request: StatPathRequest): Promise<StatPathResponse> { return this.call("filesystem.stat", request); }
  requestHttp(request: BrokeredHttpRequest): Promise<BrokeredHttpResponse> { return this.call("network.httpRequest", request); }

  disconnect(): void {
    const socket = this.socket;
    this.socket = null;
    this.connecting = null;
    if (socket) socket.destroy();
    this.rejectPending(new ExecutionRpcTransportError("Execution RPC client disconnected"));
  }

  private async call<T>(method: ExecutionRpcMethod, params: unknown): Promise<T> {
    const socket = await this.connection();
    const id = randomUUID();
    const request: ExecutionRpcRequest = {
      version: EXECUTION_RPC_WIRE_VERSION,
      id,
      authToken: this.options.authToken,
      method,
      params,
    };
    const result = new Promise<T>((resolvePromise, reject) => {
      this.pending.set(id, { resolve: (value) => resolvePromise(value as T), reject });
    });
    try {
      const frame = encodeExecutionFrame(request, this.maximumFrameBytes);
      if (!socket.write(frame)) await new Promise<void>((resolvePromise, reject) => {
        socket.once("drain", resolvePromise);
        socket.once("error", reject);
      });
    } catch (error) {
      this.pending.delete(id);
      throw error;
    }
    return result;
  }

  private async connection(): Promise<Socket> {
    if (this.socket && !this.socket.destroyed) return this.socket;
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<Socket>((resolvePromise, reject) => {
      const socket = this.address.kind === "pipe"
        ? createConnection(this.address.path)
        : createConnection({ host: this.address.host, port: this.address.port });
      const decoder = new ExecutionFrameDecoder(this.maximumFrameBytes);
      const timer = setTimeout(() => socket.destroy(new ExecutionRpcTransportError("Execution RPC connection timed out")), this.connectTimeoutMs);
      const fail = (error: Error) => {
        clearTimeout(timer);
        if (this.socket === socket) this.socket = null;
        this.connecting = null;
        this.rejectPending(error instanceof ExecutionRpcTransportError ? error : new ExecutionRpcTransportError(error.message));
        reject(error);
      };
      socket.once("connect", () => {
        clearTimeout(timer);
        this.socket = socket;
        this.connecting = null;
        resolvePromise(socket);
      });
      socket.on("data", (chunk) => {
        try {
          for (const frame of decoder.push(chunk)) this.receive(frame);
        } catch (error) {
          socket.destroy(error as Error);
        }
      });
      socket.once("error", fail);
      socket.once("close", () => {
        if (this.socket === socket) this.socket = null;
        this.connecting = null;
        this.rejectPending(new ExecutionRpcTransportError("Execution RPC connection closed"));
      });
    });
    return this.connecting;
  }

  private receive(frame: Buffer): void {
    let response: ExecutionRpcResponse;
    try {
      response = JSON.parse(frame.toString("utf8")) as ExecutionRpcResponse;
    } catch {
      throw new ExecutionRpcTransportError("Execution RPC returned malformed JSON");
    }
    if (response.version !== EXECUTION_RPC_WIRE_VERSION || typeof response.id !== "string") {
      throw new ExecutionRpcTransportError("Execution RPC returned an invalid envelope");
    }
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    if (response.ok) pending.resolve(response.result);
    else pending.reject(new ExecutionRpcRemoteError(response.error.code, response.error.message, response.error.retryable));
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
