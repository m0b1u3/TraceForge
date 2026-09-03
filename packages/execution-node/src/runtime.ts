import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { open, readFile, readdir, realpath, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, posix, resolve, win32 } from "node:path";
import {
  allowsFileSystemPath,
  type EffectivePermissionProfile,
} from "@traceforge/orchestration-core";
import {
  EXECUTION_PROTOCOL_VERSION,
  negotiateExecutionProtocol,
  permissionProfileFingerprint,
  resourceLimitsFingerprint,
  type AdoptProcessRequest,
  type AdoptProcessResponse,
  type BrokeredHttpRequest,
  type BrokeredHttpResponse,
  type CanonicalizePathRequest,
  type DirectoryEntry,
  type ExecutionHandshakeRequest,
  type ExecutionHandshakeResponse,
  type ExecutionNode,
  type ExecutionNodeCapabilities,
  type ExecutionNodeDescriptor,
  type ListDirectoryRequest,
  type ListDirectoryResponse,
  type ProcessAccess,
  type ProcessExecutionJournal,
  type ProcessExecutionObservation,
  type ProcessExecutionQuery,
  type ProcessOperationJournal,
  type ProcessOperationKind,
  type ProcessOperationObservation,
  type ProcessOperationQuery,
  type ProcessLaunchIdentity,
  type ProcessDescriptor,
  type ProcessEnforcementAttestation,
  type ProcessEvent,
  type ProcessOutputStream,
  type ResourceLimitKind,
  type ProcessSignal,
  type ReadFileChunkRequest,
  type ReadFileChunkResponse,
  type ReadProcessEventsRequest,
  type ReadProcessEventsResponse,
  type ResizeProcessTerminalRequest,
  type SignalProcessRequest,
  type StartProcessRequest,
  type StartProcessResponse,
  type StatPathRequest,
  type StatPathResponse,
  type TerminateProcessRequest,
  type WriteFileChunkRequest,
  type WriteFileChunkResponse,
  type WriteProcessInputRequest,
} from "./protocol.js";
import type { ExecutionHttpBroker } from "./network-broker.js";
import { ProcessWatchdog, prepareProcessLaunch, processWatchdogOptions, validateDeadline, writeProcessPipe, type ProcessWatchdogOptions } from "./process-watchdog.js";

export interface ManagedProcess {
  readonly pid: number;
  onOutput(listener: (stream: ProcessOutputStream, data: Buffer) => void): void;
  onExit(listener: (exitCode: number | null, signal: string | null) => void): void;
  onError(listener: (error: Error) => void): void;
  onResourceLimit(listener: (resource: ResourceLimitKind) => void): void;
  writeInput(data: Buffer): Promise<void>;
  closeInput(): Promise<void>;
  resizeTerminal(columns: number, rows: number): Promise<void>;
  sendSignal(signal: ProcessSignal): Promise<void>;
  terminate(force: boolean): Promise<void>;
}

export interface LaunchedProcess {
  process: ManagedProcess;
  enforcement: ProcessEnforcementAttestation;
}

export interface ProcessLauncher {
  launch(request: StartProcessRequest, identity?: ProcessLaunchIdentity): Promise<LaunchedProcess>;
}

export interface SpawnLaunchSpec {
  executable: string;
  arguments: string[];
  workingDirectory: string;
  environment: Record<string, string>;
  detached: boolean;
  windowsHide: boolean;
  enforcement: ProcessEnforcementAttestation;
  resourceLimitStatusFile?: string;
  terminate?: (child: ChildProcessWithoutNullStreams, force: boolean) => Promise<void> | void;
}

export class NodeSpawnProcessLauncher implements ProcessLauncher {
  private readonly watchdogOptions: ProcessWatchdogOptions;
  constructor(private readonly resolveLaunch: (request: StartProcessRequest) => Promise<SpawnLaunchSpec> | SpawnLaunchSpec,
    watchdogOptions: Partial<ProcessWatchdogOptions> = {}) {
    this.watchdogOptions = processWatchdogOptions(watchdogOptions);
  }

