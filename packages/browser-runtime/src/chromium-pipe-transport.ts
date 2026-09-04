import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type { BrowserControllerIdentity } from "./index.js";
import type { ChromiumCdpEvent, ChromiumCdpPort } from "./chromium-cdp-adapter.js";

export interface ChromiumPipeProcess {
  pid?: number;
  controlInput: Writable;
  controlOutput: Readable;
  stderr: Readable;
  once(event: "spawn", listener: () => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface ChromiumPipeLaunchSpec {
  executable: string;
  arguments: string[];
  workingDirectory: string;
  environment: Record<string, string>;
}

export type ChromiumPipeProcessLauncher = (spec: ChromiumPipeLaunchSpec) => ChromiumPipeProcess;

export interface ChromiumPipeTransportOptions {
  browserExecutable: string;
  browserArguments?: string[];
  workingDirectory: string;
  userDataDirectory: string;
  environment?: Record<string, string>;
  expectedIdentity: BrowserControllerIdentity;
  expectedExecutableSha256?: string;
  maximumMessageBytes?: number;
  maximumBufferedBytes?: number;
  maximumPendingCommands?: number;
  maximumStderrBytes?: number;
  startupTimeoutMs?: number;
  commandTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  launcher?: ChromiumPipeProcessLauncher;
  digestFile?: (path: string) => Promise<string>;
}

interface PendingCommand {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

const fixedArguments = [
  "--headless=new",
  "--remote-debugging-pipe",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-domain-reliability",
  "--disable-sync",
  "--metrics-recording-only",
  "--disable-features=ServiceWorker",
];
const forbiddenArgumentPrefixes = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--remote-debugging-port",
  "--proxy-server",
  "--proxy-pac-url",
  "--user-data-dir",
];
const allowedArgumentPrefixes = ["--window-size=", "--lang=", "--force-device-scale-factor="];
const forbiddenEnvironment = new Set(["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"]);
const allowedEnvironment = new Set(["LANG", "LC_ALL", "TZ", "SYSTEMROOT", "WINDIR", "TEMP", "TMP"]);

export class ChromiumPipeTransport implements ChromiumCdpPort {
  private readonly eventListeners = new Set<(event: ChromiumCdpEvent) => void>();
  private readonly failureListeners = new Set<(error: Error) => void>();
  private readonly pending = new Map<number, PendingCommand>();
  private buffer = Buffer.alloc(0);
  private stderrBytes = 0;
  private nextId = 0;
  private failed = false;
  private closing = false;
  private exited = false;

  private constructor(
    private readonly process: ChromiumPipeProcess,
    private readonly limits: {
      maximumMessageBytes: number;
      maximumBufferedBytes: number;
      maximumPendingCommands: number;
      maximumStderrBytes: number;
      commandTimeoutMs: number;
      shutdownTimeoutMs: number;
    },
  ) {
    process.controlOutput.on("data", (chunk: Buffer | string) => this.onData(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    process.controlOutput.on("error", (error) => this.fail(asError(error)));
    process.controlInput.on("error", (error) => this.fail(asError(error)));
    process.stderr.on("data", (chunk: Buffer | string) => this.onStderr(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    process.once("error", (error) => this.fail(error));
    process.once("exit", (code, signal) => {
      this.exited = true;
      if (!this.closing) this.fail(new Error(`Chromium pipe process exited with code ${String(code)} signal ${String(signal)}${this.stderrDetail()}`));
    });
  }

  static async launch(options: ChromiumPipeTransportOptions): Promise<ChromiumPipeTransport> {
    assertOptions(options);
    const limits = {
      maximumMessageBytes: options.maximumMessageBytes ?? 4 * 1024 * 1024,
      maximumBufferedBytes: options.maximumBufferedBytes ?? 8 * 1024 * 1024,
      maximumPendingCommands: options.maximumPendingCommands ?? 64,
      maximumStderrBytes: options.maximumStderrBytes ?? 64 * 1024,
      commandTimeoutMs: options.commandTimeoutMs ?? 30_000,
      shutdownTimeoutMs: options.shutdownTimeoutMs ?? 5_000,
    };
    const startupTimeoutMs = options.startupTimeoutMs ?? 10_000;
    if (![...Object.values(limits), startupTimeoutMs].every((value) => Number.isSafeInteger(value) && value > 0)
      || limits.maximumBufferedBytes < limits.maximumMessageBytes) throw new Error("Chromium pipe limits are invalid");
    const actualDigest = await (options.digestFile ?? sha256File)(options.browserExecutable);
    if (actualDigest !== (options.expectedExecutableSha256 ?? options.expectedIdentity.browserSha256)) {
      throw new Error("Chromium executable digest does not match reviewed Browser identity");
    }
    const spec: ChromiumPipeLaunchSpec = {
      executable: options.browserExecutable,
      arguments: [...fixedArguments, `--user-data-dir=${options.userDataDirectory}`, ...(options.browserArguments ?? [])],
      workingDirectory: options.workingDirectory,
      environment: { LANG: "C.UTF-8", ...(options.environment ?? {}) },
    };
    const child = (options.launcher ?? defaultLauncher)(spec);
    try { await waitForSpawn(child, startupTimeoutMs); }
    catch (error) { child.kill("SIGKILL"); throw error; }
    const transport = new ChromiumPipeTransport(child, limits);
    try {
      const version = record(await transport.send("Browser.getVersion"), "Chromium version response");
      if (version.product !== options.expectedIdentity.browserVersion) throw new Error("Chromium product version does not match reviewed Browser identity");
      return transport;
    } catch (error) {
      await transport.close().catch(() => undefined);
      throw error;
    }
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    if (this.failed || this.closing || this.exited) return Promise.reject(new Error("Chromium pipe is unavailable"));
    if (!method.trim() || this.pending.size >= this.limits.maximumPendingCommands) {
      return Promise.reject(new Error("Chromium pipe command is invalid or capacity is exhausted"));
    }
    const id = ++this.nextId;
    const message = Buffer.from(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`, "utf8");
    if (message.length - 1 > this.limits.maximumMessageBytes) return Promise.reject(new Error("Chromium pipe command exceeds its message limit"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`Chromium CDP command ${method} timed out`);
        reject(error);
        this.fail(error);
      }, this.limits.commandTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.process.controlInput.write(message, (error?: Error | null) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(error);
        this.fail(error);
      });
    });
  }

  onEvent(listener: (event: ChromiumCdpEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onFailure(listener: (error: Error) => void): () => void {
    this.failureListeners.add(listener);
    return () => this.failureListeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.rejectPending(new Error("Chromium pipe closed"));
    this.process.controlInput.end();
    if (!this.exited) {
      await Promise.race([
        new Promise<void>((resolve) => this.process.once("exit", () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, this.limits.shutdownTimeoutMs)),
      ]);
      if (!this.exited) this.process.kill("SIGKILL");
    }
  }

  private onData(chunk: Buffer): void {
    if (this.failed || this.closing) return;
    if (this.buffer.length + chunk.length > this.limits.maximumBufferedBytes) return this.fail(new Error("Chromium CDP buffer limit exceeded"));
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const delimiter = this.buffer.indexOf(0);
      if (delimiter < 0) {
        if (this.buffer.length > this.limits.maximumMessageBytes) this.fail(new Error("Chromium CDP message limit exceeded"));
        return;
      }
      const body = this.buffer.subarray(0, delimiter);
      this.buffer = this.buffer.subarray(delimiter + 1);
      if (!body.length || body.length > this.limits.maximumMessageBytes) return this.fail(new Error("Chromium CDP message is empty or oversized"));
      let value: unknown;
      try { value = JSON.parse(body.toString("utf8")); }
      catch { return this.fail(new Error("Chromium CDP returned invalid JSON")); }
      try { this.onMessage(record(value, "Chromium CDP message")); }
      catch (error) { return this.fail(asError(error)); }
    }
  }

  private onMessage(message: Record<string, unknown>): void {
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) throw new Error("Chromium CDP returned an unknown command response");
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        const error = record(message.error, "Chromium CDP error");
        pending.reject(new Error(`Chromium CDP error ${String(error.code)}: ${String(error.message).slice(0, 1024)}`));
      } else pending.resolve(structuredClone(message.result));
      return;
    }
    if (typeof message.method !== "string" || !message.method.trim()) throw new Error("Chromium CDP event is invalid");
    const event: ChromiumCdpEvent = {
      method: message.method,
      params: message.params === undefined ? {} : record(message.params, "Chromium CDP event params"),
      ...(typeof message.sessionId === "string" ? { sessionId: message.sessionId } : {}),
    };
    for (const listener of this.eventListeners) listener(structuredClone(event));
  }

  private onStderr(chunk: Buffer): void {
    this.stderrBytes = Math.min(this.stderrBytes + chunk.length, this.limits.maximumStderrBytes + 1);
  }

  private fail(error: Error): void {
    if (this.failed || this.closing) return;
    this.failed = true;
    this.rejectPending(error);
    this.process.controlInput.end();
    if (!this.exited) this.process.kill("SIGKILL");
    for (const listener of this.failureListeners) {
      try { listener(error); } catch { /* failure notification cannot prevent process cleanup */ }
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }

  private stderrDetail(): string {
    return this.stderrBytes ? ` (${this.stderrBytes > this.limits.maximumStderrBytes ? "more than " : ""}${Math.min(this.stderrBytes, this.limits.maximumStderrBytes)} stderr bytes withheld)` : "";
  }
}

export async function sha256File(path: string): Promise<string> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error("Reviewed Chromium path is not a regular file");
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return hash.digest("hex");
}

function defaultLauncher(spec: ChromiumPipeLaunchSpec): ChromiumPipeProcess {
  const options: SpawnOptions = { cwd: spec.workingDirectory, env: spec.environment, shell: false,
    windowsHide: true, detached: false, stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] };
  const child = spawn(spec.executable, spec.arguments, options);
  const controlInput = child.stdio[3], controlOutput = child.stdio[4], stderr = child.stderr;
  if (!controlInput || !controlOutput || !stderr) throw new Error("Chromium remote-debugging-pipe descriptors are unavailable");
  return adaptChild(child, controlInput as Writable, controlOutput as Readable, stderr);
}

function adaptChild(child: ChildProcess, controlInput: Writable, controlOutput: Readable, stderr: Readable): ChromiumPipeProcess {
  return {
    pid: child.pid, controlInput, controlOutput, stderr,
    once(event: "spawn" | "error" | "exit", listener: ((...args: never[]) => void)) {
      child.once(event, listener as never); return this;
    },
    kill(signal?: NodeJS.Signals) { return child.kill(signal); },
  } as ChromiumPipeProcess;
}

function assertOptions(options: ChromiumPipeTransportOptions): void {
  if (options.expectedIdentity.protocol !== "traceforge.browser-controller.v1"
    || !options.expectedIdentity.controllerVersion.trim() || !options.expectedIdentity.browserVersion.trim()
    || !/^[a-f0-9]{64}$/.test(options.expectedIdentity.controllerSha256)
    || !/^[a-f0-9]{64}$/.test(options.expectedIdentity.browserSha256)) {
    throw new Error("Chromium reviewed identity is invalid");
  }
  if (options.expectedExecutableSha256 !== undefined && !/^[a-f0-9]{64}$/.test(options.expectedExecutableSha256)) {
    throw new Error("Chromium reviewed executable identity is invalid");
  }
  if (!isAbsolute(options.browserExecutable) || !isAbsolute(options.workingDirectory) || !isAbsolute(options.userDataDirectory)) {
    throw new Error("Chromium executable, working and user-data paths must be absolute");
  }
  if (Object.keys(options.environment ?? {}).some((key) => forbiddenEnvironment.has(key.toUpperCase()))) {
    throw new Error("Chromium environment cannot contain proxy variables");
  }
  if (Object.keys(options.environment ?? {}).some((key) => !allowedEnvironment.has(key.toUpperCase()))) {
    throw new Error("Chromium environment contains a variable outside the fixed allowlist");
  }
  if ((options.browserArguments ?? []).some((argument) => forbiddenArgumentPrefixes.some((prefix) =>
    argument === prefix || argument.startsWith(`${prefix}=`)))) throw new Error("Chromium arguments attempt to bypass a fixed security channel");
  if ((options.browserArguments ?? []).some((argument) => !allowedArgumentPrefixes.some((prefix) => argument.startsWith(prefix)))) {
    throw new Error("Chromium argument is outside the fixed allowlist");
  }
}

function waitForSpawn(process: ChromiumPipeProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Chromium process startup timed out")), timeoutMs);
    process.once("spawn", () => { clearTimeout(timer); resolve(); });
    process.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
  return value as Record<string, unknown>;
}

function asError(value: unknown): Error { return value instanceof Error ? value : new Error(String(value)); }
