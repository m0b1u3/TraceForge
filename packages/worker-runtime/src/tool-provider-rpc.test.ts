import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolExecutionContext } from "./model.js";
import type { ProviderCapabilityInvocation, ProviderCapabilityReceipt } from "./provider-capability-broker.js";
import { RpcExecutionToolDiscoverySource, ToolProviderProcessClient, encodeLengthPrefixedJson, validateProviderHostCapabilityCall } from "./tool-provider-rpc.js";
import { ExecutionToolDiscoveryRuntime } from "./tool-discovery.js";
import type { ToolProviderDiagnosticRecord, ToolProviderDiagnosticWriter } from "./tool-provider-diagnostics.js";

const clients: ToolProviderProcessClient[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map((client) => client.close())); });

const context: ToolExecutionContext = {
  workerId: "worker_1", runId: "run_1", workId: "work_1", caseId: "case_1", scopeRef: "scope_1",
  leaseId: "lease_1", leaseExpiresAt: "2100-01-01T00:00:00.000Z", idempotencyKey: "effect_1",
  effectivePermissions: {
    version: 1, platform: "windows", filesystem: { read: [], write: [], deny: [] }, network: "deny",
    process: { access: "deny", interactive: false, background: false }, secrets: "handles_only", sources: ["test"],
  },
};

function client(
  capabilityHost?: { invoke(input: ProviderCapabilityInvocation): Promise<ProviderCapabilityReceipt> },
  diagnosticWriter?: ToolProviderDiagnosticWriter,
): ToolProviderProcessClient {
  const value = new ToolProviderProcessClient({
    executable: process.execPath,
    arguments: [resolve("packages/worker-runtime/test-fixtures/tool-provider.mjs")],
    workingDirectory: resolve("."),
    environment: { TRACEFORGE_TEST_SOURCE: "rpc:test", ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
    attestation: { sandboxed: false, backend: "test-process", network: "deny" },
    allowUnsandboxedDevelopment: true,
    requestTimeoutMs: 3_000,
    capabilityHost, diagnosticWriter,
  });
  clients.push(value);
  return value;
}

describe("Tool Provider RPC", () => {
  it("requires a sandbox attestation outside explicit development mode", () => {
    expect(() => new ToolProviderProcessClient({
      executable: process.execPath, workingDirectory: resolve("."),
      attestation: { sandboxed: false, backend: "none", network: "direct" },
    })).toThrow(/requires a sandbox attestation/);
  });

  it("discovers and executes tools through a private child-process protocol", async () => {
    const rpc = client();
    const source = new RpcExecutionToolDiscoverySource("rpc:test", rpc);
    const runtime = new ExecutionToolDiscoveryRuntime([source]);
    await runtime.refresh();
    const tools = runtime.registry.list().map((state) => state.provider);
    expect(tools.map((tool) => tool.name)).toEqual(["fixture.read"]);
    await expect(tools[0].execute({ value: "bounded" }, context)).resolves.toMatchObject({
      status: "succeeded", summary: "fixture completed", refs: ["work:work_1"],
    });
    expect(source.status()).toMatchObject({ state: "ready", generation: 1, provider: { providerId: "fixture" } });
    expect(runtime.snapshot().sources[0].diagnostics).toMatchObject({ process: { state: "ready", generation: 1 } });
  });

  it("restarts after a provider crash and rediscovers the catalog", async () => {
    const rpc = client();
    const source = new RpcExecutionToolDiscoverySource("rpc:test", rpc);
    const [tool] = await source.discover();
    await expect(tool.execute({ crash: true }, context)).rejects.toThrow(/process exited|code 9/i);
    await expect(source.discover()).resolves.toHaveLength(1);
    expect(source.status()).toMatchObject({ state: "ready", generation: 2, provider: { providerId: "fixture" } });
  });

  it("keeps bounded stderr behind a diagnostic reference", async () => {
    const diagnostics: ToolProviderDiagnosticRecord[] = [];
    const rpc = client(undefined, { write(record) { diagnostics.push(record); } });
    await expect(rpc.callTool("fixture.read", { crashDetail: true }, context)).rejects.toThrow(/diagnostic:/);
    const message = rpc.status().lastError ?? "";
    expect(message).not.toContain("sensitive-stderr-detail");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ category: "process_exit", summary: "Tool Provider exited with code 9" });
    expect(diagnostics[0]!.detail).toContain("sensitive-stderr-detail");
    expect(diagnostics[0]!.detailBytes).toBeLessThanOrEqual(16 * 1024);
  });

  it("dispatches a reverse capability request with the active tools.call ownership", async () => {
    let observed: ProviderCapabilityInvocation | undefined;
    const rpc = client({
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
          status: "succeeded", authorizationRef: "authorization-1", output: { state: "available" }, refs: ["evidence:first"],
          requestBytes: 16, responseBytes: 20, retryable: false,
          startedAt: "2026-08-28T12:00:00.000Z", completedAt: "2026-08-28T12:00:00.001Z",
        };
      },
    });

    await expect(rpc.callTool("fixture.read", { broker: true }, context)).resolves.toMatchObject({
      status: "succeeded", summary: "fixture host capability succeeded", refs: ["host:succeeded"],
    });
    expect(observed).toMatchObject({
      provider: { id: "fixture", version: "1.0.0", generation: 1 },
      capability: "fixture.lookup", action: "fixture.inspect", depth: 1,
      attribution: { caseId: "case_1", runId: "run_1", workId: "work_1", workerId: "worker_1", leaseId: "lease_1" },
    });
  });

  it("rejects reverse requests whose parent tools.call is not active", async () => {
    let calls = 0;
    const rpc = client({
      async invoke() { calls += 1; throw new Error("must not run"); },
    });

    await expect(rpc.callTool("fixture.read", { unknownParent: true }, context)).resolves.toMatchObject({
      status: "succeeded", summary: "fixture host capability unknown_parent", refs: ["host:unknown_parent"],
    });
    expect(calls).toBe(0);
    expect(rpc.status().state).toBe("ready");
  });

  it("rejects frames larger than the configured protocol limit", () => {
    expect(() => encodeLengthPrefixedJson({ value: "x".repeat(300) }, 256)).toThrow(/exceeds/);
  });

  it("rejects Provider-supplied ownership fields in reverse capability parameters", () => {
    expect(() => validateProviderHostCapabilityCall({
      parentRequestId: "tool-call-1", capability: "fixture.lookup", action: "fixture.inspect",
      idempotencyKey: "capability-call-1", input: {}, runId: "forged-run",
    })).toThrow(/invalid/);
  });
});