  async launch(request: StartProcessRequest): Promise<LaunchedProcess> {
    if (request.terminal) throw new Error("Node stdio launcher does not provide a PTY");
    validateDeadline(request.timeoutMs, "Execution timeout");
    const spec = await prepareProcessLaunch(async () => {
      const spec = await this.resolveLaunch(request);
      if (spec.resourceLimitStatusFile) await unlink(spec.resourceLimitStatusFile).catch(() => undefined);
      return spec;
    }, this.watchdogOptions.startupTimeoutMs);
    const child = spawn(spec.executable, spec.arguments, {
      cwd: spec.workingDirectory,
      env: spec.environment,
      detached: spec.detached,
      windowsHide: spec.windowsHide,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const managed = new ChildManagedProcess(child, this.watchdogOptions, request.timeoutMs, spec.terminate, spec.resourceLimitStatusFile);
    await managed.waitStarted();
    return {
      process: managed,
      enforcement: spec.enforcement,
    };
  }
}

class ChildManagedProcess implements ManagedProcess {
  readonly pid: number;
  private readonly resourceLimitListeners: Array<(resource: ResourceLimitKind) => void> = [];
  private readonly errorListeners: Array<(error: Error) => void> = [];
  private pendingResourceLimit: ResourceLimitKind | null = null;
  private pendingError: Error | null = null;
  private readonly exitListeners: Array<(exitCode: number | null, signal: string | null) => void> = [];
  private pendingExit: { exitCode: number | null; signal: string | null } | null = null;
  private readonly watchdog: ProcessWatchdog;
  private readonly started: Promise<void>;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    options: ProcessWatchdogOptions,
    timeoutMs: number,
    private readonly customTerminate?: SpawnLaunchSpec["terminate"],
    private readonly resourceLimitStatusFile?: string,
  ) {
    this.pid = child.pid ?? 0;
    this.child.stdin.setMaxListeners(66); // 64 bounded operations plus transport listeners.
    let rejectStarted: (error: Error) => void = () => undefined;
    this.watchdog = new ProcessWatchdog(options, timeoutMs, (error) => {
      rejectStarted(error);
      this.emitError(error);
      try { this.child.kill("SIGKILL"); } catch { /* transport failure is not cleanup proof */ }
      this.child.stdin.destroy(); this.child.stdout.destroy(); this.child.stderr.destroy();
      this.finish(null, null);
    });
    this.started = new Promise<void>((resolvePromise, reject) => {
      rejectStarted = reject;
      this.child.once("spawn", () => {
        this.watchdog.started();
        if (!this.pid) { this.watchdog.fail(new Error("Spawned process has no operating-system process id")); return; }
        resolvePromise();
      });
    });
    this.child.once("error", (error) => this.watchdog.fail(error));
    for (const pipe of [this.child.stdin, this.child.stdout, this.child.stderr]) {
      pipe.on("error", (error) => this.watchdog.fail(error));
    }
    this.child.once("exit", () => this.watchdog.beginShutdown());
    this.child.once("close", (exitCode, signal) => {
      if (this.pendingExit) return;
      this.watchdog.beginShutdown();
      void this.watchdog.operation("resource status read", () => this.readTrustedResourceLimit())
        .then(() => this.finish(exitCode, signal), () => undefined);
    });
  }

  waitStarted(): Promise<void> { return this.started; }

  onOutput(listener: (stream: ProcessOutputStream, data: Buffer) => void): void {
    this.child.stdout.on("data", (data: Buffer) => listener("stdout", data));
    this.child.stderr.on("data", (data: Buffer) => listener("stderr", data));
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
    await this.watchdog.operation("input write", (signal) => writeProcessPipe(this.child.stdin, data, signal));
  }

  async closeInput(): Promise<void> {
    if (this.child.stdin.writableEnded) return;
    await this.watchdog.operation("input close", (signal) => writeProcessPipe(this.child.stdin, null, signal));
  }

  async resizeTerminal(_columns: number, _rows: number): Promise<void> {
    throw new Error("Node stdio launcher does not provide a PTY");
  }

  async sendSignal(signal: ProcessSignal): Promise<void> {
    if (signal === "terminate" || signal === "kill") return this.terminate(signal === "kill");
    const mapped: Record<ProcessSignal, NodeJS.Signals> = {
      interrupt: "SIGINT",
      terminate: "SIGTERM",
      kill: "SIGKILL",
      hangup: "SIGHUP",
      user1: "SIGUSR1",
      user2: "SIGUSR2",
    };
    if (!this.child.kill(mapped[signal])) throw new Error(`Operating system rejected signal ${signal}`);
  }

  async terminate(force: boolean): Promise<void> {
    this.watchdog.beginShutdown();
    await this.watchdog.operation("termination request", async () => {
      if (this.customTerminate) { await this.customTerminate(this.child, force); return; }
      if (!this.child.kill(force ? "SIGKILL" : "SIGTERM")) throw new Error("Operating system rejected process termination");
    });
  }

  private async readTrustedResourceLimit(): Promise<void> {
    if (!this.resourceLimitStatusFile) return;
    try {
      const resource = (await readFile(this.resourceLimitStatusFile, "utf8")).trim() as ResourceLimitKind;
      if (this.pendingError || this.pendingExit) return;
      if (!["cpu_time", "memory", "process_count", "write_bytes"].includes(resource)) return;
      this.pendingResourceLimit = resource;
      for (const listener of this.resourceLimitListeners) listener(resource);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    } finally {
      await unlink(this.resourceLimitStatusFile).catch(() => undefined);
    }
  }

  private emitError(error: Error): void {
    this.pendingError = error;
    for (const listener of this.errorListeners) listener(error);
  }

  private finish(exitCode: number | null, signal: string | null): void {
    if (this.pendingExit) return;
    this.watchdog.dispose();
    this.pendingExit = { exitCode, signal };
    for (const listener of this.exitListeners) listener(exitCode, signal);
  }
}

interface ProcessRecord {
  observation: ProcessExecutionObservation;
  descriptor: ProcessDescriptor;
  requestFingerprint: string;
  token: string;
  tokenHash: Buffer;
  process: ManagedProcess;
  stdinMode: StartProcessRequest["stdin"];
  events: ProcessEvent[];
  waiters: Set<() => void>;
  outputLimitBytes: number;
  truncationEmitted: boolean;
  timeout: ReturnType<typeof setTimeout> | null;
  observationPersisted: boolean;
}

interface WriteReceipt {
  fingerprint: string;
  response: WriteFileChunkResponse;
}

export interface LocalExecutionNodeOptions {
  processJournal?: ProcessExecutionJournal;
  operationJournal?: ProcessOperationJournal;
  id?: string;
  platform?: EffectivePermissionProfile["platform"];
  architecture?: string;
  now?: () => string;
  capabilities?: Partial<ExecutionNodeCapabilities>;
  sandboxBackends: string[];
  sandboxMeasurements?: Readonly<Record<string, string>>;
  maximumProcesses?: number;
  maximumResidentProcesses?: number;
  terminalRetentionMs?: number;
  maximumOutputBytesPerProcess?: number;
  maximumRetainedEventsPerProcess?: number;
  maximumCpuTimeMsPerProcess?: number;
  maximumMemoryBytesPerProcess?: number;
  maximumProcessesPerExecution?: number;
  maximumWriteBytesPerProcess?: number;
  maximumFileChunkBytes?: number;
  maximumListEntries?: number;
  httpBroker?: ExecutionHttpBroker;
}

type EventPayload<T = ProcessEvent> = T extends ProcessEvent ? Omit<T, "sequence" | "processId" | "at"> : never;

function runtimePlatform(): EffectivePermissionProfile["platform"] {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "darwin";
  return "linux";
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

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

function cloneDescriptor(descriptor: ProcessDescriptor): ProcessDescriptor {
  return structuredClone(descriptor);
}

function decodeBase64(value: string): Buffer {
  if (value.length === 0) return Buffer.alloc(0);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("Process and file payloads must use canonical base64 encoding");
  }
  return Buffer.from(value, "base64");
}

function kindOf(entry: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): DirectoryEntry["kind"] {
  if (entry.isFile()) return "file";
  if (entry.isDirectory()) return "directory";
  if (entry.isSymbolicLink()) return "symlink";
  return "other";
}

export class LocalExecutionNode implements ExecutionNode {
  private readonly generationId = randomUUID();
  readonly descriptor: ExecutionNodeDescriptor;
  private readonly records = new Map<string, ProcessRecord>();
  private readonly processByIdempotencyKey = new Map<string, string>();
  private readonly writeReceipts = new Map<string, WriteReceipt>();
  private readonly startingKeys = new Set<string>();
  private shuttingDown = false;
  private readonly processJournal?: ProcessExecutionJournal;
  private readonly operationJournal?: ProcessOperationJournal;
  private readonly now: () => string;
  private readonly httpBroker: ExecutionHttpBroker | undefined;
  private readonly maximumResidentProcesses: number;
  private readonly terminalRetentionMs: number;

