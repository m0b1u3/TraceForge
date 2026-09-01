import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { EffectivePermissionProfile } from "@traceforge/orchestration-core";
import type { ManagedProcess, ProcessLauncher } from "./runtime.js";
import { LocalExecutionNode } from "./runtime.js";
import { BrokeredHttpGateway } from "./network-broker.js";
import {
  EXECUTION_PROTOCOL_VERSION,
  permissionProfileFingerprint,
  resourceLimitsFingerprint,
  type ExecutionAttribution,
  type ProcessOutputStream,
  type ProcessSignal,
  type ResourceLimitKind,
  type StartProcessRequest,
} from "./protocol.js";
import {
  ExecutionFrameDecoder,
  ExecutionNodeRpcClient,
  ExecutionNodeRpcServer,
  ExecutionRpcDispatcher,
  ExecutionRpcRemoteError,
  createExecutionRpcAuthToken,
  defaultExecutionRpcPipe,
  encodeExecutionFrame,
} from "./rpc.js";

class RpcTestProcess implements ManagedProcess {
  readonly pid = 7331;
  private outputListeners: Array<(stream: ProcessOutputStream, data: Buffer) => void> = [];
  private exitListeners: Array<(exitCode: number | null, signal: string | null) => void> = [];
  private errorListeners: Array<(error: Error) => void> = [];
  onOutput(listener: (stream: ProcessOutputStream, data: Buffer) => void) { this.outputListeners.push(listener); }
  onExit(listener: (exitCode: number | null, signal: string | null) => void) { this.exitListeners.push(listener); }
  onError(listener: (error: Error) => void) { this.errorListeners.push(listener); }
  onResourceLimit(_listener: (resource: ResourceLimitKind) => void) {}
  async writeInput(_data: Buffer) {}
  async closeInput() {}
  async resizeTerminal(_columns: number, _rows: number) {}
  async sendSignal(_signal: ProcessSignal) {}
  async terminate(_force: boolean) {}
  output(value: string) { for (const listener of this.outputListeners) listener("stdout", Buffer.from(value)); }
  exit(code: number) { for (const listener of this.exitListeners) listener(code, null); }
}

class RpcTestLauncher implements ProcessLauncher {
  readonly processes: RpcTestProcess[] = [];
  async launch(request: StartProcessRequest) {
    const process = new RpcTestProcess();
    this.processes.push(process);
    return {
      process,
      enforcement: {
        sandboxBackend: "rpc-test", sandboxed: true, filesystemPolicyApplied: true,
        permissionProfileFingerprint: permissionProfileFingerprint(request.permissions),
        resourceLimitsApplied: true, resourceLimitsFingerprint: resourceLimitsFingerprint(request.resources), network: "deny" as const,
      },
    };
  }
}

const platform: EffectivePermissionProfile["platform"] = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
const now = "2026-08-26T08:00:00.000Z";

function attribution(patch: Partial<ExecutionAttribution> = {}): ExecutionAttribution {
  return {
    caseId: "case_rpc", runId: "run_rpc", workId: "work_rpc", workerId: "worker_1", scopeRef: "scope_rpc",
    leaseId: "lease_1", leaseExpiresAt: "2026-08-26T09:00:00.000Z", actionId: "action_1", idempotencyKey: "effect_rpc",
    ...patch,
  };
}

function permissions(workspace: string): EffectivePermissionProfile {
  return {
    version: 1,
    platform,
    filesystem: {
      read: [{ path: dirname(process.execPath), scope: "tree" }, { path: workspace, scope: "tree" }],
      write: [],
      deny: [],
    },
    network: "deny",
    process: { access: "sandboxed", interactive: false, background: false },
    secrets: "deny",
    sources: ["rpc-test"],
  };
}

function request(workspace: string): StartProcessRequest {
  return {
    requestId: "request_rpc",
    attribution: attribution(),
    executable: process.execPath,
    arguments: ["--version"],
    workingDirectory: workspace,
    environment: {},
    stdin: "closed",
    timeoutMs: 60_000,
    outputLimitBytes: 1024,
    resources: { cpuTimeMs: 30_000, memoryBytes: 256 * 1024 * 1024, maximumProcesses: 8, writeBytes: 1024 * 1024 },
    permissions: permissions(workspace),
  };
}

