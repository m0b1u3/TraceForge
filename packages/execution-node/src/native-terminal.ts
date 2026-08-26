import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ProcessEnforcementAttestation, ProcessOutputStream, ProcessSignal, ResourceLimitKind, StartProcessRequest } from "./protocol.js";
import type { LaunchedProcess, ManagedProcess, ProcessLauncher } from "./runtime.js";

const NATIVE_TERMINAL_MAX_FRAME_BYTES = 1024 * 1024;
const FRAME_INPUT = 0x01;
const FRAME_RESIZE = 0x02;
const FRAME_CLOSE_INPUT = 0x03;
const FRAME_TERMINATE = 0x04;
const FRAME_STARTED = 0x81;
const FRAME_OUTPUT = 0x82;
const FRAME_EXITED = 0x83;
const FRAME_ACK = 0x84;
const FRAME_RESOURCE_LIMIT = 0x85;
const FRAME_ERROR = 0xff;

interface NativeTerminalFrame {
  type: number;
  payload: Buffer;
}

export class NativeTerminalFrameDecoder {
  private buffered = Buffer.alloc(0);

  constructor(readonly maximumFrameBytes = NATIVE_TERMINAL_MAX_FRAME_BYTES) {
    if (!Number.isInteger(maximumFrameBytes) || maximumFrameBytes < 4) {
      throw new Error("Native terminal frame limit must be at least four bytes");
    }
  }

  push(chunk: Buffer): NativeTerminalFrame[] {
    if (!chunk.length) return [];
    this.buffered = this.buffered.length ? Buffer.concat([this.buffered, chunk]) : Buffer.from(chunk);
    const frames: NativeTerminalFrame[] = [];
    while (this.buffered.length >= 5) {
      const length = this.buffered.readUInt32BE(1);
      if (length > this.maximumFrameBytes) throw new Error(`Native terminal frame length ${length} exceeds the limit`);
      if (this.buffered.length < length + 5) break;
      frames.push({ type: this.buffered[0]!, payload: Buffer.from(this.buffered.subarray(5, length + 5)) });
      this.buffered = this.buffered.subarray(length + 5);
    }
    return frames;
  }
}

export function encodeNativeTerminalFrame(type: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  if (!Number.isInteger(type) || type < 0 || type > 0xff) throw new Error("Native terminal frame type is invalid");
  if (payload.length > NATIVE_TERMINAL_MAX_FRAME_BYTES) throw new Error("Native terminal frame exceeds the limit");
  const frame = Buffer.allocUnsafe(payload.length + 5);
  frame[0] = type;
  frame.writeUInt32BE(payload.length, 1);
  payload.copy(frame, 5);
  return frame;
}

export interface WindowsConptyLaunchSpec {
  helperExecutable: string;
  helperArgumentsPrefix?: string[];
  profileArguments?: string[];
  helperEnvironment: NodeJS.ProcessEnv;
  mode: "unelevated" | "appcontainer";
  enforcement: ProcessEnforcementAttestation;
}

export class WindowsConptyProcessLauncher implements ProcessLauncher {
  constructor(
    private readonly resolveLaunch: (request: StartProcessRequest) => Promise<WindowsConptyLaunchSpec> | WindowsConptyLaunchSpec,
  ) {}

