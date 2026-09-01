import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import { describe, expect, it } from "vitest";
import type { EffectivePermissionProfile } from "@traceforge/orchestration-core";
import {
  LocalExecutionNode,
  NodeSpawnProcessLauncher,
  type SpawnLaunchSpec,
  type LaunchedProcess,
  type ManagedProcess,
  type ProcessLauncher,
} from "./runtime.js";
import type {
  ExecutionAttribution,
  ProcessEnforcementAttestation,
  ProcessOutputStream,
  ProcessSignal,
  StartProcessRequest,
} from "./protocol.js";
import { permissionProfileFingerprint, resourceLimitsFingerprint, type ResourceLimitKind } from "./protocol.js";

function stdioLauncher(script: string, customTerminate?: SpawnLaunchSpec["terminate"]) {
  return new NodeSpawnProcessLauncher((request) => ({
    executable: process.execPath, arguments: ["-e", script], workingDirectory: request.workingDirectory,
    environment: {}, detached: false, windowsHide: true, terminate: customTerminate,
    enforcement: { sandboxBackend: "test-sandbox", sandboxed: true, filesystemPolicyApplied: true,
      permissionProfileFingerprint: permissionProfileFingerprint(request.permissions), resourceLimitsApplied: true,
      resourceLimitsFingerprint: resourceLimitsFingerprint(request.resources), network: "deny" },
  }), { operationTimeoutMs: 100, shutdownTimeoutMs: 100, startupTimeoutMs: 1000 });
}

class FakeProcess implements ManagedProcess {
  readonly pid = 4242;
  inputs: Buffer[] = [];
  closed = false;
  signals: ProcessSignal[] = [];
  terminations: boolean[] = [];
  terminalSizes: Array<{ columns: number; rows: number }> = [];
  private outputListeners: Array<(stream: ProcessOutputStream, data: Buffer) => void> = [];
  private exitListeners: Array<(exitCode: number | null, signal: string | null) => void> = [];
  private errorListeners: Array<(error: Error) => void> = [];
  private resourceLimitListeners: Array<(resource: ResourceLimitKind) => void> = [];

  onOutput(listener: (stream: ProcessOutputStream, data: Buffer) => void) { this.outputListeners.push(listener); }
  onExit(listener: (exitCode: number | null, signal: string | null) => void) { this.exitListeners.push(listener); }
  onError(listener: (error: Error) => void) { this.errorListeners.push(listener); }
  onResourceLimit(listener: (resource: ResourceLimitKind) => void) { this.resourceLimitListeners.push(listener); }
  async writeInput(data: Buffer) { this.inputs.push(Buffer.from(data)); }
  async closeInput() { this.closed = true; }
  async resizeTerminal(columns: number, rows: number) { this.terminalSizes.push({ columns, rows }); }
  async sendSignal(signal: ProcessSignal) { this.signals.push(signal); }
  async terminate(force: boolean) { this.terminations.push(force); }
  output(stream: ProcessOutputStream, value: string) { for (const listener of this.outputListeners) listener(stream, Buffer.from(value)); }
  exit(code: number | null, signal: string | null = null) { for (const listener of this.exitListeners) listener(code, signal); }
  error(error: Error) { for (const listener of this.errorListeners) listener(error); }
  exceed(resource: ResourceLimitKind) { for (const listener of this.resourceLimitListeners) listener(resource); }
}

class FakeLauncher implements ProcessLauncher {
  readonly processes: FakeProcess[] = [];
  requests: StartProcessRequest[] = [];
  enforcement: ProcessEnforcementAttestation = {
    sandboxBackend: "test-sandbox", sandboxed: true, filesystemPolicyApplied: true,
    permissionProfileFingerprint: "", resourceLimitsApplied: true, resourceLimitsFingerprint: "", network: "deny",
  };
  fingerprintOverride?: string;
  resourceFingerprintOverride?: string;

