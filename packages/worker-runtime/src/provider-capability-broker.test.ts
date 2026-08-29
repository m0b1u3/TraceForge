import { describe, expect, it } from "vitest";
import type { EffectivePermissionProfile } from "@traceforge/orchestration-core";
import {
  ProviderCapabilityBroker,
  type ProviderCapabilityAuthorizationDecision,
  type ProviderCapabilityInvocation,
  type ProviderCapabilityReceipt,
  type ProviderCapabilityReceiptPort,
} from "./provider-capability-broker.js";

const permissions: EffectivePermissionProfile = {
  version: 1,
  platform: "linux",
  filesystem: { read: [], write: [], deny: [] },
  network: "deny",
  process: { access: "sandboxed", interactive: false, background: false },
  secrets: "handles_only",
  sources: ["fixture-policy"],
};

class MemoryReceipts implements ProviderCapabilityReceiptPort {
  readonly values = new Map<string, ProviderCapabilityReceipt>();
  readonly history: ProviderCapabilityReceipt[] = [];
  async get(providerId: string, idempotencyKey: string) { return this.values.get(`${providerId}:${idempotencyKey}`); }
  async put(receipt: ProviderCapabilityReceipt) {
    this.values.set(`${receipt.provider.id}:${receipt.idempotencyKey}`, receipt);
    this.history.push(receipt);
  }
}

function invocation(overrides: Partial<ProviderCapabilityInvocation> = {}): ProviderCapabilityInvocation {
  return {
    provider: { id: "provider.fixture", version: "1.0.0", generation: 1 },
    parentRequestId: "tool-call-1",
    capability: "fixture.lookup",
    action: "fixture.inspect",
    idempotencyKey: "capability-call-1",
    input: { subject: "first candidate" },
    attribution: {
      caseId: "case-1",
      runId: "run-1",
      workId: "work-1",
      workerId: "worker-1",
      scopeRef: "scope-1",
      leaseId: "lease-1",
      leaseExpiresAt: "2100-01-01T00:00:00.000Z",
      idempotencyKey: "tool-effect-1",
      effectivePermissions: permissions,
    },
    depth: 1,
    ...overrides,
  };
}

function broker(input: {
  receipts?: MemoryReceipts;
  authorize?: (call: ProviderCapabilityInvocation) => Promise<ProviderCapabilityAuthorizationDecision>;
  execute?: (call: ProviderCapabilityInvocation, signal: AbortSignal) => Promise<{ output: unknown; refs: string[] }>;
  limits?: ConstructorParameters<typeof ProviderCapabilityBroker>[0]["limits"];
} = {}) {
  let ids = 0;
  return new ProviderCapabilityBroker({
    receipts: input.receipts ?? new MemoryReceipts(),
    authorizer: { authorize: input.authorize ?? (async () => ({ decision: "approved", authorizationRef: "authorization-1" })) },
    handlers: [{
      capability: "fixture.lookup",
      execute: input.execute ?? (async () => ({ output: { state: "available" }, refs: ["evidence:first"] })),
    }],
    limits: input.limits,
    createId: () => `receipt-${++ids}`,
    now: () => "2026-08-28T12:00:00.000Z",
  });
}

