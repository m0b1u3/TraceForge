import { randomUUID } from "node:crypto";
import type {
  ExecutionNode,
  ProcessAccess,
  ProcessDescriptor,
  ProcessEvent,
} from "@traceforge/execution-node";
import type {
  BrowserControllerConnection,
  BrowserControllerIdentity,
  BrowserControllerPort,
  BrowserControllerProof,
  BrowserResponseDirective,
  InterceptedBrowserRequest,
} from "./index.js";
import type {
  BrowserControlAction,
  BrowserControlResult,
  BrowserObservationPayload,
  BrowserObservationRequest,
  BrowserTakeoverState,
} from "./chromium-page-runtime.js";

export const BROWSER_CONTROLLER_PROTOCOL = "traceforge.browser-controller.v1" as const;

interface ReadyFrame {
  protocol: typeof BROWSER_CONTROLLER_PROTOCOL;
  type: "ready";
  proof: BrowserControllerProof;
}

interface RequestFrame {
  protocol: typeof BROWSER_CONTROLLER_PROTOCOL;
  type: "request";
  id: string;
  request: InterceptedBrowserRequest;
}

interface ResponseFrame {
  protocol: typeof BROWSER_CONTROLLER_PROTOCOL;
  type: "response";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

interface CommandFrame {
  protocol: typeof BROWSER_CONTROLLER_PROTOCOL;
  type: "command";
  id: string;
  command: "activate" | "shutdown" | "observe" | "act" | "manual_observe" | "manual_act"
    | "begin_takeover" | "resume_takeover";
  input: Record<string, unknown>;
}

interface RequestResultFrame {
  protocol: typeof BROWSER_CONTROLLER_PROTOCOL;
  type: "request_result";
  id: string;
  ok: boolean;
  directive?: BrowserResponseDirective;
  error?: { code: "request_denied"; message: string };
}

type IncomingFrame = ReadyFrame | RequestFrame | ResponseFrame;

export interface ExecutionNodeBrowserControllerOptions {
  executionNode: ExecutionNode;
  maximumFrameBytes?: number;
  maximumBufferedBytes?: number;
  maximumStderrBytes?: number;
  maximumPendingRequests?: number;
  handshakeTimeoutMs?: number;
  commandTimeoutMs?: number;
  waitIntervalMs?: number;
  createId?: () => string;
}

export class ExecutionNodeBrowserController implements BrowserControllerPort {
  private readonly limits: Required<Omit<ExecutionNodeBrowserControllerOptions, "executionNode" | "createId">>;
  private readonly createId: () => string;

  constructor(private readonly options: ExecutionNodeBrowserControllerOptions) {
    this.createId = options.createId ?? randomUUID;
    this.limits = {
      maximumFrameBytes: options.maximumFrameBytes ?? 4 * 1024 * 1024,
      maximumBufferedBytes: options.maximumBufferedBytes ?? 8 * 1024 * 1024,
      maximumStderrBytes: options.maximumStderrBytes ?? 64 * 1024,
      maximumPendingRequests: options.maximumPendingRequests ?? 32,
      handshakeTimeoutMs: options.handshakeTimeoutMs ?? 10_000,
      commandTimeoutMs: options.commandTimeoutMs ?? 30_000,
      waitIntervalMs: options.waitIntervalMs ?? 500,
    };
    if (Object.values(this.limits).some((value) => !Number.isSafeInteger(value) || value < 1)
      || this.limits.maximumBufferedBytes < this.limits.maximumFrameBytes) {
      throw new Error("Execution Node Browser Controller limits are invalid");
    }
  }