  async launch(request: StartProcessRequest): Promise<LaunchedProcess> {
    this.requests.push(request);
    this.enforcement.permissionProfileFingerprint = this.fingerprintOverride ?? permissionProfileFingerprint(request.permissions);
    this.enforcement.resourceLimitsFingerprint = this.resourceFingerprintOverride ?? resourceLimitsFingerprint(request.resources);
    const process = new FakeProcess();
    this.processes.push(process);
    return { process, enforcement: { ...this.enforcement } };
  }
}

const platform: EffectivePermissionProfile["platform"] = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
const at = "2026-08-25T08:00:00.000Z";

function attribution(patch: Partial<ExecutionAttribution> = {}): ExecutionAttribution {
  return {
    caseId: "case_1", runId: "run_1", workId: "work_1", workerId: "worker_1", scopeRef: "scope_1",
    leaseId: "lease_1", leaseExpiresAt: "2026-08-25T09:00:00.000Z", actionId: "action_1", idempotencyKey: "effect_1",
    ...patch,
  };
}

function permissions(readRoots: string[], writeRoots: string[] = []): EffectivePermissionProfile {
  return {
    version: 1,
    platform,
    filesystem: {
      read: readRoots.map((path) => ({ path, scope: "tree" as const })),
      write: writeRoots.map((path) => ({ path, scope: "tree" as const })),
      deny: [],
    },
    network: "deny",
    process: { access: "sandboxed", interactive: false, background: false },
    secrets: "deny",
    sources: ["test"],
  };
}

function createNode(launcher = new FakeLauncher()) {
  return {
    launcher,
    node: new LocalExecutionNode(launcher, {
      id: "node_1", platform, architecture: "test", now: () => at, sandboxBackends: ["test-sandbox"],
      maximumProcesses: 4, maximumOutputBytesPerProcess: 64, maximumRetainedEventsPerProcess: 4,
      maximumFileChunkBytes: 16, maximumListEntries: 2,
      maximumCpuTimeMsPerProcess: 60_000, maximumMemoryBytesPerProcess: 1024 * 1024 * 1024,
      maximumProcessesPerExecution: 16, maximumWriteBytesPerProcess: 1024 * 1024,
      capabilities: { process: { spawn: true, stdio: true, tty: false, adoption: true, resourceLimits: true, signals: ["interrupt", "terminate", "kill"] } },
    }),
  };
}

function startRequest(workspace: string): StartProcessRequest {
  return {
    requestId: "request_1",
    attribution: attribution(),
    executable: process.execPath,
    arguments: ["--version"],
    workingDirectory: workspace,
    environment: {},
    stdin: "pipe",
    timeoutMs: 60_000,
    outputLimitBytes: 4,
    resources: { cpuTimeMs: 30_000, memoryBytes: 256 * 1024 * 1024, maximumProcesses: 8, writeBytes: 1024 * 1024 },
    permissions: permissions([dirname(process.execPath), workspace]),
  };
}

