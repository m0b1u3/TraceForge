import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL_ROLE_POLICIES,
  ModelBudgetExceededError,
  ModelExecutionRuntime,
  type CognitiveModelRole,
  type ModelAdmissionPort,
  type ModelCallContext,
  type ModelExecutionStore,
  type ModelJsonProviderPort,
  type ModelRolePolicy,
  type ModelUsageSnapshot,
} from "./index.js";

interface CallRecord {
  id: string;
  context: ModelCallContext;
  routeId: string;
  reservedTokens: number;
  status: "running" | "completed" | "failed" | "timed_out";
  usage: ModelUsageSnapshot;
}

class MemoryExecutionStore implements ModelExecutionStore {
  readonly calls: CallRecord[] = [];
  readonly circuits = new Map<string, { consecutiveFailures: number; openUntil: string | null }>();

  recoverInterrupted(): number { return 0; }
  reserve(input: Parameters<ModelExecutionStore["reserve"]>[0]): void {
    const accounted = this.calls
      .filter((call) => call.context.runId === input.context.runId && call.context.role === input.context.role)
      .reduce((total, call) => total + Math.max(call.reservedTokens, call.usage.totalTokens), 0);
    if (accounted + input.reservedTokens > input.maximumRunTokens) {
      throw new ModelBudgetExceededError(input.context.runId, input.context.role, input.maximumRunTokens, accounted, input.reservedTokens);
    }
    this.calls.push({
      id: input.id,
      context: input.context,
      routeId: input.routeId,
      reservedTokens: input.reservedTokens,
      status: "running",
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    });
  }
  finish(id: string, status: "completed" | "failed" | "timed_out", usage: ModelUsageSnapshot): void {
    Object.assign(this.calls.find((call) => call.id === id)!, { status, usage });
  }
  circuit(role: CognitiveModelRole, routeId: string) {
    return this.circuits.get(`${role}:${routeId}`) ?? { consecutiveFailures: 0, openUntil: null };
  }
  recordRouteSuccess(role: CognitiveModelRole, routeId: string): void {
    this.circuits.set(`${role}:${routeId}`, { consecutiveFailures: 0, openUntil: null });
  }
  recordRouteFailure(role: CognitiveModelRole, routeId: string, threshold: number, resetMs: number, at: string): void {
    const key = `${role}:${routeId}`;
    const failures = this.circuit(role, routeId).consecutiveFailures + 1;
    this.circuits.set(key, {
      consecutiveFailures: failures,
      openUntil: failures >= threshold ? new Date(Date.parse(at) + resetMs).toISOString() : null,
    });
  }
}

class ImmediateAdmission implements ModelAdmissionPort {
  acquire() { return Promise.resolve({ id: "permit", release() {} }); }
  cancelRun() {}
  cancelWork() {}
  shutdown() {}
}

const request = { system: "first system", user: "first state", schema: { type: "object" } };
const at = "2026-08-28T00:00:00.000Z";

function context(runId = "run.first"): ModelCallContext {
  return { role: "worker", snapshotId: `snapshot.${runId}`, runId, caseId: "case.first", workId: "work.first" };
}

function provider(extractJson: ModelJsonProviderPort["extractJson"]): ModelJsonProviderPort {
  return { extractJson };
}

function setup(routes: Array<[string, ModelJsonProviderPort]>, workerPolicy: Partial<ModelRolePolicy> = {}, admissions: ModelAdmissionPort = new ImmediateAdmission()) {
  const policies = Object.fromEntries(
    (Object.keys(DEFAULT_MODEL_ROLE_POLICIES) as CognitiveModelRole[]).map((role) => [
      role,
      { ...DEFAULT_MODEL_ROLE_POLICIES[role], ...(role === "worker" ? workerPolicy : {}) },
    ]),
  ) as Record<CognitiveModelRole, ModelRolePolicy>;
  const store = new MemoryExecutionStore();
  let id = 0;
  return {
    store,
    runtime: new ModelExecutionRuntime(new Map(routes), policies, store, admissions, () => `call.${++id}`, () => at),
  };
}

