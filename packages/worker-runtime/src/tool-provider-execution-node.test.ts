import { describe, expect, it } from "vitest";
import {
  permissionProfileFingerprint,
  resourceLimitsFingerprint,
  type ExecutionNode,
  type ExecutionResourceLimits,
  type ProcessDescriptor,
  type ProcessEvent,
  type ReadProcessEventsRequest,
  type WriteProcessInputRequest,
} from "@traceforge/execution-node";
import type { EffectivePermissionProfile } from "@traceforge/orchestration-core";
import { ExecutionNodeToolProviderClient } from "./tool-provider-execution-node.js";
import { LengthPrefixedJsonDecoder, TOOL_PROVIDER_RPC_VERSION, encodeLengthPrefixedJson, type ToolProviderRpcRequest, type ToolProviderRpcResponse } from "./tool-provider-rpc.js";
import type { ProviderCapabilityHost, ProviderCapabilityInvocation } from "./provider-capability-broker.js";
import type { ToolProviderDiagnosticRecord, ToolProviderDiagnosticWriter } from "./tool-provider-diagnostics.js";

const permissions: EffectivePermissionProfile = {
  version: 1, platform: "windows", filesystem: { read: [], write: [], deny: [] }, network: "deny",
  process: { access: "sandboxed", interactive: false, background: false }, secrets: "handles_only", sources: ["provider-policy"],
};
const resources: ExecutionResourceLimits = { cpuTimeMs: 60_000, memoryBytes: 128 * 1024 * 1024, maximumProcesses: 2, writeBytes: 1024 * 1024 };
const activeLeaseExpiresAt = "2100-01-01T00:00:00.000Z";

class FakeProviderNode {
  private sequence = 0;
  private events: ProcessEvent[] = [];
  private waiter: (() => void) | null = null;
  terminated = 0;
  inputWrites = 0;
  descriptor: ProcessDescriptor;
  private readonly decoder = new LengthPrefixedJsonDecoder(1024 * 1024);
  private readonly capabilityParents = new Map<string, string>();

  constructor(validAttestation = true) {
    this.descriptor = {
      id: "process_1", nodeId: "node_1", pid: 42, state: "running",
      attribution: {
        caseId: "case_1", runId: "run_1", workId: "provider_service", workerId: "provider_host", scopeRef: "scope_1",
        leaseId: "lease_1", leaseExpiresAt: activeLeaseExpiresAt, actionId: "provider.start", idempotencyKey: "provider_1",
      },
      executable: "C:\\provider.exe", arguments: [], workingDirectory: "C:\\provider", terminal: null,
      enforcement: {
        sandboxBackend: "appcontainer", sandboxed: true, filesystemPolicyApplied: true,
        permissionProfileFingerprint: validAttestation ? permissionProfileFingerprint(permissions) : "mismatch",
        resourceLimitsApplied: true, resourceLimitsFingerprint: resourceLimitsFingerprint(resources), network: "deny",
      },
      startedAt: "2026-08-27T08:00:00.000Z", updatedAt: "2026-08-27T08:00:00.000Z", exitedAt: null,
      exitCode: null, exitSignal: null, resourceLimitExceeded: null, capturedOutputBytes: 0, omittedOutputBytes: 0, lastEventSequence: 0,
    };
  }

  asNode(): ExecutionNode {
    return {
      handshake: async () => ({} as never),
      startProcess: async () => ({ process: this.descriptor, adoptionToken: "adopt_1", replayed: false }),
      writeProcessInput: async (request: WriteProcessInputRequest) => {
        this.inputWrites += 1;
        for (const value of this.decoder.push(Buffer.from(request.dataBase64, "base64"))) {
          this.respond(value as ToolProviderRpcRequest | ToolProviderRpcResponse);
        }
        return this.descriptor;
      },
      waitProcessEvents: async (request: ReadProcessEventsRequest) => {
        while (!this.events.some((event) => event.sequence > request.afterSequence) && this.descriptor.state === "running") {
          await new Promise<void>((resolve) => { this.waiter = resolve; });
        }
        const events = this.events.filter((event) => event.sequence > request.afterSequence);
        return { process: this.descriptor, events, nextSequence: events.at(-1)?.sequence ?? request.afterSequence, lostEvents: false };
      },
      terminateProcess: async () => {
        this.terminated += 1;
        this.descriptor = { ...this.descriptor, state: "exited", exitCode: 0, exitedAt: "2026-08-27T08:01:00.000Z" };
        this.waiter?.();
        return this.descriptor;
      },
    } as unknown as ExecutionNode;
  }