  constructor(private readonly launcher: ProcessLauncher, options: LocalExecutionNodeOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.httpBroker = options.httpBroker;
    this.processJournal = options.processJournal;
    this.operationJournal = options.operationJournal;
    this.maximumResidentProcesses = options.maximumResidentProcesses ?? 128;
    this.terminalRetentionMs = options.terminalRetentionMs ?? 60_000;
    if (!Number.isSafeInteger(this.maximumResidentProcesses) || this.maximumResidentProcesses < 1
      || !Number.isSafeInteger(this.terminalRetentionMs) || this.terminalRetentionMs < 0) {
      throw new Error("Invalid process history retention limits");
    }
    const capabilities: ExecutionNodeCapabilities = {
      process: {
        spawn: true,
        stdio: true,
        tty: false,
        adoption: true,
        resourceLimits: false,
        signals: ["interrupt", "terminate", "kill"],
        ...options.capabilities?.process,
        executionObservation: Boolean(options.processJournal),
        operationObservation: Boolean(options.operationJournal),
      },
      filesystem: {
        canonicalize: true,
        read: true,
        write: true,
        list: true,
        stat: true,
        maximumChunkBytes: options.maximumFileChunkBytes ?? 1024 * 1024,
        maximumListEntries: options.maximumListEntries ?? 10_000,
        ...options.capabilities?.filesystem,
      },
      network: { brokered: Boolean(options.httpBroker) },
      http: { request: Boolean(options.httpBroker), streaming: false },
      sandbox: {
        backends: [...new Set(options.sandboxBackends)],
        measurements: options.sandboxMeasurements ? { ...options.sandboxMeasurements } : undefined,
        ...options.capabilities?.sandbox,
      },
    };
    if (options.capabilities?.network?.brokered !== undefined
      && options.capabilities.network.brokered !== capabilities.network.brokered) {
      throw new Error("Execution Node brokered network capability must be derived from an installed HTTP broker");
    }
    if (options.capabilities?.http?.request !== undefined
      && options.capabilities.http.request !== capabilities.http.request) {
      throw new Error("Execution Node HTTP request capability must be derived from an installed HTTP broker");
    }
    if (capabilities.process.spawn && !capabilities.sandbox.backends.length) {
      throw new Error("A process-capable Execution Node requires at least one sandbox backend");
    }
    if (capabilities.filesystem.maximumChunkBytes < 1 || capabilities.filesystem.maximumListEntries < 1) {
      throw new Error("Execution Node filesystem limits must be positive");
    }
    const maximumProcesses = options.maximumProcesses ?? 32;
    const maximumOutputBytesPerProcess = options.maximumOutputBytesPerProcess ?? 4 * 1024 * 1024;
    const maximumRetainedEventsPerProcess = options.maximumRetainedEventsPerProcess ?? 4096;
    const maximumCpuTimeMsPerProcess = options.maximumCpuTimeMsPerProcess ?? 300_000;
    const maximumMemoryBytesPerProcess = options.maximumMemoryBytesPerProcess ?? 2 * 1024 * 1024 * 1024;
    const maximumProcessesPerExecution = options.maximumProcessesPerExecution ?? 64;
    const maximumWriteBytesPerProcess = options.maximumWriteBytesPerProcess ?? 1024 * 1024 * 1024;
    if (maximumProcesses < 1 || maximumOutputBytesPerProcess < 1 || maximumRetainedEventsPerProcess < 2
      || maximumCpuTimeMsPerProcess < 1 || maximumMemoryBytesPerProcess < 1
      || maximumProcessesPerExecution < 1 || maximumWriteBytesPerProcess < 1) {
      throw new Error("Execution Node process limits are invalid");
    }
    this.descriptor = {
      id: options.id ?? `execnode_${randomUUID()}`,
      protocol: { ...EXECUTION_PROTOCOL_VERSION },
      platform: options.platform ?? runtimePlatform(),
      architecture: options.architecture ?? process.arch,
      capabilities,
      limits: {
        maximumProcesses, maximumOutputBytesPerProcess, maximumRetainedEventsPerProcess,
        maximumCpuTimeMsPerProcess, maximumMemoryBytesPerProcess,
        maximumProcessesPerExecution, maximumWriteBytesPerProcess,
        maximumHttpRequestBytes: options.httpBroker?.limits.maximumRequestBytes ?? 0,
        maximumHttpResponseBytes: options.httpBroker?.limits.maximumResponseBytes ?? 0,
        maximumHttpHeaders: options.httpBroker?.limits.maximumHeaders ?? 0,
        maximumConcurrentHttpRequests: options.httpBroker?.limits.maximumConcurrentRequests ?? 0,
      },
      startedAt: this.now(),
    };
  }

  async handshake(request: ExecutionHandshakeRequest): Promise<ExecutionHandshakeResponse> {
    return negotiateExecutionProtocol(request, this.descriptor);
  }

  async requestHttp(request: BrokeredHttpRequest): Promise<BrokeredHttpResponse> {
    if (!this.descriptor.capabilities.network.brokered || !this.descriptor.capabilities.http.request || !this.httpBroker) {
      throw new Error("Execution Node does not provide brokered HTTP requests");
    }
    this.assertAttribution(request.attribution);
    this.assertPermissionPlatform(request.permissions);
    return this.httpBroker.execute(this.descriptor.id, structuredClone(request));
  }

  async startProcess(request: StartProcessRequest): Promise<StartProcessResponse> {
    if (this.shuttingDown) throw new Error("Execution Node is shutting down and cannot start new processes");
    if (Buffer.byteLength(JSON.stringify(request)) > 128 * 1024) throw new Error("Process request exceeds its size limit");
    const snapshot = structuredClone(request);
    const key = snapshot.attribution.idempotencyKey;
    if (this.startingKeys.has(key)) throw new Error("Process execution is already being started");
    if (this.startingKeys.size >= this.descriptor.limits.maximumProcesses) throw new Error("Execution Node startup capacity is exhausted");
    this.startingKeys.add(key);
    try { return await this.startProcessOnce(snapshot); }
    finally { this.startingKeys.delete(key); }
  }

  async lookupProcessExecution(query: ProcessExecutionQuery): Promise<ProcessExecutionObservation | undefined> {
    if (!this.processJournal) throw new Error("Durable execution observation is unavailable");
    const observation = this.processJournal.get(query.idempotencyKey);
    if (!observation) return undefined;
    if (canonicalJson(observation.identity) !== canonicalJson(query)) throw new Error("Execution observation identity mismatch");
    return structuredClone(observation);
  }

  async lookupProcessOperation(query: ProcessOperationQuery): Promise<ProcessOperationObservation | undefined> {
    if (!this.operationJournal) throw new Error("Durable process operation observation is unavailable");
    const observation = this.operationJournal.get(query.operationId);
    if (!observation) return undefined;
    if (canonicalJson(observation.identity) !== canonicalJson(query)) throw new Error("Process operation observation identity mismatch");
    return structuredClone(observation);
  }