describe("model execution runtime integration harness", () => {
  it("rechecks authorization changed during admission queueing before invoking any model", async () => {
    let admit!: (value: { id: string; release(): void }) => void; let queued!: () => void;
    const waiting = new Promise<void>((resolve) => { queued = resolve; }); let allowed = true; let checks = 0; let calls = 0;
    const admissions: ModelAdmissionPort = { acquire: async () => { queued(); return new Promise((resolve) => { admit = resolve; }); }, cancelRun() {}, cancelWork() {}, shutdown() {} };
    const { runtime } = setup([["primary", provider(async () => { calls++; })]], {}, admissions);
    const pending = runtime.extractJson(context(), { ...request, beforeDispatch: () => { checks++; if (!allowed) throw new Error("Resource withdrawn"); } });
    await waiting; expect(checks).toBe(0); allowed = false; admit({ id: "permit", release() {} });
    await expect(pending).rejects.toThrow("withdrawn"); expect(checks).toBe(1); expect(calls).toBe(0);
  });
  it("checks host policy immediately before dispatch and does not expose the check to providers", async () => {
    let checked = false;
    const { runtime } = setup([["primary", provider(async (input) => {
      expect(checked).toBe(true); expect(input).not.toHaveProperty("beforeDispatch"); return {};
    })]]);
    await runtime.extractJson(context(), { ...request, beforeDispatch: () => { checked = true; } });
  });
  it("does not dispatch, fail over, or trip provider circuits after host policy rejection", async () => {
    let calls = 0;
    const { runtime, store } = setup([["primary", provider(async () => { calls++; })], ["backup", provider(async () => { calls++; })]], { routeIds: ["primary", "backup"] });
    await expect(runtime.extractJson(context(), { ...request, beforeDispatch: () => { throw new Error("Resource revoked"); } })).rejects.toThrow("revoked");
    expect(calls).toBe(0); expect(store.calls).toHaveLength(1); expect(store.calls[0]!.status).toBe("failed"); expect(store.circuits.size).toBe(0);
  });
  it("bounds a non-cooperating policy check and never dispatches its late completion", async () => {
    let calls = 0; let release!: () => void;
    const { runtime } = setup([["primary", provider(async () => { calls++; })]], { timeoutMs: 10, maximumAttemptsPerRoute: 1 });
    await expect(runtime.extractJson(context(), { ...request, beforeDispatch: () => new Promise<void>((resolve) => { release = resolve; }) })).rejects.toThrow("timed out");
    release(); await Promise.resolve(); await Promise.resolve(); expect(calls).toBe(0);
  });
  it("falls back across provider ports and records actual usage without Server dependencies", async () => {
    const primary = provider(async () => { throw Object.assign(new Error("first route unavailable"), { status: 503 }); });
    const backup = provider(async (input) => {
      input.onUsage?.({ promptTokens: 8, completionTokens: 4, totalTokens: 12 });
      return { action: "complete" };
    });
    const { runtime, store } = setup([["primary", primary], ["backup", backup]], {
      routeIds: ["primary", "backup"], maximumAttemptsPerRoute: 1,
    });

    await expect(runtime.extractJson(context(), request)).resolves.toEqual({ action: "complete" });
    expect(store.calls.map((call) => [call.routeId, call.status, call.usage.totalTokens])).toEqual([
      ["primary", "failed", 0],
      ["backup", "completed", 12],
    ]);
  });

  it("opens a failing route circuit and skips it for later calls", async () => {
    let primaryCalls = 0;
    const primary = provider(async () => {
      primaryCalls += 1;
      throw Object.assign(new Error("network failure"), { code: "ECONNRESET" });
    });
    const backup = provider(async () => ({ action: "wait" }));
    const { runtime } = setup([["primary", primary], ["backup", backup]], {
      routeIds: ["primary", "backup"], maximumAttemptsPerRoute: 1, circuitFailureThreshold: 1,
    });

    await runtime.extractJson(context("run.first"), request);
    await runtime.extractJson(context("run.second"), request);
    expect(primaryCalls).toBe(1);
  });

  it("enforces the Run budget through an atomic Store reservation", async () => {
    let providerCalls = 0;
    const route = provider(async (input) => {
      providerCalls += 1;
      input.onUsage?.({ promptTokens: 3, completionTokens: 1, totalTokens: 4 });
      return { action: "wait" };
    });
    const { runtime } = setup([["primary", route]], { maximumRunTokens: 10, maximumAttemptsPerRoute: 1 });

    await runtime.extractJson(context(), request);
    await expect(runtime.extractJson(context(), request)).rejects.toBeInstanceOf(ModelBudgetExceededError);
    expect(providerCalls).toBe(1);
  });

  it("aborts a timed-out provider through the provider port", async () => {
    const hanging = provider(async (input) => new Promise((_resolve, reject) => {
      input.signal?.addEventListener("abort", () => reject(input.signal?.reason), { once: true });
    }));
    const { runtime, store } = setup([["primary", hanging]], { timeoutMs: 5, maximumAttemptsPerRoute: 1 });

    await expect(runtime.extractJson(context(), request)).rejects.toBeTruthy();
    expect(store.calls[0]?.status).toBe("timed_out");
  });

  it("settles its deadline when the provider ignores cancellation and ignores late usage/results", async () => {
    let resolve!: (value: unknown) => void;
    let input!: Parameters<ModelJsonProviderPort["extractJson"]>[0];
    const hanging = provider((value) => { input = value; return new Promise((done) => { resolve = done; }); });
    const { runtime, store } = setup([["primary", hanging]], { timeoutMs: 10, maximumAttemptsPerRoute: 1 });
    let usageCallbacks = 0;
    await expect(runtime.extractJson(context(), { ...request, onUsage() { usageCallbacks++; } })).rejects.toThrow("timed out");
    expect(store.calls[0]?.status).toBe("timed_out");
    input.onUsage?.({ promptTokens: 10, completionTokens: 10, totalTokens: 20 });
    resolve({ action: "late" });
    await new Promise((done) => setTimeout(done, 0));
    expect(store.calls[0]?.status).toBe("timed_out");
    expect(store.calls[0]?.usage.totalTokens).toBe(0); expect(usageCallbacks).toBe(0);
  });

  it.each(["run", "work", "shutdown"])("settles %s cancellation even when the provider ignores it", async (kind) => {
    let started!: () => void;
    const ready = new Promise<void>((done) => { started = done; });
    const hanging = provider(() => { started(); return new Promise(() => {}); });
    const { runtime, store } = setup([["primary", hanging]], { maximumAttemptsPerRoute: 1 });
    const pending = runtime.extractJson(context(), request);
    const assertion = expect(pending).rejects.toThrow();
    await ready;
    if (kind === "run") runtime.cancelRun(context().runId);
    else if (kind === "work") runtime.cancelWork(context().runId, context().workId!);
    else runtime.shutdown();
    await assertion;
    expect(store.calls).toHaveLength(1); expect(store.calls[0]?.status).toBe("failed");
    expect(store.circuits.size).toBe(0);
  });
});