describe("LocalExecutionNode process lifecycle", () => {
  it("reserves capacity across concurrent launches and does not evict history without a durable journal", async () => {
    const launcher = new FakeLauncher();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const launch = launcher.launch.bind(launcher);
    let entering = false;
    launcher.launch = async (request) => { entering = true; await gate; return launch(request); };
    const node = new LocalExecutionNode(launcher, { platform, now: () => at, sandboxBackends: ["test-sandbox"],
      maximumProcesses: 1, maximumResidentProcesses: 1, terminalRetentionMs: 0,
      capabilities: { process: { spawn: true, stdio: true, tty: false, adoption: true, resourceLimits: true, signals: ["kill"] } } });
    const request = startRequest(dirname(process.execPath));
    const pending = node.startProcess(request);
    await expect.poll(() => entering).toBe(true);
    const second = { ...request, attribution: { ...request.attribution, idempotencyKey: "second" } };
    await expect(node.startProcess(second)).rejects.toThrow("startup capacity");
    release();
    const started = await pending;
    launcher.processes[0].exit(0);
    await expect(node.startProcess(second)).rejects.toThrow("history capacity");
    expect(await node.startProcess(request)).toMatchObject({ replayed: true, process: { id: started.process.id } });
    expect(launcher.requests).toHaveLength(1);
  });

  it("bounds process observation waiters and releases them on terminal notification", async () => {
    const { node, launcher } = createNode();
    const started = await node.startProcess(startRequest(dirname(process.execPath)));
    const query = { processId: started.process.id, adoptionToken: started.adoptionToken, afterSequence: started.process.lastEventSequence, maximumEvents: 16 };
    const waiters = Array.from({ length: 64 }, () => node.waitProcessEvents(query, 1000));
    await expect(node.waitProcessEvents(query, 1000)).rejects.toThrow("waiter capacity");
    launcher.processes[0].exit(0);
    expect((await Promise.all(waiters)).every((result) => result.process.state === "exited")).toBe(true);
  });

  it("rejects oversized process metadata before dispatch", async () => {
    const { node, launcher } = createNode();
    await expect(node.startProcess({ ...startRequest(dirname(process.execPath)), arguments: ["x".repeat(128 * 1024)] })).rejects.toThrow("size limit");
    expect(launcher.requests).toHaveLength(0);
  });

  it("bounds a real blocked stdio write without waiting forever for drain", async () => {
    const { process: managed } = await stdioLauncher("setInterval(() => {}, 1000)").launch(startRequest(dirname(process.execPath)));
    const errors: string[] = [];
    managed.onError((error) => errors.push(error.message));
    const exit = new Promise((resolve) => managed.onExit(resolve));
    await expect(managed.writeInput(Buffer.alloc(4 * 1024 * 1024))).rejects.toThrow(/input write timed out/);
    expect(await exit).toBeNull();
    expect(errors).toHaveLength(1);
  });

  it("bounds a termination adapter that never resolves", async () => {
    const { process: managed } = await stdioLauncher("setInterval(() => {}, 1000)", () => new Promise<void>(() => undefined))
      .launch(startRequest(dirname(process.execPath)));
    const exit = new Promise((resolve) => managed.onExit(resolve));
    await expect(managed.terminate(true)).rejects.toThrow(/timed out/);
    expect(await exit).toBeNull();
  });

  it("does not mistake termination acceptance for process exit", async () => {
    const { process: managed } = await stdioLauncher("setInterval(() => {}, 1000)", () => undefined)
      .launch(startRequest(dirname(process.execPath)));
    const errors: string[] = [];
    managed.onError((error) => errors.push(error.message));
    const exit = new Promise((resolve) => managed.onExit(resolve));
    await managed.terminate(true);
    expect(await exit).toBeNull();
    expect(errors[0]).toMatch(/shutdown/);
  });

  it("bounds pipe drain when the root exits but a descendant holds its output", async () => {
    // Finite descendant exits itself; only local transport is closed by the watchdog, not an invented tree kill.
    const script = `require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 400)'], { stdio: ['ignore', 1, 2] }); process.exit(0);`;
    const { process: managed } = await stdioLauncher(script).launch(startRequest(dirname(process.execPath)));
    const errors: string[] = [];
    managed.onError((error) => errors.push(error.message));
    expect(await new Promise((resolve) => managed.onExit(resolve))).toBeNull();
    expect(errors[0]).toMatch(/shutdown or pipe drain/);
    await new Promise((resolve) => setTimeout(resolve, 450));
  });

  it("reports spawn errors as launch rejection without an unhandled child error", async () => {
    const native = new NodeSpawnProcessLauncher(() => ({
      executable: join(tmpdir(), "traceforge-nonexistent-executable"), arguments: [], workingDirectory: tmpdir(),
      environment: {}, detached: false, windowsHide: true, enforcement: new FakeLauncher().enforcement,
    }));
    await expect(native.launch(startRequest(tmpdir()))).rejects.toThrow(/ENOENT/);
  });

  it("replays buffered helper failure before exit instead of publishing success", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "traceforge-buffered-exit-"));
    class BufferedFailureLauncher extends FakeLauncher {
      override async launch(request: StartProcessRequest): Promise<LaunchedProcess> {
        const launched = await super.launch(request);
        launched.process.onError = (listener) => listener(new Error("helper cleanup failed"));
        launched.process.onExit = (listener) => listener(0, null);
        return launched;
      }
    }
    const { node } = createNode(new BufferedFailureLauncher());
    const started = await node.startProcess(startRequest(workspace));
    const result = await node.readProcessEvents({ processId: started.process.id, adoptionToken: started.adoptionToken, afterSequence: 0, maximumEvents: 10 });
    expect(result.process.state).toBe("failed");
    expect(result.events.map((event) => event.type)).toEqual(["process.started", "process.failed"]);
  });

  it("streams bounded output, replays idempotent start, and rotates ownership on adoption", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "traceforge-exec-"));
    const { node, launcher } = createNode();
    const request = startRequest(workspace);
    const started = await node.startProcess(request);
    const replay = await node.startProcess(request);
    expect(replay).toMatchObject({ replayed: true, adoptionToken: started.adoptionToken });
    expect(launcher.processes).toHaveLength(1);

    launcher.processes[0]!.output("stdout", "abcdef");
    const events = await node.readProcessEvents({ processId: started.process.id, adoptionToken: started.adoptionToken, afterSequence: 0, maximumEvents: 10 });
    expect(events.process).toMatchObject({ capturedOutputBytes: 4, omittedOutputBytes: 2 });
    expect(events.events.map((event) => event.type)).toEqual(["process.started", "process.output", "process.output_truncated"]);
    expect(Buffer.from((events.events[1] as { dataBase64: string }).dataBase64, "base64").toString()).toBe("abcd");

    await node.writeProcessInput({ processId: started.process.id, adoptionToken: started.adoptionToken, dataBase64: Buffer.from("input").toString("base64") });
    expect(launcher.processes[0]!.inputs[0]!.toString()).toBe("input");
    const adopted = await node.adoptProcess({
      processId: started.process.id,
      adoptionToken: started.adoptionToken,
      attribution: attribution({ workerId: "worker_2", leaseId: "lease_2", idempotencyKey: "effect_2" }),
    });
    expect(adopted.process.attribution.workerId).toBe("worker_2");
    await expect(node.describeProcess({ processId: started.process.id, adoptionToken: started.adoptionToken })).rejects.toThrow(/Invalid process adoption token/);
    expect((await node.describeProcess({ processId: started.process.id, adoptionToken: adopted.adoptionToken })).id).toBe(started.process.id);

    const waiting = node.waitProcessEvents({ processId: started.process.id, adoptionToken: adopted.adoptionToken, afterSequence: 3, maximumEvents: 10 }, 1_000);
    launcher.processes[0]!.exit(0);
    expect((await waiting).events.at(-1)).toMatchObject({ type: "process.exited", exitCode: 0 });
  });

  it("terminates a launched process when its enforcement attestation exceeds permission", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "traceforge-exec-"));
    const launcher = new FakeLauncher();
    launcher.enforcement.network = "direct";
    const { node } = createNode(launcher);
    await expect(node.startProcess(startRequest(workspace))).rejects.toThrow(/exceeds effective permission/);
    expect(launcher.processes[0]!.terminations).toEqual([true]);
  });

  it("terminates a launched process when its policy proof belongs to another permission profile", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "traceforge-proof-"));
    const launcher = new FakeLauncher();
    launcher.fingerprintOverride = "0".repeat(64);
    const { node } = createNode(launcher);
    await expect(node.startProcess(startRequest(workspace))).rejects.toThrow(/proof does not match/);
    expect(launcher.processes[0]!.terminations).toEqual([true]);
  });

  it("rejects a launcher whose resource proof differs from the requested process-tree limits", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "traceforge-resource-proof-"));
    const launcher = new FakeLauncher();
    launcher.resourceFingerprintOverride = "0".repeat(64);
    const { node } = createNode(launcher);
    await expect(node.startProcess(startRequest(workspace))).rejects.toThrow(/resource-limit proof does not match/);
    expect(launcher.processes[0]!.terminations).toEqual([true]);
  });

  it("records a trusted resource-limit event before the process exits", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "traceforge-resource-event-"));
    const { node, launcher } = createNode();
    const started = await node.startProcess(startRequest(workspace));
    launcher.processes[0]!.exceed("memory");
    launcher.processes[0]!.exit(137);
    const result = await node.readProcessEvents({
      processId: started.process.id, adoptionToken: started.adoptionToken, afterSequence: 0, maximumEvents: 10,
    });
    expect(result.process.resourceLimitExceeded).toBe("memory");
    expect(result.events.map((event) => event.type)).toEqual([
      "process.started", "process.resource_limit_exceeded", "process.exited",
    ]);
  });

  it("resizes only PTY-backed processes within bounded terminal dimensions", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "traceforge-pty-"));
    const launcher = new FakeLauncher();
    const node = new LocalExecutionNode(launcher, {
      id: "node_pty",
      platform,
      architecture: "test",
      now: () => at,
      sandboxBackends: ["test-sandbox"],
      capabilities: {
        process: {
          spawn: true,
          stdio: true,
          tty: true,
          adoption: true,
          resourceLimits: true,
          signals: ["interrupt", "terminate", "kill"],
        },
      },
    });
    const request = startRequest(workspace);
    request.terminal = { columns: 80, rows: 24, terminalType: "xterm-256color" };
    request.permissions.process.interactive = true;
    const started = await node.startProcess(request);

    const resized = await node.resizeProcessTerminal({
      processId: started.process.id,
      adoptionToken: started.adoptionToken,
      columns: 132,
      rows: 43,
    });
    expect(resized.terminal).toMatchObject({ columns: 132, rows: 43, terminalType: "xterm-256color" });
    expect(launcher.processes[0]!.terminalSizes).toEqual([{ columns: 132, rows: 43 }]);
    await expect(node.resizeProcessTerminal({
      processId: started.process.id,
      adoptionToken: started.adoptionToken,
      columns: 0,
      rows: 43,
    })).rejects.toThrow(/dimensions/);
  });
});

