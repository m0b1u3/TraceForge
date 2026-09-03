import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolExecutionContext } from "./model.js";
import {
  SCENARIO_PROCESS_PROTOCOL,
  ScenarioPackageCapabilityBroker,
  ScenarioProcessRuntime,
  type ScenarioPackageCapabilityHandler,
  type ScenarioProcessManifest,
} from "./scenario-process-runtime.js";
import { ToolProviderFairScheduler } from "./tool-provider-scheduler.js";

const runtimes: ScenarioProcessRuntime[] = [];
afterEach(async () => { await Promise.all(runtimes.splice(0).map((runtime) => runtime.close())); });

const context: ToolExecutionContext = {
  workerId: "worker", runId: "run", workId: "work", caseId: "case", scopeRef: "scope", leaseId: "lease",
  leaseExpiresAt: "2100-01-01T00:00:00.000Z", idempotencyKey: "effect",
  effectivePermissions: { version: 1, platform: "windows", filesystem: { read: [], write: [], deny: [] }, network: "deny",
    process: { access: "deny", interactive: false, background: false }, secrets: "handles_only", sources: ["test"] },
};

const handler = (execute?: ScenarioPackageCapabilityHandler["execute"]): ScenarioPackageCapabilityHandler => ({
  capability: "fixture.lookup", actions: ["fixture.inspect"],
  execute: execute ?? (async (_input, owner) => ({ output: { owner: owner.runId }, refs: ["evidence:first"] })),
});

function manifest(): ScenarioProcessManifest {
  return {
    protocol: SCENARIO_PROCESS_PROTOCOL, protocolVersion: 1, id: "fixture", version: "1.0.0", source: "scenario:fixture",
    entrypoint: "package://runtime/main.mjs",
    providedCapabilities: ["fixture.read"], hostCapabilities: ["fixture.lookup"],
  };
}

