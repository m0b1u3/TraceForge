import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolExecutionContext } from "./model.js";
import { RpcExecutionToolDiscoverySource, ToolProviderProcessClient, encodeLengthPrefixedJson } from "./tool-provider-rpc.js";
import { ExecutionToolDiscoveryRuntime } from "./tool-discovery.js";

const clients: ToolProviderProcessClient[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map((client) => client.close())); });

const context: ToolExecutionContext = {
  workerId: "worker_1", runId: "run_1", workId: "work_1", caseId: "case_1", scopeRef: "scope_1",
  leaseId: "lease_1", leaseExpiresAt: "2026-08-27T09:00:00.000Z", idempotencyKey: "effect_1",
  effectivePermissions: {
    version: 1, platform: "windows", filesystem: { read: [], write: [], deny: [] }, network: "deny",
    process: { access: "deny", interactive: false, background: false }, secrets: "handles_only", sources: ["test"],
  },
};

function client(): ToolProviderProcessClient {
  const value = new ToolProviderProcessClient({
    executable: process.execPath,
    arguments: [resolve("packages/worker-runtime/test-fixtures/tool-provider.mjs")],
    workingDirectory: resolve("."),
    environment: { TRACEFORGE_TEST_SOURCE: "rpc:test", ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
    attestation: { sandboxed: false, backend: "test-process", network: "deny" },
    allowUnsandboxedDevelopment: true,
    requestTimeoutMs: 3_000,
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

  it("rejects frames larger than the configured protocol limit", () => {
    expect(() => encodeLengthPrefixedJson({ value: "x".repeat(300) }, 256)).toThrow(/exceeds/);
  });
});
