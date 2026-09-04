import { randomUUID } from "node:crypto";
import type { BrowserResponseDirective, InterceptedBrowserRequest } from "./index.js";
import { BROWSER_CONTROLLER_PROTOCOL, LengthPrefixedJsonDecoder, encodeLengthPrefixedJson } from "./execution-node-controller.js";
import type { ChromiumCdpAdapter } from "./chromium-cdp-adapter.js";
import type { BrowserControlAction, BrowserObservationRequest } from "./chromium-page-runtime.js";

export interface BrowserControllerProcessIo {
  onData(listener: (data: Buffer) => void): () => void;
  onFailure(listener: (error: Error) => void): () => void;
  write(data: Buffer): Promise<void> | void;
  close(exitCode: number): Promise<void> | void;
}

export interface BrowserControllerProcessRuntimeOptions {
  io: BrowserControllerProcessIo;
  adapter: ChromiumCdpAdapter;
  maximumFrameBytes?: number;
  maximumBufferedBytes?: number;
  maximumPendingRequests?: number;
  requestTimeoutMs?: number;
  createId?: () => string;
}

interface PendingRequest {
  resolve(value: BrowserResponseDirective): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class BrowserControllerProcessRuntime {
  private readonly decoder: LengthPrefixedJsonDecoder;
  private readonly maximumFrameBytes: number;
  private readonly maximumPendingRequests: number;
  private readonly requestTimeoutMs: number;
  private readonly createId: () => string;
  private readonly pending = new Map<string, PendingRequest>();
  private commandTail: Promise<void> = Promise.resolve();
  private pendingCommandCount = 0;
  private unsubscribeData: (() => void) | undefined;
  private unsubscribeFailure: (() => void) | undefined;
  private active = false;
  private closed = false;

  constructor(private readonly options: BrowserControllerProcessRuntimeOptions) {
    this.maximumFrameBytes = options.maximumFrameBytes ?? 4 * 1024 * 1024;
    const maximumBufferedBytes = options.maximumBufferedBytes ?? 8 * 1024 * 1024;
    this.maximumPendingRequests = options.maximumPendingRequests ?? 16;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.createId = options.createId ?? randomUUID;
    if (![this.maximumFrameBytes, maximumBufferedBytes, this.maximumPendingRequests, this.requestTimeoutMs]
      .every((value) => Number.isSafeInteger(value) && value > 0) || maximumBufferedBytes < this.maximumFrameBytes) {
      throw new Error("Browser Controller Process limits are invalid");
    }
    this.decoder = new LengthPrefixedJsonDecoder(this.maximumFrameBytes, maximumBufferedBytes);
  }

  async start(): Promise<void> {
    if (this.unsubscribeData) throw new Error("Browser Controller Process is already started");
    this.unsubscribeData = this.options.io.onData((data) => this.onData(data));
    this.unsubscribeFailure = this.options.io.onFailure((error) => { void this.fail(error); });
    try {
      await this.options.adapter.initialize();
      await this.write({ protocol: BROWSER_CONTROLLER_PROTOCOL, type: "ready", proof: this.options.adapter.proof });
    } catch (error) {
      await this.fail(asError(error));
      throw error;
    }
  }

  private onData(data: Buffer): void {
    if (this.closed) return;
    try {
      for (const frame of this.decoder.push(data)) void this.onFrame(frame).catch((error) => this.fail(asError(error)));
    } catch (error) {
      void this.fail(asError(error));
    }
  }

  private async onFrame(value: unknown): Promise<void> {
    const frame = record(value, "Host Browser Controller frame");
    if (frame.protocol !== BROWSER_CONTROLLER_PROTOCOL || typeof frame.type !== "string" || typeof frame.id !== "string") {
      throw new Error("Host Browser Controller frame is invalid");
    }
    if (frame.type === "command") return this.enqueueCommand(frame);
    if (frame.type === "request_result") return this.requestResult(frame);
    throw new Error("Host Browser Controller frame type is unsupported");
  }

  private async enqueueCommand(frame: Record<string, unknown>): Promise<void> {
    if (this.pendingCommandCount >= this.maximumPendingRequests) throw new Error("Browser Controller command capacity is exhausted");
    this.pendingCommandCount += 1;
    const execution = this.commandTail.then(() => this.command(frame));
    this.commandTail = execution.catch(() => undefined);
    try { await execution; } finally { this.pendingCommandCount -= 1; }
  }

  private async command(frame: Record<string, unknown>): Promise<void> {
    if (frame.command === "shutdown") {
      await this.options.adapter.close();
      await this.respond(frame.id as string, true, { closed: true });
      await this.shutdown(0);
      return;
    }
    try {
      if (frame.command === "activate") {
        if (this.active) throw new Error("Browser Controller Process is already active");
        this.options.adapter.activate((request) => this.requestHost(request), (error) => { void this.fail(error); });
        this.active = true;
        await this.respond(frame.id as string, true, { active: true });
        return;
      }
      if (!this.active) throw new Error("Browser Controller Process is not active");
      const input = record(frame.input, "Browser Controller command input");
      if (frame.command === "observe") {
        await this.respond(frame.id as string, true, await this.options.adapter.observe(input as unknown as BrowserObservationRequest));
        return;
      }
      if (frame.command === "act") {
        await this.respond(frame.id as string, true, await this.options.adapter.act(input as unknown as BrowserControlAction));
        return;
      }
      if (frame.command === "manual_observe") {
        if (typeof input.takeoverId !== "string") throw new Error("Browser takeover identity is invalid");
        await this.respond(frame.id as string, true, await this.options.adapter.observeManual(input.takeoverId,
          record(input.request, "Browser manual observation request") as unknown as BrowserObservationRequest));
        return;
      }
      if (frame.command === "manual_act") {
        if (typeof input.takeoverId !== "string") throw new Error("Browser takeover identity is invalid");
        await this.respond(frame.id as string, true, await this.options.adapter.actManual(input.takeoverId,
          record(input.action, "Browser manual action") as unknown as BrowserControlAction));
        return;
      }
      if (frame.command === "begin_takeover") {
        await this.respond(frame.id as string, true, await this.options.adapter.beginTakeover());
        return;
      }
      if (frame.command === "resume_takeover") {
        if (typeof input.takeoverId !== "string") throw new Error("Browser takeover identity is invalid");
        await this.respond(frame.id as string, true, await this.options.adapter.resumeTakeover(input.takeoverId));
        return;
      }
      throw new Error("Browser Controller Process command is unsupported");
    } catch (error) {
      await this.rejectCommand(frame.id as string, error);
    }
  }

  private requestResult(frame: Record<string, unknown>): void {
    const id = frame.id as string;
    const pending = this.pending.get(id);
    if (!pending) throw new Error("Host returned an unknown Browser request result");
    clearTimeout(pending.timer);
    this.pending.delete(id);
    if (frame.ok === true && frame.directive && typeof frame.directive === "object") {
      pending.resolve(structuredClone(frame.directive) as BrowserResponseDirective);
    } else if (frame.ok === false) {
      const error = record(frame.error, "Host Browser request error");
      pending.reject(new Error(typeof error.message === "string" ? error.message.slice(0, 1024) : "Host denied Browser request"));
    } else pending.reject(new Error("Host Browser request result is invalid"));
  }

  private requestHost(request: InterceptedBrowserRequest): Promise<BrowserResponseDirective> {
    if (!this.active || this.closed) return Promise.reject(new Error("Browser Controller Process is not active"));
    if (this.pending.size >= this.maximumPendingRequests) return Promise.reject(new Error("Browser Controller Process request capacity is exhausted"));
    const id = `browser-wire:${this.createId()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Host Browser request timed out"));
        void this.fail(new Error("Host Browser request timed out"));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      void this.write({ protocol: BROWSER_CONTROLLER_PROTOCOL, type: "request", id, request }).catch((error) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(asError(error));
        void this.fail(asError(error));
      });
    });
  }

  private respond(id: string, ok: boolean, result: unknown): Promise<void> {
    return this.write({ protocol: BROWSER_CONTROLLER_PROTOCOL, type: "response", id, ok, result });
  }

  private rejectCommand(id: string, error: unknown): Promise<void> {
    return this.write({ protocol: BROWSER_CONTROLLER_PROTOCOL, type: "response", id, ok: false,
      error: { code: "command_rejected", message: asError(error).message.slice(0, 1024) } });
  }

  private async write(value: unknown): Promise<void> {
    if (this.closed) throw new Error("Browser Controller Process is closed");
    await this.options.io.write(encodeLengthPrefixedJson(value, this.maximumFrameBytes));
  }

  private async fail(error: Error): Promise<void> {
    if (this.closed) return;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    await Promise.resolve(this.options.adapter.close()).catch(() => undefined);
    await this.shutdown(1);
  }

  private async shutdown(exitCode: number): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.active = false;
    this.unsubscribeData?.();
    this.unsubscribeFailure?.();
    await this.options.io.close(exitCode);
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
  return value as Record<string, unknown>;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
