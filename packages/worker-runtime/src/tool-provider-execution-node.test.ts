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
import { LengthPrefixedJsonDecoder, TOOL_PROVIDER_RPC_VERSION, encodeLengthPrefixedJson, type ToolProviderRpcRequest } from "./tool-provider-rpc.js";

const permissions: EffectivePermissionProfile = {
  version: 1, platform: "windows", filesystem: { read: [], write: [], deny: [] }, network: "deny",
  process: { access: "sandboxed", interactive: false, background: false }, secrets: "handles_only", sources: ["provider-policy"],
};
const resources: ExecutionResourceLimits = { cpuTimeMs: 60_000, memoryBytes: 128 * 1024 * 1024, maximumProcesses: 2, writeBytes: 1024 * 1024 };

class FakeProviderNode {
  private sequence = 0;
  private events: ProcessEvent[] = [];
  private waiter: (() => void) | null = null;
  terminated = 0;
  descriptor: ProcessDescriptor;
  private readonly decoder = new LengthPrefixedJsonDecoder(1024 * 1024);

  constructor(validAttestation = true) {
    this.descriptor = {
      id: "process_1", nodeId: "node_1", pid: 42, state: "running",
      attribution: {
        caseId: "case_1", runId: "run_1", workId: "provider_service", workerId: "provider_host", scopeRef: "scope_1",
        leaseId: "lease_1", leaseExpiresAt: "2026-08-28T09:00:00.000Z", actionId: "provider.start", idempotencyKey: "provider_1",
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
        for (const value of this.decoder.push(Buffer.from(request.dataBase64, "base64"))) this.respond(value as ToolProviderRpcRequest);
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

  private respond(request: ToolProviderRpcRequest): void {
    let result: unknown;
    if (request.method === "provider.handshake") result = { providerId: "sandboxed-fixture", providerVersion: "1.0.0", protocolVersion: TOOL_PROVIDER_RPC_VERSION };
    else if (request.method === "tools.list") result = [{
      name: "sandboxed.read", source: "rpc:sandboxed", version: "1.0.0", priority: 100, description: "Sandboxed read", inputSchema: {},
      providedCapabilities: ["sandboxed.read"], dependencyCapabilities: [], permissionRequirements: {}, risk: "read_only", timeoutMs: 1000,
    }];
    else result = { status: "succeeded", summary: "sandboxed result", raw: "", refs: ["evidence_1"], retryable: false };
    const data = encodeLengthPrefixedJson({ version: TOOL_PROVIDER_RPC_VERSION, id: request.id, ok: true, result }, 1024 * 1024);
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
): ExecutionNodeToolProviderClient {
  return new ExecutionNodeToolProviderClient({
    node: node.asNode(), executable: "C:\\provider.exe", workingDirectory: "C:\\provider",
    attribution: node.descriptor.attribution, permissions, resources, expectedSandboxBackend: "appcontainer", requestTimeoutMs: 2_000,
    expectedProviderId: expected?.providerId,
    expectedProviderVersion: expected?.providerVersion,
  });
}

describe("ExecutionNodeToolProviderClient", () => {
  it("accepts a Provider only after verifying Execution Node enforcement", async () => {
    const node = new FakeProviderNode();
    const rpc = client(node);
    await expect(rpc.listTools()).resolves.toMatchObject([{ name: "sandboxed.read", source: "rpc:sandboxed" }]);
    await expect(rpc.callTool("sandboxed.read", {}, {
      workerId: "worker_1", runId: "run_1", workId: "work_1", caseId: "case_1", scopeRef: "scope_1",
      leaseId: "lease_1", leaseExpiresAt: "2026-08-28T09:00:00.000Z", idempotencyKey: "effect_1", effectivePermissions: permissions,
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
});