  async launch(request: StartProcessRequest): Promise<LaunchedProcess> {
    if (!request.terminal) throw new Error("Windows ConPTY launcher requires a terminal request");
    if (request.permissions.network === "brokered") {
      throw new Error("Windows ConPTY helper does not implement brokered network transport");
    }
    const spec = await this.resolveLaunch(request);
    const args = [
      ...(spec.helperArgumentsPrefix ?? []),
      "pty-run",
      "--mode", spec.mode,
      "--network", request.permissions.network === "deny" ? "deny" : "allow",
      "--cwd", request.workingDirectory,
      "--columns", String(request.terminal.columns),
      "--rows", String(request.terminal.rows),
      ...(spec.profileArguments ?? []),
      request.executable,
      ...request.arguments,
    ];
    const helper = spawn(spec.helperExecutable, args, {
      cwd: request.workingDirectory,
      env: spec.helperEnvironment,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const process = await NativeTerminalManagedProcess.connect(helper);
    return { process, enforcement: structuredClone(spec.enforcement) };
  }
}

class NativeTerminalManagedProcess implements ManagedProcess {
  private processId = 0;
  private readonly outputListeners: Array<(stream: ProcessOutputStream, data: Buffer) => void> = [];
  private readonly exitListeners: Array<(exitCode: number | null, signal: string | null) => void> = [];
  private readonly errorListeners: Array<(error: Error) => void> = [];
  private readonly resourceLimitListeners: Array<(resource: ResourceLimitKind) => void> = [];
  private readonly pendingOutput: Buffer[] = [];
  private pendingExit: { exitCode: number | null; signal: string | null } | null = null;
  private pendingError: Error | null = null;
  private pendingResourceLimit: ResourceLimitKind | null = null;
  private helperStderr = "";
  private exited = false;
  private nextOperationId = 1;
  private readonly pendingOperations = new Map<number, { resolve(): void; reject(error: Error): void }>();

  private constructor(private readonly helper: ChildProcessWithoutNullStreams) {}

  static async connect(helper: ChildProcessWithoutNullStreams): Promise<NativeTerminalManagedProcess> {
    const managed = new NativeTerminalManagedProcess(helper);
    await managed.initialize();
    return managed;
  }

  get pid(): number {
    return this.processId;
  }

  onOutput(listener: (stream: ProcessOutputStream, data: Buffer) => void): void {
    this.outputListeners.push(listener);
    for (const data of this.pendingOutput.splice(0)) listener("pty", data);
  }

  onExit(listener: (exitCode: number | null, signal: string | null) => void): void {
    this.exitListeners.push(listener);
    if (this.pendingExit) listener(this.pendingExit.exitCode, this.pendingExit.signal);
  }

  onError(listener: (error: Error) => void): void {
    this.errorListeners.push(listener);
    if (this.pendingError) listener(this.pendingError);
  }

  onResourceLimit(listener: (resource: ResourceLimitKind) => void): void {
    this.resourceLimitListeners.push(listener);
    if (this.pendingResourceLimit) listener(this.pendingResourceLimit);
  }

  async writeInput(data: Buffer): Promise<void> {
    await this.writeFrame(FRAME_INPUT, Buffer.from(data));
  }

  closeInput(): Promise<void> {
    return this.writeFrame(FRAME_CLOSE_INPUT);
  }

  async resizeTerminal(columns: number, rows: number): Promise<void> {
    if (!Number.isInteger(columns) || columns < 1 || columns > 0xffff
      || !Number.isInteger(rows) || rows < 1 || rows > 0xffff) {
      throw new Error("Native terminal dimensions are invalid");
    }
    const payload = Buffer.allocUnsafe(4);
    payload.writeUInt16BE(columns, 0);
    payload.writeUInt16BE(rows, 2);
    await this.writeFrame(FRAME_RESIZE, payload);
  }

  async sendSignal(signal: ProcessSignal): Promise<void> {
    if (signal === "interrupt") {
      await this.writeInput(Buffer.from([0x03]));
      return;
    }
    if (signal === "terminate" || signal === "kill") {
      await this.terminate(signal === "kill");
      return;
    }
    throw new Error(`Native Windows terminal does not support signal ${signal}`);
  }

  async terminate(force: boolean): Promise<void> {
    await this.writeFrame(FRAME_TERMINATE, Buffer.from([force ? 1 : 0]));
  }

  private async initialize(): Promise<void> {
    const decoder = new NativeTerminalFrameDecoder();
    this.helper.stderr.setEncoding("utf8");
    this.helper.stderr.on("data", (value: string) => {
      this.helperStderr = `${this.helperStderr}${value}`.slice(-16_384);
    });
    this.helper.stdout.on("data", (chunk: Buffer) => {
      try {
        for (const frame of decoder.push(chunk)) this.receive(frame);
      } catch (error) {
        this.emitError(error as Error);
        this.helper.kill();
      }
    });
    this.helper.once("error", (error) => this.emitError(error));
    this.helper.once("close", (code, signal) => {
      if (!this.exited) {
        const detail = this.helperStderr.trim();
        this.emitError(new Error(detail || `Native terminal helper exited before terminal completion (${code ?? signal ?? "unknown"})`));
        this.emitExit(code, signal);
      }
    });
    await new Promise<void>((resolvePromise, reject) => {
      const started = () => {
        if (this.processId > 0) {
          cleanup();
          resolvePromise();
        }
      };
      const failed = (error: Error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        this.startListeners.delete(started);
        this.startErrorListeners.delete(failed);
      };
      this.startListeners.add(started);
      this.startErrorListeners.add(failed);
      if (this.pendingError) {
        failed(this.pendingError);
        return;
      }
      started();
    });
  }

  private readonly startListeners = new Set<() => void>();
  private readonly startErrorListeners = new Set<(error: Error) => void>();

  private receive(frame: NativeTerminalFrame): void {
    if (frame.type === FRAME_STARTED) {
      if (frame.payload.length !== 4) throw new Error("Native terminal returned an invalid process id frame");
      const pid = frame.payload.readUInt32BE(0);
      if (!pid || this.processId) throw new Error("Native terminal returned an invalid or duplicate process id");
      this.processId = pid;
      for (const listener of this.startListeners) listener();
      return;
    }
    if (frame.type === FRAME_OUTPUT) {
      if (this.outputListeners.length) {
        for (const listener of this.outputListeners) listener("pty", Buffer.from(frame.payload));
      } else {
        this.pendingOutput.push(Buffer.from(frame.payload));
      }
      return;
    }
    if (frame.type === FRAME_EXITED) {
      if (frame.payload.length !== 4) throw new Error("Native terminal returned an invalid exit frame");
      this.emitExit(frame.payload.readInt32BE(0), null);
      return;
    }
    if (frame.type === FRAME_ACK) {
      if (frame.payload.length < 5) throw new Error("Native terminal returned an invalid acknowledgment frame");
      const operationId = frame.payload.readUInt32BE(0);
      const pending = this.pendingOperations.get(operationId);
      if (!pending) throw new Error(`Native terminal acknowledged unknown operation ${operationId}`);
      this.pendingOperations.delete(operationId);
      if (frame.payload[4] === 0) pending.resolve();
      else pending.reject(new Error(frame.payload.subarray(5).toString("utf8") || "Native terminal operation failed"));
      return;
    }
    if (frame.type === FRAME_RESOURCE_LIMIT) {
      const resource = frame.payload.toString("utf8") as ResourceLimitKind;
      if (!["cpu_time", "memory", "process_count", "write_bytes"].includes(resource)) {
        throw new Error("Native terminal returned an invalid resource-limit frame");
      }
      this.pendingResourceLimit = resource;
      for (const listener of this.resourceLimitListeners) listener(resource);
      return;
    }
    if (frame.type === FRAME_ERROR) {
      this.emitError(new Error(frame.payload.toString("utf8") || "Native terminal helper reported an error"));
      return;
    }
    throw new Error(`Native terminal returned unknown frame type ${frame.type}`);
  }

  private async writeFrame(type: number, payload = Buffer.alloc(0)): Promise<void> {
    if (this.exited || this.helper.stdin.destroyed || !this.helper.stdin.writable) {
      throw new Error("Native terminal input is closed");
    }
    const operationId = this.nextOperationId;
    this.nextOperationId = this.nextOperationId === 0xffff_ffff ? 1 : this.nextOperationId + 1;
    const body = Buffer.allocUnsafe(payload.length + 4);
    body.writeUInt32BE(operationId, 0);
    payload.copy(body, 4);
    const frame = encodeNativeTerminalFrame(type, body);
    const acknowledged = new Promise<void>((resolvePromise, reject) => {
      this.pendingOperations.set(operationId, { resolve: resolvePromise, reject });
    });
    if (!this.helper.stdin.write(frame)) await new Promise<void>((resolvePromise, reject) => {
      const done = () => { cleanup(); resolvePromise(); };
      const failed = (error: Error) => { cleanup(); reject(error); };
      const cleanup = () => {
        this.helper.stdin.off("drain", done);
        this.helper.stdin.off("error", failed);
      };
      this.helper.stdin.once("drain", done);
      this.helper.stdin.once("error", failed);
    });
    return acknowledged;
  }

  private emitExit(exitCode: number | null, signal: string | null): void {
    if (this.exited) return;
    this.exited = true;
    this.rejectPendingOperations(new Error("Native terminal process exited"));
    this.pendingExit = { exitCode, signal };
    for (const listener of this.exitListeners) listener(exitCode, signal);
  }

  private emitError(error: Error): void {
    if (!this.processId) for (const listener of this.startErrorListeners) listener(error);
    this.pendingError = error;
    this.rejectPendingOperations(error);
    for (const listener of this.errorListeners) listener(error);
  }

  private rejectPendingOperations(error: Error): void {
    for (const pending of this.pendingOperations.values()) pending.reject(error);
    this.pendingOperations.clear();
  }
}