describe("LocalExecutionNode filesystem gateway", () => {
  it("canonicalizes paths, enforces grants, chunks reads, and deduplicates writes", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "traceforge-files-"));
    const privateDirectory = join(workspace, "private");
    await mkdir(privateDirectory);
    const source = join(workspace, "source.txt");
    await writeFile(source, "abcdef", "utf8");
    const profile = permissions([workspace], [workspace]);
    profile.filesystem.deny.push({ path: privateDirectory, scope: "tree" });
    const { node } = createNode();
    const context = { requestId: "file_1", attribution: attribution(), permissions: profile };

    const chunk = await node.readFileChunk({ ...context, path: source, offset: 2, length: 3 });
    expect(Buffer.from(chunk.dataBase64, "base64").toString()).toBe("cde");
    const target = join(workspace, "output.txt");
    const request = { ...context, requestId: "write_1", path: target, offset: 0, dataBase64: Buffer.from("result").toString("base64"), create: true, truncate: true };
    const written = await node.writeFileChunk(request);
    const replay = await node.writeFileChunk(request);
    expect(written).toMatchObject({ bytesWritten: 6, replayed: false });
    expect(replay.replayed).toBe(true);
    expect(await readFile(target, "utf8")).toBe("result");

    const listing = await node.listDirectory({ ...context, requestId: "list_1", path: workspace, maximumEntries: 2 });
    expect(listing.entries).toHaveLength(2);
    expect(listing.omittedEntries).toBe(1);
    await expect(node.statPath({ ...context, requestId: "stat_private", path: privateDirectory })).rejects.toThrow(/denies read access/);
  });

  it("does not allow a grant on one root to escape through a canonicalized path", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "traceforge-root-"));
    const outside = parse(workspace).root;
    const { node } = createNode();
    await expect(node.canonicalizePath({
      requestId: "canonical_1",
      attribution: attribution(),
      permissions: permissions([workspace]),
      path: outside,
      access: "read",
    })).rejects.toThrow(/denies read access/);
  });
});