  private async startProcessOnce(request: StartProcessRequest): Promise<StartProcessResponse> {
    const effectiveRequest = await this.materializeStartRequest(request);
    await this.assertStartRequest(effectiveRequest);
    const fingerprint = createHash("sha256").update(canonicalJson(effectiveRequest)).digest("hex");
    const priorId = this.processByIdempotencyKey.get(effectiveRequest.attribution.idempotencyKey);
    if (priorId) {
      const prior = this.records.get(priorId)!;
      if (prior.requestFingerprint !== fingerprint) throw new Error(`Process idempotency key ${effectiveRequest.attribution.idempotencyKey} was reused with different input`);
      return { process: cloneDescriptor(prior.descriptor), adoptionToken: prior.token, replayed: true };
    }
    const active = [...this.records.values()].filter((record) => !["exited", "failed"].includes(record.descriptor.state)).length;
    if (active + this.startingKeys.size > this.descriptor.limits.maximumProcesses) throw new Error("Execution Node process capacity is exhausted");
    this.pruneProcessHistory();
    if (this.records.size + this.startingKeys.size > this.maximumResidentProcesses) {
      throw new Error("Execution Node process history capacity is exhausted");
    }

    const observation: ProcessExecutionObservation = {
      schemaVersion: 2,
      launch: { nodeId: this.descriptor.id, generationId: this.generationId,
        launchId: randomBytes(32).toString("hex"), requestId: effectiveRequest.requestId,
        requestFingerprint: fingerprint },
      identity: { idempotencyKey: effectiveRequest.attribution.idempotencyKey, requestId: effectiveRequest.requestId,
        caseId: effectiveRequest.attribution.caseId, runId: effectiveRequest.attribution.runId,
        workId: effectiveRequest.attribution.workId, leaseId: effectiveRequest.attribution.leaseId },
      nodeId: this.descriptor.id, requestFingerprint: fingerprint,
      status: "claimed", cleanup: "unverified", process: null, events: [], lostEvents: false, updatedAt: this.now(),
    };
    // Atomic durable claim precedes dispatch, including launcher errors with an unknown external outcome.
    this.processJournal?.claim(observation);

    const launched = await this.launcher.launch(structuredClone(effectiveRequest), structuredClone(observation.launch));
    try {
      this.assertEnforcement(effectiveRequest.permissions, effectiveRequest.resources, launched.enforcement);
    } catch (error) {
      await launched.process.terminate(true).catch(() => undefined);
      throw error;
    }
    const id = `process_${randomUUID()}`;
    const token = randomBytes(32).toString("base64url");
    const at = this.now();
    const descriptor: ProcessDescriptor = {
      id,
      nodeId: this.descriptor.id,
      pid: launched.process.pid,
      state: "running",
      attribution: structuredClone(effectiveRequest.attribution),
      executable: effectiveRequest.executable,
      arguments: [...effectiveRequest.arguments],
      workingDirectory: effectiveRequest.workingDirectory,
      terminal: effectiveRequest.terminal ? { ...effectiveRequest.terminal } : null,
      enforcement: { ...launched.enforcement },
      startedAt: at,
      updatedAt: at,
      exitedAt: null,
      exitCode: null,
      exitSignal: null,
      resourceLimitExceeded: null,
      capturedOutputBytes: 0,
      omittedOutputBytes: 0,
      lastEventSequence: 0,
    };
    const record: ProcessRecord = {
      observation,
      descriptor,
      requestFingerprint: fingerprint,
      token,
      tokenHash: hashToken(token),
      process: launched.process,
      stdinMode: effectiveRequest.stdin,
      events: [],
      waiters: new Set(),
      outputLimitBytes: effectiveRequest.outputLimitBytes,
      truncationEmitted: false,
      timeout: null,
      observationPersisted: false,
    };
    this.records.set(id, record);
    this.processByIdempotencyKey.set(effectiveRequest.attribution.idempotencyKey, id);
    this.append(record, { type: "process.started", pid: launched.process.pid });
    launched.process.onOutput((stream, data) => this.captureOutput(record, stream, data));
    launched.process.onError((error) => this.fail(record, error));
    launched.process.onResourceLimit((resource) => this.resourceLimitExceeded(record, resource));
    // Buffered helper failures/resource limits must be replayed before a buffered terminal callback.
    launched.process.onExit((exitCode, signal) => this.finish(record, exitCode, signal));
    if (!["exited", "failed"].includes(record.descriptor.state)) {
      record.timeout = setTimeout(() => {
        if (["exited", "failed"].includes(record.descriptor.state)) return;
        record.descriptor.state = "terminating";
        record.descriptor.updatedAt = this.now();
        void record.process.terminate(true).catch((error) => this.fail(record, error));
      }, effectiveRequest.timeoutMs);
      if (effectiveRequest.stdin === "closed") {
        try {
          await launched.process.closeInput();
          this.append(record, { type: "process.stdin_closed" });
        } catch (error) {
          this.fail(record, error instanceof Error ? error : new Error(String(error)));
          throw error;
        }
      }
    }
    return { process: cloneDescriptor(descriptor), adoptionToken: token, replayed: false };
  }

  async describeProcess(access: ProcessAccess): Promise<ProcessDescriptor> {
    return cloneDescriptor(this.requireAccess(access).descriptor);
  }

  async readProcessEvents(request: ReadProcessEventsRequest): Promise<ReadProcessEventsResponse> {
    const record = this.requireAccess(request);
    return this.readProcessEventsNow(record, request);
  }

  private readProcessEventsNow(record: ProcessRecord, request: ReadProcessEventsRequest): ReadProcessEventsResponse {
    if (!Number.isInteger(request.afterSequence) || request.afterSequence < 0) throw new Error("Process event cursor must be a non-negative integer");
    if (!Number.isInteger(request.maximumEvents) || request.maximumEvents < 1) throw new Error("Maximum process events must be positive");
    const earliest = record.events[0]?.sequence ?? record.descriptor.lastEventSequence + 1;
    const lostEvents = request.afterSequence < earliest - 1;
    const events = record.events.filter((event) => event.sequence > request.afterSequence).slice(0, request.maximumEvents);
    return {
      process: cloneDescriptor(record.descriptor),
      events: structuredClone(events),
      nextSequence: events.at(-1)?.sequence ?? request.afterSequence,
      lostEvents,
    };
  }