  private respond(request: ToolProviderRpcRequest | ToolProviderRpcResponse): void {
    if ("ok" in request) {
      const parent = this.capabilityParents.get(request.id);
      if (!parent) return;
      this.capabilityParents.delete(request.id);
      const status = request.ok
        ? (request.result as { status?: string }).status ?? "unknown"
        : request.error.code;
      this.emit({
        version: TOOL_PROVIDER_RPC_VERSION,
        id: parent,
        ok: true,
        result: { status: "succeeded", summary: `sandboxed host capability ${status}`, raw: "", refs: [`host:${status}`], retryable: false },
      });
      return;
    }
    let result: unknown;
    if (request.method === "provider.handshake") result = { providerId: "sandboxed-fixture", providerVersion: "1.0.0", protocolVersion: TOOL_PROVIDER_RPC_VERSION };
    else if (request.method === "tools.list") result = [{
      name: "sandboxed.read", source: "rpc:sandboxed", version: "1.0.0", priority: 100, description: "Sandboxed read", inputSchema: {},
      providedCapabilities: ["sandboxed.read"], dependencyCapabilities: [], permissionRequirements: {}, risk: "read_only", timeoutMs: 1000,
    }];
    else {
      const params = request.params as { input?: { broker?: boolean; remoteError?: boolean }; context?: { idempotencyKey?: string } };
      if (params.input?.remoteError) {
        this.emit({
          version: TOOL_PROVIDER_RPC_VERSION, id: request.id, ok: false,
          error: { code: "provider_failure", message: "sensitive-provider-detail-".repeat(1_000), retryable: false },
        });
        return;
      }
      if (params.input?.broker) {
        const reverseId = `reverse:${request.id}`;
        this.capabilityParents.set(reverseId, request.id);
        this.emit({
          version: TOOL_PROVIDER_RPC_VERSION,
          id: reverseId,
          method: "host.capability.call",
          params: {
            parentRequestId: request.id,
            capability: "fixture.lookup",
            action: "fixture.inspect",
            idempotencyKey: `fixture:${params.context?.idempotencyKey ?? request.id}`,
            input: { subject: "first candidate" },
          },
        });
        return;
      }
      result = { status: "succeeded", summary: "sandboxed result", raw: "", refs: ["evidence_1"], retryable: false };
    }
    this.emit({ version: TOOL_PROVIDER_RPC_VERSION, id: request.id, ok: true, result });
  }

  private emit(value: ToolProviderRpcRequest | ToolProviderRpcResponse): void {
    const data = encodeLengthPrefixedJson(value, 1024 * 1024);
    const event: ProcessEvent = {
      type: "process.output", processId: this.descriptor.id, sequence: ++this.sequence,
      at: "2026-08-27T08:00:01.000Z", stream: "stdout", dataBase64: data.toString("base64"), bytes: data.length,
    };
    this.events.push(event);
    this.descriptor = { ...this.descriptor, lastEventSequence: this.sequence };
    this.waiter?.();
    this.waiter = null;
  }
}

function client(
  node: FakeProviderNode,
  expected?: { providerId?: string; providerVersion?: string },
  capabilityHost?: ProviderCapabilityHost,
  diagnosticWriter?: ToolProviderDiagnosticWriter,
): ExecutionNodeToolProviderClient {
  return new ExecutionNodeToolProviderClient({
    node: node.asNode(), executable: "C:\\provider.exe", workingDirectory: "C:\\provider",
    attribution: node.descriptor.attribution, permissions, resources, expectedSandboxBackend: "appcontainer", requestTimeoutMs: 2_000,
    expectedProviderId: expected?.providerId,
    expectedProviderVersion: expected?.providerVersion,
    capabilityHost, diagnosticWriter,
  });
}