function runtime(overrides: Partial<ConstructorParameters<typeof ScenarioProcessRuntime>[0]> = {}): ScenarioProcessRuntime {
  const value = new ScenarioProcessRuntime({ manifest: manifest(), capabilityHandlers: [handler()],
    launch: { executable: process.execPath, arguments: [resolve("packages/worker-runtime/test-fixtures/tool-provider.mjs")], workingDirectory: resolve("."),
      environment: { TRACEFORGE_TEST_SOURCE: "scenario:fixture", TRACEFORGE_TEST_PROTOCOL_PROFILE: SCENARIO_PROCESS_PROTOCOL,
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
      attestation: { sandboxed: false, backend: "test-process", network: "deny" } },
    transport: { allowUnsandboxedDevelopment: true, requestTimeoutMs: 2_000 }, ...overrides });
  runtimes.push(value); return value;
}

describe("Scenario Process Runtime", () => {
  it("discovers, executes and brokers a declared capability with Host-owned Work attribution", async () => {
    let owner: ToolExecutionContext | undefined;
    const value = runtime({ capabilityHandlers: [handler(async (_input, current) => {
      owner = current; return { output: { available: true }, refs: ["evidence:first"] };
    })] });
    const [tool] = await value.discover();
    await expect(tool.execute({ broker: true }, context)).resolves.toMatchObject({ status: "succeeded", summary: "fixture host capability succeeded" });
    expect(owner).toMatchObject({ caseId: "case", runId: "run", workId: "work", workerId: "worker", leaseId: "lease" });
    expect(value.status()).toMatchObject({ state: "ready", generation: 1, protocol: SCENARIO_PROCESS_PROTOCOL });
  });

  it("rejects a child whose handshake does not match the installed Package", async () => {
    const value = runtime({ launch: launch({ TRACEFORGE_TEST_PROVIDER_ID: "other" }) });
    await expect(value.discover()).rejects.toThrow(/identity mismatch/);
  });

  it("rejects a generic Provider process that did not negotiate the Scenario profile", async () => {
    const value = runtime({ launch: launch({}, false) });
    await expect(value.discover()).rejects.toThrow(/profile or Package identity mismatch/);
  });

  it("rejects tool capabilities absent from the reviewed Package manifest", async () => {
    const value = runtime({ launch: launch({ TRACEFORGE_TEST_CAPABILITIES: "fixture.undeclared" }) });
    await expect(value.discover()).rejects.toThrow(/undeclared capabilities/);
  });

  it("fails closed for undeclared handlers and actions", async () => {
    expect(() => new ScenarioPackageCapabilityBroker({ id: "fixture", version: "1" }, [], [handler()]))
      .toThrow(/was not declared/);
    const broker = new ScenarioPackageCapabilityBroker({ id: "fixture", version: "1" }, ["fixture.lookup"], [handler()]);
    broker.activate(1);
    await expect(broker.invoke({ provider: { id: "fixture", version: "1", generation: 1 }, parentRequestId: "parent",
      capability: "fixture.lookup", action: "fixture.write", idempotencyKey: "key", input: {}, attribution: context, depth: 1 }))
      .rejects.toThrow(/action.*not granted/);
  });

  it("revokes the active generation and permanently closes its process", async () => {
    const value = runtime(); await value.discover(); await value.revoke("Package trust withdrawn");
    await expect(value.discover()).rejects.toThrow(/revoked/);
    await expect(value.restart()).rejects.toThrow(/revoked/);
    expect(value.status()).toMatchObject({ state: "stopped", revokedReason: "Package trust withdrawn" });
  });

  it("allows a bounded controlled restart after a real child crash", async () => {
    const value = runtime({ maximumRestarts: 1 }); const [tool] = await value.discover();
    await expect(tool.execute({ crash: true }, context)).rejects.toThrow(/process exited|code 9/i);
    await expect(value.discover()).resolves.toHaveLength(1);
    expect(value.status().generation).toBe(2);
    await expect(value.restart()).rejects.toThrow(/restart budget exhausted/);
  });

  it.skipIf(process.platform === "win32")("recovers through a new generation after an external SIGKILL", async () => {
    const value = runtime({ maximumRestarts: 1 }); await value.discover();
    const pid = value.status().pid!; process.kill(pid, "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(value.discover()).resolves.toHaveLength(1);
    expect(value.status()).toMatchObject({ state: "ready", generation: 2 });
  });

  it("fails and closes the child on a corrupt protocol frame", async () => {
    const value = runtime({ launch: launch({ TRACEFORGE_TEST_PROTOCOL_CORRUPT: "true" }) });
    await expect(value.discover()).rejects.toThrow(/frame length 0 is invalid/);
    expect(value.status().state).toBe("failed");
  });

  it("does not dispatch a host capability omitted from the Package grant", async () => {
    let calls = 0;
    const value = runtime({ launch: launch({ TRACEFORGE_TEST_HOST_CAPABILITY: "fixture.admin" }),
      capabilityHandlers: [handler(async () => { calls += 1; return { output: {}, refs: [] }; })] });
    const [tool] = await value.discover();
    await expect(tool.execute({ broker: true }, context)).resolves.toMatchObject({ summary: "fixture host capability capability_failed" });
    expect(calls).toBe(0);
  });

  it("aborts an in-flight capability when Package trust is revoked", async () => {
    let started!: () => void; const entered = new Promise<void>((resolve) => { started = resolve; });
    const value = runtime({ capabilityHandlers: [handler(async () => { started(); return new Promise<never>(() => {}); })] });
    const [tool] = await value.discover(); const call = tool.execute({ broker: true }, context);
    await entered; await value.revoke("review withdrawn");
    await expect(call).rejects.toThrow(/revoked|process exited|unavailable/i);
  });

  it("uses the shared Foundation scheduler for Scenario process tool calls", async () => {
    const scheduler = new ToolProviderFairScheduler({ global: 1, perProvider: 1, perTool: 1, perRun: 1, perWork: 1,
      maximumQueued: 1, maximumWaitMs: 10 });
    const value = runtime({ scheduler }); const [tool] = await value.discover();
    const first = tool.execute({ delayMs: 30 }, context);
    await new Promise((resolve) => setTimeout(resolve, 2));
    await expect(tool.execute({}, context)).rejects.toThrow(/wait timed out/);
    await expect(first).resolves.toMatchObject({ status: "succeeded" });
    expect(scheduler.snapshot()).toMatchObject({ active: 0, queued: 0 });
  });

  it("rejects stale generations and exact-key input conflicts", async () => {
    const broker = new ScenarioPackageCapabilityBroker({ id: "fixture", version: "1" }, ["fixture.lookup"], [handler()]);
    broker.activate(2);
    const call = (generation: number, input: unknown) => broker.invoke({ provider: { id: "fixture", version: "1", generation },
      parentRequestId: "parent", capability: "fixture.lookup", action: "fixture.inspect", idempotencyKey: "same", input,
      attribution: context, depth: 1 });
    await expect(call(1, {})).rejects.toThrow(/generation is not active/);
    await expect(call(2, { candidate: "first" })).resolves.toMatchObject({ status: "succeeded" });
    await expect(call(2, { candidate: "second" })).rejects.toThrow(/reused with different input/);
  });

  it("coalesces concurrent duplicate calls and replays their receipt across a new process generation", async () => {
    let executions = 0;
    const broker = new ScenarioPackageCapabilityBroker({ id: "fixture", version: "1" }, ["fixture.lookup"], [handler(async () => {
      executions += 1; await new Promise((resolve) => setTimeout(resolve, 10)); return { output: { available: true }, refs: [] };
    })], { maximumReceipts: 1 });
    const call = (generation: number, idempotencyKey = "stable") => broker.invoke({ provider: { id: "fixture", version: "1", generation }, parentRequestId: `parent:${generation}`,
      capability: "fixture.lookup", action: "fixture.inspect", idempotencyKey, input: { candidate: "first" }, attribution: context, depth: 1 });
    broker.activate(1);
    const [first, duplicate] = await Promise.all([call(1), call(1)]);
    expect(first.status).toBe("succeeded"); expect(duplicate.replayed).toBe(true); expect(executions).toBe(1);
    broker.activate(2);
    expect((await call(2)).replayed).toBe(true); expect(executions).toBe(1);
    await expect(call(2, "second")).rejects.toThrow(/receipt capacity exceeded/);
  });

  it("cancels a capability handler at the broker deadline", async () => {
    const broker = new ScenarioPackageCapabilityBroker({ id: "fixture", version: "1" }, ["fixture.lookup"], [handler(async () =>
      new Promise<never>(() => {}))], { timeoutMs: 10 });
    broker.activate(1);
    await expect(broker.invoke({ provider: { id: "fixture", version: "1", generation: 1 }, parentRequestId: "parent",
      capability: "fixture.lookup", action: "fixture.inspect", idempotencyKey: "deadline", input: {}, attribution: context, depth: 1 }))
      .rejects.toThrow(/deadline exceeded/);
  });

});

function launch(environment: Record<string, string> = {}, profile = true) {
  return { executable: process.execPath, arguments: [resolve("packages/worker-runtime/test-fixtures/tool-provider.mjs")], workingDirectory: resolve("."),
    environment: { TRACEFORGE_TEST_SOURCE: "scenario:fixture", ...(profile ? { TRACEFORGE_TEST_PROTOCOL_PROFILE: SCENARIO_PROCESS_PROTOCOL } : {}),
      ...environment, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
    attestation: { sandboxed: false, backend: "test-process", network: "deny" as const } };
}