  async waitProcessEvents(request: ReadProcessEventsRequest, timeoutMs: number): Promise<ReadProcessEventsResponse> {
    const record = this.requireAccess(request);
    const immediate = this.readProcessEventsNow(record, request);
    if (immediate.events.length || ["exited", "failed"].includes(immediate.process.state) || timeoutMs <= 0) return immediate;
    if (record.waiters.size >= 64) throw new Error("Process observation waiter capacity is exhausted");
    await new Promise<void>((resolvePromise) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const wake = () => {
        if (timer) clearTimeout(timer);
        record.waiters.delete(wake);
        resolvePromise();
      };
      record.waiters.add(wake);
      const afterRegistration = this.readProcessEventsNow(record, request);
      if (afterRegistration.events.length || ["exited", "failed"].includes(afterRegistration.process.state)) wake();
      else timer = setTimeout(wake, Math.min(Math.max(timeoutMs, 1), 60_000));
    });
    return this.readProcessEventsNow(record, request);
  }

  async writeProcessInput(request: WriteProcessInputRequest): Promise<ProcessDescriptor> {
    const replay = this.replayProcessOperation<ProcessDescriptor>(request, "process.writeInput");
    if (replay) return replay;
    const record = this.requireAccess(request);
    this.assertActiveLease(record.descriptor.attribution);
    if (record.stdinMode !== "pipe") throw new Error(`Process ${record.descriptor.id} was started with closed input`);
    if (record.descriptor.state !== "running") throw new Error(`Process ${record.descriptor.id} is ${record.descriptor.state}`);
    const data = decodeBase64(request.dataBase64);
    this.claimProcessOperation(request, "process.writeInput");
    if (data.length) await record.process.writeInput(data);
    if (request.closeAfterWrite) {
      await record.process.closeInput();
      record.stdinMode = "closed";
      this.append(record, { type: "process.stdin_closed" });
    }
    return this.completeProcessOperation(request, "process.writeInput", cloneDescriptor(record.descriptor));
  }

  async resizeProcessTerminal(request: ResizeProcessTerminalRequest): Promise<ProcessDescriptor> {
    const replay = this.replayProcessOperation<ProcessDescriptor>(request, "process.resizeTerminal");
    if (replay) return replay;
    const record = this.requireAccess(request);
    this.assertActiveLease(record.descriptor.attribution);
    if (!record.descriptor.terminal) throw new Error(`Process ${record.descriptor.id} was not started with a terminal`);
    if (record.descriptor.state !== "running") throw new Error(`Process ${record.descriptor.id} is ${record.descriptor.state}`);
    this.assertTerminalSize(request.columns, request.rows);
    this.claimProcessOperation(request, "process.resizeTerminal");
    await record.process.resizeTerminal(request.columns, request.rows);
    record.descriptor.terminal = {
      ...record.descriptor.terminal,
      columns: request.columns,
      rows: request.rows,
    };
    record.descriptor.updatedAt = this.now();
    return this.completeProcessOperation(request, "process.resizeTerminal", cloneDescriptor(record.descriptor));
  }

  async signalProcess(request: SignalProcessRequest): Promise<ProcessDescriptor> {
    const replay = this.replayProcessOperation<ProcessDescriptor>(request, "process.signal");
    if (replay) return replay;
    const record = this.requireAccess(request);
    this.assertActiveLease(record.descriptor.attribution);
    if (!this.descriptor.capabilities.process.signals.includes(request.signal)) throw new Error(`Execution Node does not support signal ${request.signal}`);
    if (record.descriptor.state !== "running") throw new Error(`Process ${record.descriptor.id} is ${record.descriptor.state}`);
    this.claimProcessOperation(request, "process.signal");
    await record.process.sendSignal(request.signal);
    this.append(record, { type: "process.signal_sent", signal: request.signal });
    return this.completeProcessOperation(request, "process.signal", cloneDescriptor(record.descriptor));
  }

  async terminateProcess(request: TerminateProcessRequest): Promise<ProcessDescriptor> {
    const replay = this.replayProcessOperation<ProcessDescriptor>(request, "process.terminate");
    if (replay) return replay;
    const record = this.requireAccess(request);
    this.claimProcessOperation(request, "process.terminate");
    if (["exited", "failed"].includes(record.descriptor.state)) {
      return this.completeProcessOperation(request, "process.terminate", cloneDescriptor(record.descriptor));
    }
    record.descriptor.state = "terminating";
    record.descriptor.updatedAt = this.now();
    await record.process.terminate(request.force ?? false);
    this.append(record, { type: "process.signal_sent", signal: request.force ? "kill" : "terminate" });
    return this.completeProcessOperation(request, "process.terminate", cloneDescriptor(record.descriptor));
  }

  async adoptProcess(request: AdoptProcessRequest): Promise<AdoptProcessResponse> {
    const replay = this.replayProcessOperation<AdoptProcessResponse>(request, "process.adopt");
    if (replay) return replay;
    const record = this.requireAccess(request);
    this.assertAttribution(request.attribution);
    const previous = record.descriptor.attribution;
    if (previous.caseId !== request.attribution.caseId || previous.runId !== request.attribution.runId
      || previous.workId !== request.attribution.workId || previous.scopeRef !== request.attribution.scopeRef) {
      throw new Error("A process can only be adopted by a new lease for the same Case, Run, Work, and authorization scope");
    }
    this.claimProcessOperation(request, "process.adopt");
    const token = randomBytes(32).toString("base64url");
    record.token = token;
    record.tokenHash = hashToken(token);
    record.descriptor.attribution = structuredClone(request.attribution);
    record.descriptor.updatedAt = this.now();
    return this.completeProcessOperation(request, "process.adopt", { process: cloneDescriptor(record.descriptor), adoptionToken: token });
  }

