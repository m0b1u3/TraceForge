import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  EXECUTION_PROTOCOL_VERSION,
  ExecutionNodeRpcClient,
  defaultExecutionRpcPipe,
  permissionProfileFingerprint,
  resourceLimitsFingerprint,
  type AdoptProcessRequest,
  type ProcessOperationKind,
  type ProcessOperationQuery,
  type ResizeProcessTerminalRequest,
  type SignalProcessRequest,
  type StartProcessRequest,
  type TerminateProcessRequest,
  type WriteProcessInputRequest,
} from "@traceforge/execution-node";
import { createDb, getSqliteClient } from "./db/client.js";
import { SqliteProcessOperationJournal } from "./execution-process-operation-journal.js";

const fixturePath = fileURLToPath(new URL("../test-fixtures/local-execution-operation-crash-host.mjs", import.meta.url));
const authToken = "traceforge-local-operation-fault-auth-token-000000000000";
const children = new Set<ChildProcessWithoutNullStreams>();
const directories: string[] = [];
const socketPaths = new Set<string>();

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await new Promise<void>((resolve) => child.once("close", () => resolve())).catch(() => undefined);
    }
  }
  children.clear();
  for (const path of socketPaths) {
    try { unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  socketPaths.clear();
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});

type Fault = "none" | "after-claim" | "after-complete";
interface Host {
  child: ChildProcessWithoutNullStreams;
  client: ExecutionNodeRpcClient;
  checkpoint: Promise<string>;
  stop(): Promise<void>;
}

function startHost(root: string, databasePath: string, effectLogPath: string, operation: ProcessOperationKind, fault: Fault): Promise<Host> {
  // Keep the Unix-domain socket short and in the conventional local runtime directory.
  // The database/effect files remain isolated in the case-specific temporary root.
  const address = defaultExecutionRpcPipe(`local-operation-${randomUUID()}`, process.platform === "win32" ? root : "/private/tmp");
  if (process.platform !== "win32") socketPaths.add(address.path);
  const configPath = join(root, `host-${randomUUID()}.json`);
  writeFileSync(configPath, JSON.stringify({ databasePath, effectLogPath, operation, fault, authToken,
    nodeId: "local-operation-node", pipePath: address.path }));
  const child = spawn(process.execPath, ["--import", "tsx", fixturePath, configPath], { stdio: ["pipe", "pipe", "pipe"] });
  children.add(child);
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  let resolveCheckpoint!: (phase: string) => void;
  const checkpoint = new Promise<string>((resolve) => { resolveCheckpoint = resolve; });
  return new Promise<Host>((resolve, reject) => {
    let stdout = "";
    const timer = setTimeout(() => reject(new Error(`Fault host readiness timed out: ${stderr}`)), 10_000);
    const fail = () => { clearTimeout(timer); reject(new Error(`Fault host exited before readiness: ${stderr}`)); };
    child.once("close", fail);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      for (;;) {
        const newline = stdout.indexOf("\n");
        if (newline < 0) break;
        const line = stdout.slice(0, newline); stdout = stdout.slice(newline + 1);
        const message = JSON.parse(line) as { ready?: boolean; checkpoint?: string };
        if (message.checkpoint) resolveCheckpoint(message.checkpoint);
        if (message.ready) {
          clearTimeout(timer); child.off("close", fail);
          const client = new ExecutionNodeRpcClient(address, { authToken, connectTimeoutMs: 5_000, requestTimeoutMs: 10_000 });
          resolve({ child, client, checkpoint, async stop() {
            client.disconnect();
            if (child.exitCode !== null || child.signalCode !== null) return;
            child.kill("SIGTERM");
            await new Promise<void>((done) => child.once("close", () => done()));
          } });
        }
      }
    });
  });
}

function platform(): StartProcessRequest["permissions"]["platform"] {
  return process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
}

function startRequest(root: string): StartProcessRequest {
  const permissions: StartProcessRequest["permissions"] = {
    version: 1,
    platform: platform(),
    filesystem: { read: [{ path: dirname(process.execPath), scope: "tree" }, { path: root, scope: "tree" }], write: [], deny: [] },
    network: "deny",
    process: { access: "sandboxed", interactive: true, background: false },
    secrets: "deny",
    sources: ["fault-matrix-test"],
  };
  const resources = { cpuTimeMs: 5_000, memoryBytes: 128 * 1024 * 1024, maximumProcesses: 1, writeBytes: 1024 * 1024 };
  expect(permissionProfileFingerprint(permissions)).toMatch(/^[a-f0-9]{64}$/);
  expect(resourceLimitsFingerprint(resources)).toMatch(/^[a-f0-9]{64}$/);
  return {
    requestId: "start-request",
    attribution: { caseId: "case", runId: "run", workId: "work", workerId: "worker", scopeRef: "scope",
      leaseId: "lease", leaseExpiresAt: "2099-01-01T00:00:00.000Z", actionId: "action", idempotencyKey: "start-effect" },
    executable: process.execPath,
    arguments: ["--version"],
    workingDirectory: root,
    environment: {},
    stdin: "pipe",
    terminal: { columns: 80, rows: 24 },
    timeoutMs: 60_000,
    outputLimitBytes: 1024,
    resources,
    permissions,
  };
}

type OperationRequest = WriteProcessInputRequest | ResizeProcessTerminalRequest | SignalProcessRequest | TerminateProcessRequest | AdoptProcessRequest;