  async attach(input: {
    sessionId: string;
    process: ProcessDescriptor;
    access: ProcessAccess;
    expectedIdentity: BrowserControllerIdentity;
  }): Promise<BrowserControllerConnection> {
    if (!input.sessionId.trim() || !input.access.adoptionToken.trim()
      || input.process.id !== input.access.processId || input.process.state !== "running" || input.process.terminal) {
      throw new Error("Browser Controller requires the running non-terminal process it was issued");
    }
    const connection = new ExecutionNodeBrowserConnection(
      this.options.executionNode,
      input.sessionId,
      structuredClone(input.access),
      structuredClone(input.process),
      structuredClone(input.expectedIdentity),
      this.limits,
      this.createId,
    );
    await connection.initialize();
    return connection;
  }
}

interface PendingCommand {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

class ExecutionNodeBrowserConnection implements BrowserControllerConnection {
  proof!: BrowserControllerProof;
  private readonly decoder: LengthPrefixedJsonDecoder;
  private readonly pending = new Map<string, PendingCommand>();
  private readonly requestFrames = new Map<string, string>();
  private cursor = 0;
  private stderr = Buffer.alloc(0);
  private omittedStderrBytes = 0;
  private intercept: ((request: InterceptedBrowserRequest) => Promise<BrowserResponseDirective>) | undefined;
  private onFailure: ((error: Error) => void) | undefined;
  private readyResolve!: (proof: BrowserControllerProof) => void;
  private readyReject!: (error: Error) => void;
  private readonly ready: Promise<BrowserControllerProof>;
  private epoch = 0;
  private active = false;
  private closing = false;
  private failed = false;
  private readyReceived = false;

  constructor(
    private readonly node: ExecutionNode,
    private readonly sessionId: string,
    private readonly access: ProcessAccess,
    private descriptor: ProcessDescriptor,
    private readonly expectedIdentity: BrowserControllerIdentity,
    private readonly limits: Required<Omit<ExecutionNodeBrowserControllerOptions, "executionNode" | "createId">>,
    private readonly createId: () => string,
  ) {
    this.decoder = new LengthPrefixedJsonDecoder(limits.maximumFrameBytes, limits.maximumBufferedBytes);
    this.ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
  }