  async shutdown(timeoutMs = 10_000): Promise<{ requested: number; terminated: number }> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error("Execution Node shutdown deadline is invalid");
    this.shuttingDown = true;
    const deadline = Date.now() + timeoutMs;
    while (this.startingKeys.size && Date.now() < deadline) {
      await new Promise(resolvePromise => setTimeout(resolvePromise, Math.min(10, Math.max(1, deadline - Date.now()))));
    }
    if (this.startingKeys.size) throw new Error("Execution Node shutdown could not settle processes still starting");
    const active = [...this.records.values()].filter(record => !["exited", "failed"].includes(record.descriptor.state));
    if (!active.length) return { requested: 0, terminated: 0 };
    const exits = active.map(record => new Promise<void>(resolvePromise => record.process.onExit(() => resolvePromise())));
    for (const record of active) {
      record.descriptor.state = "terminating";
      this.append(record, { type: "process.signal_sent", signal: "kill" });
    }
    const terminations = Promise.allSettled(active.map(record => record.process.terminate(true)));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all([terminations, Promise.all(exits)]),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Execution Node shutdown did not prove all process trees terminated")), Math.max(1, deadline - Date.now())); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    const unresolved = active.filter(record => !["exited", "failed"].includes(record.descriptor.state));
    if (unresolved.length) throw new Error(`Execution Node shutdown left ${unresolved.length} process trees unresolved`);
    return { requested: active.length, terminated: active.length };
  }

  private processOperationIdentity(
    request: { operationId: string; processId: string }, operation: ProcessOperationKind,
  ): ProcessOperationQuery {
    if (typeof request.operationId !== "string" || !request.operationId.trim()
      || Buffer.byteLength(request.operationId) > 256) throw new Error("Process operation identity is invalid");
    return {
      operationId: request.operationId,
      operation,
      processId: request.processId,
      requestFingerprint: createHash("sha256").update(canonicalJson(request)).digest("hex"),
    };
  }

  private replayProcessOperation<T>(
    request: { operationId: string; processId: string }, operation: ProcessOperationKind,
  ): T | undefined {
    const identity = this.processOperationIdentity(request, operation);
    const prior = this.operationJournal?.get(identity.operationId);
    if (!prior) return undefined;
    if (canonicalJson(prior.identity) !== canonicalJson(identity) || prior.nodeId !== this.descriptor.id) {
      throw new Error("Process operation identity was reused with different input");
    }
    if (prior.state !== "completed" || prior.response === null) {
      throw new Error("Process operation outcome is unconfirmed; reconciliation is required");
    }
    return structuredClone(prior.response) as T;
  }

  private claimProcessOperation(
    request: { operationId: string; processId: string }, operation: ProcessOperationKind,
  ): void {
    if (!this.operationJournal) return;
    this.operationJournal.claim({
      schemaVersion: 1,
      identity: this.processOperationIdentity(request, operation),
      nodeId: this.descriptor.id,
      state: "claimed",
      response: null,
      updatedAt: this.now(),
    });
  }

  private completeProcessOperation<T extends ProcessDescriptor | AdoptProcessResponse>(
    request: { operationId: string; processId: string }, operation: ProcessOperationKind, response: T,
  ): T {
    if (this.operationJournal) {
      this.operationJournal.complete({
        schemaVersion: 1,
        identity: this.processOperationIdentity(request, operation),
        nodeId: this.descriptor.id,
        state: "completed",
        response: structuredClone(response),
        updatedAt: this.now(),
      });
    }
    return response;
  }

  async canonicalizePath(request: CanonicalizePathRequest): Promise<string> {
    this.assertFileContext(request);
    return this.canonicalPath(request.path, request.access, request.permissions);
  }

  async readFileChunk(request: ReadFileChunkRequest): Promise<ReadFileChunkResponse> {
    this.assertFileContext(request);
    if (!this.descriptor.capabilities.filesystem.read) throw new Error("Execution Node does not support file reads");
    if (!Number.isInteger(request.offset) || request.offset < 0 || !Number.isInteger(request.length) || request.length < 1) {
      throw new Error("File chunk offset and length are invalid");
    }
    if (request.length > this.descriptor.capabilities.filesystem.maximumChunkBytes) throw new Error("Requested file chunk exceeds the node limit");
    const canonicalPath = await this.canonicalPath(request.path, "read", request.permissions);
    const handle = await open(canonicalPath, "r");
    try {
      const metadata = await handle.stat();
      const buffer = Buffer.alloc(Math.min(request.length, Math.max(0, metadata.size - request.offset)));
      const { bytesRead } = buffer.length ? await handle.read(buffer, 0, buffer.length, request.offset) : { bytesRead: 0 };
      return {
        canonicalPath,
        offset: request.offset,
        dataBase64: buffer.subarray(0, bytesRead).toString("base64"),
        bytes: bytesRead,
        size: metadata.size,
        eof: request.offset + bytesRead >= metadata.size,
      };
    } finally {
      await handle.close();
    }
  }

  async writeFileChunk(request: WriteFileChunkRequest): Promise<WriteFileChunkResponse> {
    this.assertFileContext(request);
    if (!this.descriptor.capabilities.filesystem.write) throw new Error("Execution Node does not support file writes");
    if (!Number.isInteger(request.offset) || request.offset < 0) throw new Error("File write offset is invalid");
    if (request.truncate && request.offset !== 0) throw new Error("A truncating write must start at offset zero");
    const data = decodeBase64(request.dataBase64);
    if (data.length > this.descriptor.capabilities.filesystem.maximumChunkBytes) throw new Error("File write chunk exceeds the node limit");
    const fingerprint = canonicalJson(request);
    const receipt = this.writeReceipts.get(request.requestId);
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) throw new Error(`File request id ${request.requestId} was reused with different input`);
      return { ...receipt.response, replayed: true };
    }
    const canonicalPath = await this.canonicalPath(request.path, "write", request.permissions);
    let handle;
    try {
      handle = await open(canonicalPath, "r+");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !request.create) throw error;
      handle = await open(canonicalPath, "w+");
    }
    try {
      if (request.truncate) await handle.truncate(0);
      const { bytesWritten } = data.length ? await handle.write(data, 0, data.length, request.offset) : { bytesWritten: 0 };
      const metadata = await handle.stat();
      const response: WriteFileChunkResponse = { canonicalPath, bytesWritten, size: metadata.size, replayed: false };
      this.writeReceipts.set(request.requestId, { fingerprint, response });
      return response;
    } finally {
      await handle.close();
    }
  }

  async listDirectory(request: ListDirectoryRequest): Promise<ListDirectoryResponse> {
    this.assertFileContext(request);
    if (!this.descriptor.capabilities.filesystem.list) throw new Error("Execution Node does not support directory listing");
    if (!Number.isInteger(request.maximumEntries) || request.maximumEntries < 1) throw new Error("Maximum directory entries must be positive");
    const canonicalPath = await this.canonicalPath(request.path, "read", request.permissions);
    const values = (await readdir(canonicalPath, { withFileTypes: true }))
      .map((entry) => ({ name: entry.name, kind: kindOf(entry) }))
      .sort((left, right) => left.name.localeCompare(right.name));
    const limit = Math.min(request.maximumEntries, this.descriptor.capabilities.filesystem.maximumListEntries);
    return { canonicalPath, entries: values.slice(0, limit), omittedEntries: Math.max(0, values.length - limit) };
  }

  async statPath(request: StatPathRequest): Promise<StatPathResponse> {
    this.assertFileContext(request);
    if (!this.descriptor.capabilities.filesystem.stat) throw new Error("Execution Node does not support path metadata");
    const canonicalPath = await this.canonicalPath(request.path, "read", request.permissions);
    const metadata = await stat(canonicalPath);
    return {
      canonicalPath,
      kind: kindOf(metadata),
      size: metadata.size,
      modifiedAt: metadata.mtime.toISOString(),
    };
  }

  private async assertStartRequest(request: StartProcessRequest): Promise<void> {
    if (!this.descriptor.capabilities.process.spawn) throw new Error("Execution Node does not support process spawn");
    if (!request.requestId.trim()) throw new Error("Process request id is required");
    this.assertAttribution(request.attribution);
    this.assertPermissionPlatform(request.permissions);
    if (request.permissions.process.access === "deny") throw new Error("Effective permission profile denies process execution");
    if (!isAbsolute(request.executable)) throw new Error("Execution Node requires an absolute executable path");
    await this.canonicalPath(request.executable, "read", request.permissions);
    await this.canonicalPath(request.workingDirectory, "read", request.permissions);
    if (request.terminal) {
      if (!this.descriptor.capabilities.process.tty) throw new Error("Execution Node does not provide PTY support");
      if (!request.permissions.process.interactive) throw new Error("Effective permission profile denies interactive processes");
      this.assertTerminalSize(request.terminal.columns, request.terminal.rows);
    }
    if (request.stdin === "pipe" && !this.descriptor.capabilities.process.stdio) throw new Error("Execution Node does not provide writable standard input");
    if (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 1) throw new Error("Process timeout must be positive");
    if (!Number.isInteger(request.outputLimitBytes) || request.outputLimitBytes < 1
      || request.outputLimitBytes > this.descriptor.limits.maximumOutputBytesPerProcess) {
      throw new Error("Process output limit is invalid");
    }
    this.assertResourceLimits(request);
  }

  private assertTerminalSize(columns: number, rows: number): void {
    if (!Number.isInteger(columns) || columns < 1 || columns > 1000
      || !Number.isInteger(rows) || rows < 1 || rows > 1000) {
      throw new Error("Terminal dimensions must be integers between 1 and 1000");
    }
  }

  private assertResourceLimits(request: StartProcessRequest): void {
    if (!this.descriptor.capabilities.process.resourceLimits) {
      throw new Error("Execution Node does not provide enforceable process-tree resource limits");
    }
    const checks: Array<[keyof StartProcessRequest["resources"], number, number]> = [
      ["cpuTimeMs", request.resources.cpuTimeMs, this.descriptor.limits.maximumCpuTimeMsPerProcess],
      ["memoryBytes", request.resources.memoryBytes, this.descriptor.limits.maximumMemoryBytesPerProcess],
      ["maximumProcesses", request.resources.maximumProcesses, this.descriptor.limits.maximumProcessesPerExecution],
      ["writeBytes", request.resources.writeBytes, this.descriptor.limits.maximumWriteBytesPerProcess],
    ];
    for (const [name, value, maximum] of checks) {
      if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
        throw new Error(`Process resource limit ${name} must be a positive safe integer no greater than ${maximum}`);
      }
    }
  }

  private assertEnforcement(
    permissions: EffectivePermissionProfile,
    resources: StartProcessRequest["resources"],
    enforcement: ProcessEnforcementAttestation,
  ): void {
    if (!this.descriptor.capabilities.sandbox.backends.includes(enforcement.sandboxBackend)) {
      throw new Error(`Launcher used unregistered sandbox backend ${enforcement.sandboxBackend}`);
    }
    const expectedMeasurement = this.descriptor.capabilities.sandbox.measurements?.[enforcement.sandboxBackend];
    if (expectedMeasurement && enforcement.backendMeasurement !== expectedMeasurement) {
      throw new Error(`Launcher sandbox backend measurement does not match registered ${enforcement.sandboxBackend} helper`);
    }
    if (permissions.process.access === "sandboxed" && !enforcement.sandboxed) throw new Error("Launcher did not enforce the required process sandbox");
    if (!enforcement.filesystemPolicyApplied) throw new Error("Launcher did not enforce the effective filesystem profile");
    if (enforcement.permissionProfileFingerprint !== permissionProfileFingerprint(permissions)) {
      throw new Error("Launcher enforcement proof does not match the effective permission profile");
    }
    if (!enforcement.resourceLimitsApplied) throw new Error("Launcher did not enforce the requested process-tree resource limits");
    if (enforcement.resourceLimitsFingerprint !== resourceLimitsFingerprint(resources)) {
      throw new Error("Launcher resource-limit proof does not match the requested limits");
    }
    const allowedNetwork: Record<EffectivePermissionProfile["network"], ProcessEnforcementAttestation["network"][]> = {
      deny: ["deny"],
      brokered: ["deny", "brokered"],
      direct: ["deny", "brokered", "direct"],
    };
    if (!allowedNetwork[permissions.network].includes(enforcement.network)) {
      throw new Error(`Launcher network enforcement ${enforcement.network} exceeds effective permission ${permissions.network}`);
    }
    if(enforcement.sandboxBackend==="traceforge-linux-native"&&(!enforcement.atomicProcessTreeAssignment||!enforcement.processTreeEmptyBarrier||!enforcement.linux?.cgroupV2||!enforcement.linux.seccomp||!enforcement.linux.noNewPrivileges
      ||["user","mount","pid","ipc","uts","network"].some(name=>!enforcement.linux!.namespaces.includes(name as any))))throw new Error("Linux launcher did not provide the required namespace/cgroup/seccomp process-tree proof");
  }

  private assertAttribution(attribution: StartProcessRequest["attribution"]): void {
    for (const [name, value] of Object.entries(attribution)) {
      if (name === "leaseExpiresAt") continue;
      if (!value.trim()) throw new Error(`Execution attribution ${name} is required`);
    }
    this.assertActiveLease(attribution);
  }

  private assertActiveLease(attribution: StartProcessRequest["attribution"]): void {
    const expiry = Date.parse(attribution.leaseExpiresAt);
    if (!Number.isFinite(expiry) || expiry <= Date.parse(this.now())) throw new Error(`Execution lease ${attribution.leaseId} is expired`);
  }

  private assertPermissionPlatform(permissions: EffectivePermissionProfile): void {
    if (permissions.platform !== this.descriptor.platform) {
      throw new Error(`Permission profile platform ${permissions.platform} does not match Execution Node platform ${this.descriptor.platform}`);
    }
    if (!permissions.sources.length) throw new Error("Effective permission profile has no source layers");
  }

  private assertFileContext(context: CanonicalizePathRequest | ReadFileChunkRequest | WriteFileChunkRequest | ListDirectoryRequest | StatPathRequest): void {
    if (!context.requestId.trim()) throw new Error("File operation request id is required");
    this.assertAttribution(context.attribution);
    this.assertPermissionPlatform(context.permissions);
  }

  private async canonicalPath(path: string, access: "read" | "write", permissions: EffectivePermissionProfile): Promise<string> {
    if (!this.descriptor.capabilities.filesystem.canonicalize) throw new Error("Execution Node does not support path canonicalization");
    const api = permissions.platform === "windows" ? win32 : posix;
    if (!api.isAbsolute(path)) throw new Error(`Execution path must be absolute for ${permissions.platform}`);
    let canonical: string;
    if (access === "read") {
      canonical = await realpath(path);
    } else {
      try {
        canonical = await realpath(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const parent = await realpath(dirname(path));
        canonical = resolve(parent, api.basename(path));
      }
    }
    const materialized = await this.materializePermissionPaths(permissions);
    if (!allowsFileSystemPath(materialized, access, canonical)) throw new Error(`Effective permission profile denies ${access} access to ${canonical}`);
    return canonical;
  }

  private async materializePermissionPaths(permissions: EffectivePermissionProfile): Promise<EffectivePermissionProfile> {
    const materialize = async (grant: EffectivePermissionProfile["filesystem"]["read"][number]) => {
      try {
        return { ...grant, path: await realpath(grant.path) };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        try {
          return { ...grant, path: resolve(await realpath(dirname(grant.path)), (permissions.platform === "windows" ? win32 : posix).basename(grant.path)) };
        } catch {
          return grant;
        }
      }
    };
    return {
      ...permissions,
      filesystem: {
        read: await Promise.all(permissions.filesystem.read.map(materialize)),
        write: await Promise.all(permissions.filesystem.write.map(materialize)),
        deny: await Promise.all(permissions.filesystem.deny.map(materialize)),
      },
    };
  }

  private async materializeStartRequest(request: StartProcessRequest): Promise<StartProcessRequest> {
    const permissions = await this.materializePermissionPaths(request.permissions);
    return {
      ...structuredClone(request),
      executable: await realpath(request.executable),
      workingDirectory: await realpath(request.workingDirectory),
      permissions,
    };
  }

  private requireAccess(access: ProcessAccess): ProcessRecord {
    const record = this.records.get(access.processId);
    if (!record) throw new Error(`Unknown execution process ${access.processId}`);
    const received = hashToken(access.adoptionToken);
    if (received.length !== record.tokenHash.length || !timingSafeEqual(received, record.tokenHash)) throw new Error("Invalid process adoption token");
    return record;
  }

  private append(record: ProcessRecord, payload: EventPayload): void {
    const sequence = record.descriptor.lastEventSequence + 1;
    record.descriptor.lastEventSequence = sequence;
    record.descriptor.updatedAt = this.now();
    record.events.push({ ...payload, sequence, processId: record.descriptor.id, at: record.descriptor.updatedAt } as ProcessEvent);
    while (record.events.length > this.descriptor.limits.maximumRetainedEventsPerProcess) record.events.shift();
    for (const wake of [...record.waiters]) wake();
  }

  private captureOutput(record: ProcessRecord, stream: ProcessOutputStream, data: Buffer): void {
    if (["exited", "failed"].includes(record.descriptor.state)) return;
    const remaining = Math.max(0, record.outputLimitBytes - record.descriptor.capturedOutputBytes);
    const kept = data.subarray(0, remaining);
    if (kept.length) {
      record.descriptor.capturedOutputBytes += kept.length;
      this.append(record, { type: "process.output", stream, dataBase64: kept.toString("base64"), bytes: kept.length });
    }
    const omitted = data.length - kept.length;
    if (omitted > 0) {
      record.descriptor.omittedOutputBytes += omitted;
      if (!record.truncationEmitted) {
        record.truncationEmitted = true;
        this.append(record, { type: "process.output_truncated", outputLimitBytes: record.outputLimitBytes });
      }
    }
  }

  private finish(record: ProcessRecord, exitCode: number | null, signal: string | null): void {
    if (["exited", "failed"].includes(record.descriptor.state)) return;
    if (record.timeout) clearTimeout(record.timeout);
    record.timeout = null;
    const at = this.now();
    record.descriptor.state = "exited";
    record.descriptor.exitCode = exitCode;
    record.descriptor.exitSignal = signal;
    record.descriptor.exitedAt = at;
    record.descriptor.updatedAt = at;
    this.append(record, { type: "process.exited", exitCode, signal });
    this.persistObservation(record, "exit_observed");
  }

  private resourceLimitExceeded(record: ProcessRecord, resource: ResourceLimitKind): void {
    if (["exited", "failed"].includes(record.descriptor.state) || record.descriptor.resourceLimitExceeded) return;
    record.descriptor.resourceLimitExceeded = resource;
    record.descriptor.state = "terminating";
    this.append(record, { type: "process.resource_limit_exceeded", resource });
  }

  private fail(record: ProcessRecord, error: Error): void {
    if (["exited", "failed"].includes(record.descriptor.state)) return;
    if (record.timeout) clearTimeout(record.timeout);
    record.timeout = null;
    const at = this.now();
    record.descriptor.state = "failed";
    record.descriptor.exitedAt = at;
    record.descriptor.updatedAt = at;
    this.append(record, { type: "process.failed", error: error.message.slice(0, 4096) });
    this.persistObservation(record, "failure_observed");
  }

  private persistObservation(record: ProcessRecord, status: "exit_observed" | "failure_observed"): void {
    if (!this.processJournal) return;
    try {
      this.processJournal.settle({ ...record.observation, status, process: cloneDescriptor(record.descriptor),
        events: structuredClone(record.events), lostEvents: record.events[0]?.sequence !== 1, updatedAt: this.now() });
      record.observationPersisted = true;
    } catch {
      // Storage failure must leave the durable claim unresolved, never crash an event callback or invent a receipt.
    }
  }

  private pruneProcessHistory(): void {
    for (const [id, record] of this.records) {
      if (this.records.size + this.startingKeys.size <= this.maximumResidentProcesses) break;
      if (!record.observationPersisted || record.waiters.size || !["exited", "failed"].includes(record.descriptor.state)
        || Date.parse(this.now()) - Date.parse(record.descriptor.exitedAt!) < this.terminalRetentionMs) continue;
      // Durable claims are never deleted. A replay after eviction fails closed at journal.claim.
      this.records.delete(id);
      this.processByIdempotencyKey.delete(record.descriptor.attribution.idempotencyKey);
    }
  }
}