function fixture() {
  const launcher = new RpcTestLauncher();
  const httpBroker = new BrokeredHttpGateway({
    now: () => now,
    authorizer: { authorize: () => ({
      authorizationRef: "scope_rpc", canonicalUrl: "https://authorized.example/",
      expiresAt: "2026-08-26T09:00:00.000Z",
    }) },
    transport: async () => ({ status: 200, headers: [{ name: "content-type", value: "text/plain" }], body: Buffer.from("brokered"), bodyTruncated: false }),
  });
  const node = new LocalExecutionNode(launcher, {
    id: "rpc_node",
    platform,
    architecture: "test",
    now: () => now,
    sandboxBackends: ["rpc-test"],
    maximumProcesses: 4,
    maximumOutputBytesPerProcess: 4096,
    maximumRetainedEventsPerProcess: 32,
    maximumCpuTimeMsPerProcess: 60_000,
    maximumMemoryBytesPerProcess: 1024 * 1024 * 1024,
    maximumProcessesPerExecution: 16,
    maximumWriteBytesPerProcess: 64 * 1024 * 1024,
    httpBroker,
    capabilities: { process: { spawn: true, stdio: true, tty: false, adoption: true, resourceLimits: true, signals: ["interrupt", "terminate", "kill"] } },
  });
  return { launcher, node };
}

