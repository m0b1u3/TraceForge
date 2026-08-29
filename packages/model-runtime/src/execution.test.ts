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

function setup(routes: Array<[string, ModelJsonProviderPort]>, workerPolicy: Partial<ModelRolePolicy> = {}) {
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
    runtime: new ModelExecutionRuntime(new Map(routes), policies, store, new ImmediateAdmission(), () => `call.${++id}`, () => at),
  };
}

describe("model execution runtime integration harness", () => {
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
});