function requestFor(operation: ProcessOperationKind, processId: string, adoptionToken: string): OperationRequest {
  const access = { operationId: `operation-${operation}`, processId, adoptionToken };
  switch (operation) {
    case "process.writeInput": return { ...access, dataBase64: Buffer.from("input").toString("base64"), closeAfterWrite: false };
    case "process.resizeTerminal": return { ...access, columns: 120, rows: 40 };
    case "process.signal": return { ...access, signal: "interrupt" };
    case "process.terminate": return { ...access, force: true };
    case "process.adopt": return { ...access, attribution: { caseId: "case", runId: "run", workId: "work", workerId: "replacement",
      scopeRef: "scope", leaseId: "replacement-lease", leaseExpiresAt: "2099-01-01T00:00:00.000Z",
      actionId: "replacement-action", idempotencyKey: "replacement-effect" } };
  }
}

function invoke(client: ExecutionNodeRpcClient, operation: ProcessOperationKind, request: OperationRequest) {
  switch (operation) {
    case "process.writeInput": return client.writeProcessInput(request as WriteProcessInputRequest);
    case "process.resizeTerminal": return client.resizeProcessTerminal(request as ResizeProcessTerminalRequest);
    case "process.signal": return client.signalProcess(request as SignalProcessRequest);
    case "process.terminate": return client.terminateProcess(request as TerminateProcessRequest);
    case "process.adopt": return client.adoptProcess(request as AdoptProcessRequest);
  }
}

function queryFor(operation: ProcessOperationKind, request: OperationRequest): ProcessOperationQuery {
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
    return JSON.stringify(value);
  };
  return { operationId: request.operationId, operation, processId: request.processId,
    requestFingerprint: createHash("sha256").update(canonical(request)).digest("hex") };
}

function effects(path: string, operation: ProcessOperationKind): unknown[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { operation: string })
    .filter((entry) => entry.operation === operation);
}

const operations: ProcessOperationKind[] = [
  "process.writeInput", "process.resizeTerminal", "process.signal", "process.terminate", "process.adopt",
];

describe.skipIf(process.platform === "win32")("Local Execution Node operation crash matrix", () => {
  it.each(operations)("keeps %s claim-only outcomes unconfirmed and never guesses or repeats the side effect", async (operation) => {
    const root = mkdtempSync(join(tmpdir(), "traceforge-local-operation-")); directories.push(root);
    const databasePath = join(root, "operations.sqlite"); const effectLogPath = join(root, "effects.ndjson");
    const crashed = await startHost(root, databasePath, effectLogPath, operation, "after-claim");
    await crashed.client.handshake({ clientId: "fault-client", protocol: EXECUTION_PROTOCOL_VERSION,
      requiredCapabilities: ["process.spawn", "process.tty", "process.adopt", "process.operation_observation"] });
    const started = await crashed.client.startProcess(startRequest(root));
    const request = requestFor(operation, started.process.id, started.adoptionToken);
    const pending = invoke(crashed.client, operation, request);
    expect(await crashed.checkpoint).toBe("after-claim");
    crashed.child.kill("SIGKILL");
    await expect(pending).rejects.toThrow();
    if (crashed.child.exitCode === null && crashed.child.signalCode === null) {
      await new Promise<void>((resolve) => crashed.child.once("close", () => resolve()));
    }
    expect(effects(effectLogPath, operation)).toHaveLength(0);

    const restarted = await startHost(root, databasePath, effectLogPath, operation, "none");
    await expect(invoke(restarted.client, operation, request)).rejects.toThrow(/outcome is unconfirmed/);
    expect(await restarted.client.lookupProcessOperation(queryFor(operation, request))).toMatchObject({ state: "claimed", response: null });
    expect(effects(effectLogPath, operation)).toHaveLength(0);
    await restarted.stop();
  });

  it.each(operations)("replays committed %s results after response loss without repeating the side effect", async (operation) => {
    const root = mkdtempSync(join(tmpdir(), "traceforge-local-operation-")); directories.push(root);
    const databasePath = join(root, "operations.sqlite"); const effectLogPath = join(root, "effects.ndjson");
    const crashed = await startHost(root, databasePath, effectLogPath, operation, "after-complete");
    const started = await crashed.client.startProcess(startRequest(root));
    const request = requestFor(operation, started.process.id, started.adoptionToken);
    const pending = invoke(crashed.client, operation, request);
    expect(await crashed.checkpoint).toBe("after-complete");
    crashed.child.kill("SIGKILL");
    await expect(pending).rejects.toThrow();
    if (crashed.child.exitCode === null && crashed.child.signalCode === null) {
      await new Promise<void>((resolve) => crashed.child.once("close", () => resolve()));
    }
    expect(effects(effectLogPath, operation)).toHaveLength(1);

    const restarted = await startHost(root, databasePath, effectLogPath, operation, "none");
    const observation = await restarted.client.lookupProcessOperation(queryFor(operation, request));
    expect(observation).toMatchObject({ state: "completed" });
    expect(await invoke(restarted.client, operation, request)).toEqual(observation!.response);
    expect(effects(effectLogPath, operation)).toHaveLength(1);
    await restarted.stop();

    const sqlite = getSqliteClient(createDb(databasePath));
    expect(new SqliteProcessOperationJournal(sqlite).get(request.operationId)).toEqual(observation);
    expect(sqlite.pragma("integrity_check", { simple: true })).toBe("ok");
    sqlite.close();
  });
});