describe("ProviderCapabilityBroker", () => {
  it("authorizes a neutral capability, preserves trusted ownership, and persists its receipt", async () => {
    const receipts = new MemoryReceipts();
    let authorized: ProviderCapabilityInvocation | undefined;
    let handled: ProviderCapabilityInvocation | undefined;
    const runtime = broker({
      receipts,
      authorize: async (call) => { authorized = call; return { decision: "approved", authorizationRef: "authorization-1" }; },
      execute: async (call) => { handled = call; return { output: { state: "available" }, refs: ["evidence:first"] }; },
    });

    const result = await runtime.invoke(invocation());

    expect(authorized?.attribution).toMatchObject({ runId: "run-1", workId: "work-1", workerId: "worker-1", leaseId: "lease-1" });
    expect(handled?.action).toBe("fixture.inspect");
    expect(result).toMatchObject({
      id: "receipt-1", status: "succeeded", authorizationRef: "authorization-1",
      refs: ["evidence:first"], attribution: { caseId: "case-1", scopeRef: "scope-1" },
    });
    expect(result.attribution).not.toHaveProperty("effectivePermissions");
    expect(receipts.values.size).toBe(1);
  });

  it("replays identical calls and rejects idempotency-key reuse with different input", async () => {
    let executions = 0;
    const runtime = broker({ execute: async () => { executions += 1; return { output: {}, refs: [] }; } });

    const first = await runtime.invoke(invocation());
    const replay = await runtime.invoke(invocation({
      provider: { id: "provider.fixture", version: "1.0.0", generation: 2 },
      parentRequestId: "tool-call-after-restart",
      attribution: { ...invocation().attribution, leaseExpiresAt: "2100-02-01T00:00:00.000Z" },
    }));

    expect(first.replayed).toBeUndefined();
    expect(replay.replayed).toBe(true);
    expect(executions).toBe(1);
    await expect(runtime.invoke(invocation({ input: { subject: "second candidate" } }))).rejects.toThrow(/reused with different input/);
  });

  it("records rejected and approval-pending decisions without invoking the handler", async () => {
    let executions = 0;
    let decision: ProviderCapabilityAuthorizationDecision = { decision: "rejected", reason: "outside granted scope" };
    const runtime = broker({
      authorize: async () => decision,
      execute: async () => { executions += 1; return { output: {}, refs: [] }; },
    });

    expect(await runtime.invoke(invocation())).toMatchObject({ status: "rejected", reason: "outside granted scope" });
    decision = { decision: "pending", approvalRef: "approval-1" };
    expect(await runtime.invoke(invocation({ idempotencyKey: "capability-call-2" }))).toMatchObject({
      status: "approval_required", approvalRef: "approval-1", retryable: true,
    });
    expect(executions).toBe(0);
  });

  it("re-authorizes a durable approval-pending call and executes it after approval", async () => {
    const receipts = new MemoryReceipts();
    let approved = false;
    let executions = 0;
    const runtime = broker({
      receipts,
      authorize: async () => approved
        ? { decision: "approved", authorizationRef: "authorization-1" }
        : { decision: "pending", approvalRef: "approval-1" },
      execute: async () => { executions += 1; return { output: {}, refs: [] }; },
    });

    expect(await runtime.invoke(invocation())).toMatchObject({ status: "approval_required" });
    approved = true;
    expect(await runtime.invoke(invocation())).toMatchObject({ status: "succeeded" });
    expect(executions).toBe(1);
    expect(receipts.history.map((receipt) => receipt.status)).toEqual(["approval_required", "succeeded"]);
  });

  it("enforces depth, request-size, lease, and registered-capability boundaries before execution", async () => {
    const runtime = broker({ limits: { maximumRequestBytes: 32 } });

    expect(await runtime.invoke(invocation({ idempotencyKey: "depth", depth: 2 }))).toMatchObject({ status: "rejected", reason: expect.stringContaining("depth") });
    expect(await runtime.invoke(invocation({ idempotencyKey: "bytes", input: { content: "x".repeat(64) } }))).toMatchObject({ status: "rejected", reason: expect.stringContaining("bytes") });
    expect(await runtime.invoke(invocation({ idempotencyKey: "lease", attribution: { ...invocation().attribution, leaseExpiresAt: "2020-01-01T00:00:00.000Z" } }))).toMatchObject({ status: "rejected", reason: expect.stringContaining("expired") });
    expect(await runtime.invoke(invocation({ idempotencyKey: "unknown", capability: "fixture.unknown" }))).toMatchObject({ status: "rejected", reason: expect.stringContaining("not registered") });
  });

  it("coalesces matching in-flight calls and limits independent calls per provider", async () => {
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let executions = 0;
    const runtime = broker({
      limits: { maximumConcurrentPerProvider: 1 },
      execute: async () => {
        executions += 1;
        started();
        await blocked;
        return { output: {}, refs: [] };
      },
    });

    const first = runtime.invoke(invocation());
    await entered;
    const duplicate = runtime.invoke(invocation());
    const limited = await runtime.invoke(invocation({ idempotencyKey: "capability-call-2" }));
    expect(limited).toMatchObject({ status: "rejected", retryable: true, reason: expect.stringContaining("concurrency") });
    release();
    expect(await first).toMatchObject({ status: "succeeded" });
    expect(await duplicate).toMatchObject({ status: "succeeded", replayed: true });
    expect(executions).toBe(1);
  });

  it("aborts timed-out handlers and records a retryable failure", async () => {
    let aborted = false;
    const runtime = broker({
      limits: { timeoutMs: 5 },
      execute: async (_call, signal) => new Promise((resolve) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          resolve({ output: {}, refs: [] });
        });
      }),
    });

    const result = await runtime.invoke(invocation());

    expect(aborted).toBe(true);
    expect(result).toMatchObject({ status: "failed", retryable: true, reason: expect.stringContaining("timed out") });
  });
});