  async initialize(): Promise<void> {
    const epoch = ++this.epoch;
    void this.pump(epoch);
    const timeout = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error("Browser Controller handshake timed out")), this.limits.handshakeTimeoutMs);
      void this.ready.then(() => clearTimeout(timer), () => clearTimeout(timer));
    });
    this.proof = await Promise.race([this.ready, timeout]);
    if (canonicalJson(this.proof.identity) !== canonicalJson(this.expectedIdentity)) {
      this.transportFailed(new Error("Browser Controller measured identity does not match the reviewed launch identity"));
      throw new Error("Browser Controller measured identity does not match the reviewed launch identity");
    }
  }

  async start(
    intercept: (request: InterceptedBrowserRequest) => Promise<BrowserResponseDirective>,
    onFailure: (error: Error) => void,
  ): Promise<void> {
    if (this.failed || this.closing) throw new Error("Browser Controller connection is unavailable");
    if (this.active) throw new Error("Browser Controller connection is already active");
    this.intercept = intercept;
    this.onFailure = onFailure;
    this.active = true;
    try {
      const result = await this.sendCommand("activate", {});
      if (!isRecord(result) || result.active !== true) throw new Error("Browser Controller did not confirm activation");
    } catch (error) {
      this.active = false;
      throw error;
    }
  }

  observe(request: BrowserObservationRequest): Promise<BrowserObservationPayload> {
    return this.sendCommand("observe", request as unknown as Record<string, unknown>) as Promise<BrowserObservationPayload>;
  }

  act(action: BrowserControlAction): Promise<BrowserControlResult> {
    return this.sendCommand("act", action as unknown as Record<string, unknown>) as Promise<BrowserControlResult>;
  }

  observeManual(takeoverId: string, request: BrowserObservationRequest): Promise<BrowserObservationPayload> {
    return this.sendCommand("manual_observe", { takeoverId, request }) as Promise<BrowserObservationPayload>;
  }

  actManual(takeoverId: string, action: BrowserControlAction): Promise<BrowserControlResult> {
    return this.sendCommand("manual_act", { takeoverId, action }) as Promise<BrowserControlResult>;
  }

  beginTakeover(): Promise<BrowserTakeoverState> {
    return this.sendCommand("begin_takeover", {}) as Promise<BrowserTakeoverState>;
  }

  resumeTakeover(takeoverId: string): Promise<BrowserTakeoverState> {
    return this.sendCommand("resume_takeover", { takeoverId }) as Promise<BrowserTakeoverState>;
  }

  async close(_reason: string): Promise<void> {
    if (this.closing) return;
    if (!this.failed) {
      await this.sendCommand("shutdown", {}).catch(() => undefined);
    }
    this.closing = true;
    this.active = false;
    this.epoch += 1;
    this.rejectPending(new Error("Browser Controller connection closed"));
  }

  private sendCommand(command: CommandFrame["command"], input: Record<string, unknown>): Promise<unknown> {
    if (this.failed || this.closing) return Promise.reject(new Error("Browser Controller connection is unavailable"));
    if (this.pending.size >= this.limits.maximumPendingRequests) {
      return Promise.reject(new Error("Browser Controller command capacity is exhausted"));
    }
    const id = `browser-command:${this.sessionId}:${this.createId()}`;
    const frame: CommandFrame = { protocol: BROWSER_CONTROLLER_PROTOCOL, type: "command", id, command, input: structuredClone(input) };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`Browser Controller command ${command} timed out`);
        reject(error);
        this.transportFailed(error);
      }, this.limits.commandTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      void this.write(id, frame).catch((error) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        const failure = error instanceof Error ? error : new Error("Browser Controller command write failed");
        pending.reject(failure);
        this.transportFailed(failure);
      });
    });
  }

  private async pump(epoch: number): Promise<void> {
    while (!this.closing && !this.failed && epoch === this.epoch) {
      try {
        const batch = await this.node.waitProcessEvents({ ...this.access, afterSequence: this.cursor, maximumEvents: 256 }, this.limits.waitIntervalMs);
        if (epoch !== this.epoch) return;
        this.descriptor = batch.process;
        this.cursor = batch.nextSequence;
        if (batch.lostEvents) throw new Error("Browser Controller event stream lost protocol bytes");
        for (const event of batch.events) this.onEvent(event);
        if (batch.process.state === "exited" || batch.process.state === "failed") {
          throw new Error(`Browser Controller process ${batch.process.state}${this.stderrDetail()}`);
        }
      } catch (error) {
        if (this.closing || epoch !== this.epoch) return;
        this.transportFailed(error instanceof Error ? error : new Error("Browser Controller event stream failed"));
        return;
      }
    }
  }

  private onEvent(event: ProcessEvent): void {
    if (event.type === "process.output" && event.stream === "stdout") {
      const data = Buffer.from(event.dataBase64, "base64");
      if (data.toString("base64") !== event.dataBase64 || data.length !== event.bytes) {
        throw new Error("Browser Controller emitted invalid encoded protocol output");
      }
      for (const value of this.decoder.push(data)) this.onFrame(value);
      return;
    }
    if (event.type === "process.output" && event.stream === "stderr") {
      const data = Buffer.from(event.dataBase64, "base64");
      const combined = Buffer.concat([this.stderr, data]);
      this.omittedStderrBytes += Math.max(0, combined.length - this.limits.maximumStderrBytes);
      this.stderr = combined.subarray(-this.limits.maximumStderrBytes);
      return;
    }
    if (event.type === "process.output" && event.stream === "pty") throw new Error("Browser Controller emitted unexpected PTY output");
    if (event.type === "process.output_truncated") throw new Error("Browser Controller protocol output was truncated");
    if (event.type === "process.resource_limit_exceeded") throw new Error(`Browser Controller exceeded ${event.resource} quota`);
  }

  private onFrame(value: unknown): void {
    const frame = parseIncoming(value);
    if (frame.type === "ready") {
      if (this.readyReceived || canonicalJson(frame.proof.identity) !== canonicalJson(this.expectedIdentity)) {
        throw new Error("Browser Controller returned a duplicate ready frame or mismatched identity");
      }
      this.readyReceived = true;
      this.readyResolve(structuredClone(frame.proof));
      return;
    }
    if (frame.type === "response") {
      const pending = this.pending.get(frame.id);
      if (!pending) throw new Error("Browser Controller returned an unknown command response");
      clearTimeout(pending.timer);
      this.pending.delete(frame.id);
      if (frame.ok) pending.resolve(structuredClone(frame.result));
      else pending.reject(new Error(`Browser Controller command failed: ${frame.error?.code ?? "unknown"}`));
      return;
    }
    if (!this.active || !this.intercept) throw new Error("Browser Controller sent a request before activation");
    if (this.requestFrames.size >= this.limits.maximumPendingRequests) throw new Error("Browser Controller request capacity is exhausted");
    const fingerprint = canonicalJson(frame.request);
    const prior = this.requestFrames.get(frame.id);
    if (prior && prior !== fingerprint) throw new Error("Browser Controller reused a request frame id with different input");
    if (prior) return;
    this.requestFrames.set(frame.id, fingerprint);
    void this.intercept(structuredClone(frame.request))
      .then((directive) => this.writeRequestResult(frame.id, fingerprint, {
        protocol: BROWSER_CONTROLLER_PROTOCOL,
        type: "request_result",
        id: frame.id,
        ok: true,
        directive,
      } satisfies RequestResultFrame))
      .catch((error) => this.writeRequestResult(frame.id, fingerprint, {
        protocol: BROWSER_CONTROLLER_PROTOCOL,
        type: "request_result",
        id: frame.id,
        ok: false,
        error: { code: "request_denied", message: boundedMessage(error) },
      } satisfies RequestResultFrame))
      .catch((error) => this.transportFailed(error instanceof Error ? error : new Error("Browser Controller response write failed")))
      .finally(() => {
        if (this.requestFrames.get(frame.id) === fingerprint) this.requestFrames.delete(frame.id);
      });
  }

  private async writeRequestResult(id: string, fingerprint: string, value: RequestResultFrame): Promise<void> {
    if (!this.active || this.failed || this.closing || this.requestFrames.get(id) !== fingerprint) return;
    await this.write(id, value);
  }

  private write(id: string, value: unknown): Promise<ProcessDescriptor> {
    const data = encodeLengthPrefixedJson(value, this.limits.maximumFrameBytes);
    return this.node.writeProcessInput({ ...this.access, operationId: `browser-control:${this.sessionId}:${id}`,
      dataBase64: data.toString("base64") });
  }

  private transportFailed(error: Error): void {
    if (this.failed || this.closing) return;
    this.failed = true;
    this.active = false;
    this.readyReject(error);
    this.rejectPending(error);
    this.onFailure?.(error);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private stderrDetail(): string {
    const detail = this.stderr.toString("utf8").trim();
    if (!detail && !this.omittedStderrBytes) return "";
    return `: ${detail.slice(-4096)}${this.omittedStderrBytes ? ` (${this.omittedStderrBytes} earlier bytes omitted)` : ""}`;
  }
}