describe("ExecutionNodeToolProviderClient", () => {
  it("accepts a Provider only after verifying Execution Node enforcement", async () => {
    const node = new FakeProviderNode();
    const rpc = client(node);
    await expect(rpc.listTools()).resolves.toMatchObject([{ name: "sandboxed.read", source: "rpc:sandboxed" }]);
    await expect(rpc.callTool("sandboxed.read", {}, {
      workerId: "worker_1", runId: "run_1", workId: "work_1", caseId: "case_1", scopeRef: "scope_1",
      leaseId: "lease_1", leaseExpiresAt: activeLeaseExpiresAt, idempotencyKey: "effect_1", effectivePermissions: permissions,
    })).resolves.toMatchObject({ status: "succeeded", refs: ["evidence_1"] });
    expect(rpc.status()).toMatchObject({ state: "ready", generation: 1, attestation: { sandboxed: true, backend: "appcontainer", network: "deny" } });
    await rpc.close();
    expect(node.terminated).toBe(1);
  });

  it("rejects and terminates a Provider with a mismatched attestation", async () => {
    const node = new FakeProviderNode(false);
    const rpc = client(node);
    await expect(rpc.listTools()).rejects.toThrow(/permission attestation does not match/);
    expect(node.terminated).toBe(1);
    expect(rpc.status().provider).toBeNull();
  });

  it.each([
    [{ providerId: "different-provider" }, /identity mismatch/],
    [{ providerVersion: "2.0.0" }, /version mismatch/],
  ] as const)("rejects and terminates a Provider whose signed identity expectation does not match", async (expected, message) => {
    const node = new FakeProviderNode();
    const rpc = client(node, expected);
    await expect(rpc.listTools()).rejects.toThrow(message);
    expect(node.terminated).toBe(1);
    expect(rpc.status().provider).toBeNull();
  });

  it("rejects Provider permissions that could bypass host brokers", () => {
    const node = new FakeProviderNode();
    expect(() => new ExecutionNodeToolProviderClient({
      node: node.asNode(), executable: "C:\\provider.exe", workingDirectory: "C:\\provider",
      attribution: node.descriptor.attribution, resources,
      permissions: { ...permissions, network: "direct" },
    })).toThrow(/cannot use direct networking/);
  });

  it("keeps Provider-supplied error detail out of the public exception and writes an audit diagnostic", async () => {
    const node = new FakeProviderNode();
    const diagnostics: ToolProviderDiagnosticRecord[] = [];
    const rpc = client(node, undefined, undefined, { write(record) { diagnostics.push(record); } });
    await expect(rpc.callTool("sandboxed.read", { remoteError: true }, {
      workerId: "worker_1", runId: "run_1", workId: "work_1", caseId: "case_1", scopeRef: "scope_1",
      leaseId: "lease_1", leaseExpiresAt: activeLeaseExpiresAt, idempotencyKey: "effect_1", effectivePermissions: permissions,
    })).rejects.toThrow(/Tool Provider reported an error \(diagnostic:/);
    const publicError = await rpc.callTool("sandboxed.read", { remoteError: true }, {
      workerId: "worker_1", runId: "run_1", workId: "work_1", caseId: "case_1", scopeRef: "scope_1",
      leaseId: "lease_1", leaseExpiresAt: activeLeaseExpiresAt, idempotencyKey: "effect_2", effectivePermissions: permissions,
    }).catch((error: Error) => error.message);
    expect(publicError).not.toContain("sensitive-provider-detail");
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0]).toMatchObject({
      category: "remote_error", provider: { id: "sandboxed-fixture", version: "1.0.0", generation: 1 },
      attribution: { caseId: "case_1", runId: "run_1", workId: "work_1" },
    });
    expect(diagnostics[0]!.detail).toContain("sensitive-provider-detail");
    expect(diagnostics[0]!.detailBytes).toBeLessThanOrEqual(16 * 1024);
    expect(rpc.status().lastDiagnosticRef).toBe(diagnostics[1]!.id);
    await rpc.close();
  });

  it("dispatches reverse capability calls over Execution Node stdio with trusted tool ownership", async () => {
    const node = new FakeProviderNode();
    let observed: ProviderCapabilityInvocation | undefined;
    const rpc = client(node, undefined, {
      async invoke(input) {
        observed = input;
        return {
          id: "receipt-1", provider: input.provider, parentRequestId: input.parentRequestId,
          capability: input.capability, action: input.action, idempotencyKey: input.idempotencyKey,
          inputFingerprint: "fingerprint", attribution: {
            workerId: input.attribution.workerId, runId: input.attribution.runId, workId: input.attribution.workId,
            caseId: input.attribution.caseId, scopeRef: input.attribution.scopeRef, leaseId: input.attribution.leaseId,
            leaseExpiresAt: input.attribution.leaseExpiresAt, idempotencyKey: input.attribution.idempotencyKey,
          },
          status: "succeeded", authorizationRef: "authorization-1", output: {}, refs: [],
          requestBytes: 1, responseBytes: 2, retryable: false,
          startedAt: "2026-08-28T12:00:00.000Z", completedAt: "2026-08-28T12:00:00.001Z",
        };
      },
    });
    const toolContext = {
      workerId: "worker_1", runId: "run_1", workId: "work_1", caseId: "case_1", scopeRef: "scope_1",
      leaseId: "lease_1", leaseExpiresAt: activeLeaseExpiresAt, idempotencyKey: "effect_1", effectivePermissions: permissions,
    };

    await expect(rpc.callTool("sandboxed.read", { broker: true }, toolContext)).resolves.toMatchObject({
      status: "succeeded", summary: "sandboxed host capability succeeded", refs: ["host:succeeded"],
    });
    expect(observed).toMatchObject({
      provider: { id: "sandboxed-fixture", version: "1.0.0", generation: 1 },
      parentRequestId: expect.any(String), capability: "fixture.lookup", action: "fixture.inspect", depth: 1,
      attribution: { caseId: "case_1", runId: "run_1", workId: "work_1", workerId: "worker_1", leaseId: "lease_1" },
    });
    await rpc.close();
  });

  it("drops a reverse capability result that arrives after the Provider generation closes", async () => {
    const node = new FakeProviderNode();
    let invocation: ProviderCapabilityInvocation | undefined;
    let resolveInvocation!: (receipt: Awaited<ReturnType<ProviderCapabilityHost["invoke"]>>) => void;
    let markInvoked!: () => void;
    const invoked = new Promise<void>((resolve) => { markInvoked = resolve; });
    const rpc = client(node, undefined, {
      invoke(input) {
        invocation = input;
        markInvoked();
        return new Promise((resolve) => { resolveInvocation = resolve; });
      },
    });
    const pendingCall = rpc.callTool("sandboxed.read", { broker: true }, {
      workerId: "worker_1", runId: "run_1", workId: "work_1", caseId: "case_1", scopeRef: "scope_1",
      leaseId: "lease_1", leaseExpiresAt: activeLeaseExpiresAt, idempotencyKey: "effect_1", effectivePermissions: permissions,
    });
    await invoked;
    const writesBeforeClose = node.inputWrites;
    await rpc.close();
    resolveInvocation({
      id: "receipt-late", provider: invocation!.provider, parentRequestId: invocation!.parentRequestId,
      capability: invocation!.capability, action: invocation!.action, idempotencyKey: invocation!.idempotencyKey,
      inputFingerprint: "fingerprint", attribution: {
        workerId: invocation!.attribution.workerId, runId: invocation!.attribution.runId,
        workId: invocation!.attribution.workId, caseId: invocation!.attribution.caseId,
        scopeRef: invocation!.attribution.scopeRef, leaseId: invocation!.attribution.leaseId,
        leaseExpiresAt: invocation!.attribution.leaseExpiresAt, idempotencyKey: invocation!.attribution.idempotencyKey,
      },
      status: "succeeded", authorizationRef: "authorization-1", output: {}, refs: [],
      requestBytes: 1, responseBytes: 2, retryable: false,
      startedAt: "2026-08-28T12:00:00.000Z", completedAt: "2026-08-28T12:00:00.001Z",
    });
    await expect(pendingCall).rejects.toThrow(/process stopped/);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(node.inputWrites).toBe(writesBeforeClose);
    expect(node.terminated).toBe(1);
  });
});