describe("Execution RPC framing", () => {
  it("decodes fragmented and coalesced frames without relying on packet boundaries", () => {
    const first = encodeExecutionFrame({ id: 1 }, 1024);
    const second = encodeExecutionFrame({ id: 2 }, 1024);
    const decoder = new ExecutionFrameDecoder(1024);
    expect(decoder.push(first.subarray(0, 3))).toEqual([]);
    const decoded = decoder.push(Buffer.concat([first.subarray(3), second]));
    expect(decoded.map((frame) => JSON.parse(frame.toString("utf8")))).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("rejects oversized frames before allocating their declared payload", () => {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(4097);
    expect(() => new ExecutionFrameDecoder(4096).push(header)).toThrow(/frame length/);
  });
});

describe("Execution Node RPC transport", () => {
  it("bounds a silent peer, ignores late responses and keeps subsequent request identities separate", async () => {
    const { node } = fixture(); const original = node.handshake.bind(node);
    let release!: () => void; let calls = 0;
    vi.spyOn(node, "handshake").mockImplementation(async (input) => { calls++; if (calls === 1) await new Promise<void>((r) => { release = r; }); return original(input); });
    const token = createExecutionRpcAuthToken(), server = new ExecutionNodeRpcServer(new ExecutionRpcDispatcher(node), { authToken: token });
    const address = await server.listen({ kind: "tcp", host: "127.0.0.1", port: 0 });
    const client = new ExecutionNodeRpcClient(address, { authToken: token, requestTimeoutMs: 30 });
    const input = { clientId: "first", protocol: EXECUTION_PROTOCOL_VERSION, requiredCapabilities: [] };
    try {
      await expect(client.handshake(input)).rejects.toThrow("outcome is unconfirmed");
      release(); expect((await client.handshake({ ...input, clientId: "second" })).node.id).toBe("rpc_node"); expect(calls).toBe(2);
    } finally { client.disconnect(); await server.close(); }
  });
  it("rejects excess pending RPC calls without sending them", async () => {
    const { node } = fixture(); let release!: () => void; let started!: () => void;
    const ready = new Promise<void>((r) => { started = r; }), original = node.handshake.bind(node);
    const spy = vi.spyOn(node, "handshake").mockImplementation(async (input) => { started(); await new Promise<void>((r) => { release = r; }); return original(input); });
    const token = createExecutionRpcAuthToken(), server = new ExecutionNodeRpcServer(new ExecutionRpcDispatcher(node), { authToken: token });
    const address = await server.listen({ kind: "tcp", host: "127.0.0.1", port: 0 });
    const client = new ExecutionNodeRpcClient(address, { authToken: token, maximumPendingRequests: 1, requestTimeoutMs: 1000 });
    const input = { clientId: "first", protocol: EXECUTION_PROTOCOL_VERSION, requiredCapabilities: [] };
    try { const first = client.handshake(input); await ready; await expect(client.handshake(input)).rejects.toThrow("capacity"); release(); await first; expect(spy).toHaveBeenCalledTimes(1); }
    finally { client.disconnect(); await server.close(); }
  });
  it("supports authenticated concurrent calls, reconnect, and process adoption over loopback", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "traceforge-rpc-"));
    const { launcher, node } = fixture();
    const token = createExecutionRpcAuthToken();
    const server = new ExecutionNodeRpcServer(new ExecutionRpcDispatcher(node), { authToken: token, maximumFrameBytes: 1024 * 1024 });
    const address = await server.listen({ kind: "tcp", host: "127.0.0.1", port: 0 });
    const client = new ExecutionNodeRpcClient(address, { authToken: token });
    try {
      const handshake = await client.handshake({
        clientId: "controller_rpc", protocol: EXECUTION_PROTOCOL_VERSION, requiredCapabilities: ["process.spawn", "process.adopt", "network.brokered", "http.request"],
      });
      expect(handshake.node.id).toBe("rpc_node");
      const networkPermissions = permissions(workspace);
      networkPermissions.network = "brokered";
      const brokered = await client.requestHttp({
        requestId: "http_rpc", attribution: attribution({ idempotencyKey: "effect_http_rpc" }), permissions: networkPermissions,
        authorizationAction: "network.request", url: "https://authorized.example/", method: "GET", headers: {},
        timeoutMs: 5_000, responseLimitBytes: 1024,
      });
      expect(Buffer.from(brokered.bodyBase64, "base64").toString()).toBe("brokered");
      expect(brokered.receipt.nodeId).toBe("rpc_node");
      const started = await client.startProcess(request(workspace));
      launcher.processes[0]!.output("remote-output");
      const output = await client.readProcessEvents({
        processId: started.process.id, adoptionToken: started.adoptionToken, afterSequence: 0, maximumEvents: 10,
      });
      expect(output.events.map((event) => event.type)).toContain("process.output");

      client.disconnect();
      const descriptions = await Promise.all(Array.from({ length: 8 }, () => client.describeProcess({
        processId: started.process.id, adoptionToken: started.adoptionToken,
      })));
      expect(descriptions.every((descriptor) => descriptor.id === started.process.id)).toBe(true);
      const adopted = await client.adoptProcess({
        processId: started.process.id,
        adoptionToken: started.adoptionToken,
        attribution: attribution({ workerId: "worker_2", leaseId: "lease_2", idempotencyKey: "effect_rpc_2" }),
      });
      await expect(client.describeProcess({ processId: started.process.id, adoptionToken: started.adoptionToken })).rejects.toThrow(/Invalid process adoption token/);
      expect((await client.describeProcess({ processId: started.process.id, adoptionToken: adopted.adoptionToken })).attribution.workerId).toBe("worker_2");
      launcher.processes[0]!.exit(0);

      const unauthorized = new ExecutionNodeRpcClient(address, { authToken: createExecutionRpcAuthToken() });
      await expect(unauthorized.handshake({ clientId: "bad", protocol: EXECUTION_PROTOCOL_VERSION, requiredCapabilities: [] }))
        .rejects.toBeInstanceOf(ExecutionRpcRemoteError);
      unauthorized.disconnect();
    } finally {
      client.disconnect();
      await server.close();
    }
  });

  it("serves the same protocol over a user-local named pipe", async () => {
    const { node } = fixture();
    const token = createExecutionRpcAuthToken();
    const server = new ExecutionNodeRpcServer(new ExecutionRpcDispatcher(node), { authToken: token });
    const address = defaultExecutionRpcPipe(`test-${randomUUID()}`);
    await server.listen(address);
    const client = new ExecutionNodeRpcClient(address, { authToken: token });
    try {
      const response = await client.handshake({ clientId: "pipe-client", protocol: EXECUTION_PROTOCOL_VERSION, requiredCapabilities: ["filesystem.read"] });
      expect(response.node.id).toBe("rpc_node");
    } finally {
      client.disconnect();
      await server.close();
    }
  });
});