export class LengthPrefixedJsonDecoder {
  private buffer = Buffer.alloc(0);
  constructor(private readonly maximumFrameBytes: number, private readonly maximumBufferedBytes: number) {}

  push(chunk: Buffer): unknown[] {
    if (chunk.length + this.buffer.length > this.maximumBufferedBytes) throw new Error("Browser Controller protocol buffer limit exceeded");
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const values: unknown[] = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (length < 2 || length > this.maximumFrameBytes) throw new Error("Browser Controller frame length is invalid");
      if (this.buffer.length < length + 4) break;
      const body = this.buffer.subarray(4, length + 4);
      this.buffer = this.buffer.subarray(length + 4);
      try { values.push(JSON.parse(body.toString("utf8"))); }
      catch { throw new Error("Browser Controller frame is not valid JSON"); }
    }
    return values;
  }
}

export function encodeLengthPrefixedJson(value: unknown, maximumFrameBytes: number): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length < 2 || body.length > maximumFrameBytes) throw new Error("Browser Controller frame exceeds its limit");
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

function parseIncoming(value: unknown): IncomingFrame {
  if (!isRecord(value) || value.protocol !== BROWSER_CONTROLLER_PROTOCOL || typeof value.type !== "string") {
    throw new Error("Browser Controller returned an invalid protocol frame");
  }
  if (value.type === "ready" && isRecord(value.proof)) return value as unknown as ReadyFrame;
  if (value.type === "request" && typeof value.id === "string" && isRecord(value.request)) return value as unknown as RequestFrame;
  if (value.type === "response" && typeof value.id === "string" && typeof value.ok === "boolean") return value as unknown as ResponseFrame;
  throw new Error("Browser Controller returned an unsupported protocol frame");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Browser request was denied";
  return message.slice(0, 1024);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
