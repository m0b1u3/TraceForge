import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { ExtractJsonArgs, LlmProvider } from "@traceforge/llm";
import { createDb, getSqliteClient } from "./db/client.js";
import {
  DEFAULT_MODEL_ROLE_POLICIES,
  ModelBudgetExceededError,
  ModelExecutionRuntime,
  SqliteModelExecutionStore,
  type CognitiveModelRole,
  type ModelRolePolicy,
} from "./model-execution-runtime.js";
import { DEFAULT_MODEL_RESOURCE_POLICY, ModelAdmissionController, SqliteModelAdmissionStore } from "./model-admission-controller.js";
import { SqliteScenarioAgentEventStream } from "./scenario-agent-event-stream.js";

const open: Database.Database[] = [];
const at = "2026-08-25T12:00:00.000Z";
const request: ExtractJsonArgs = { system: "plan", user: "state", schema: { type: "object" } };

function provider(extract: (args: ExtractJsonArgs) => Promise<unknown>): LlmProvider {
  return { extractJson: extract, async runTools() { throw new Error("not used"); } };
}

function setup(
  routes: Array<[string, LlmProvider]>,
  workerPolicy: Partial<ModelRolePolicy> = {},
) {
  const sqlite = getSqliteClient(createDb(":memory:"));
  open.push(sqlite);
  const store = new SqliteModelExecutionStore(sqlite);
  const policies = Object.fromEntries(
    (Object.keys(DEFAULT_MODEL_ROLE_POLICIES) as CognitiveModelRole[]).map((role) => [
      role,
      { ...DEFAULT_MODEL_ROLE_POLICIES[role], ...(role === "worker" ? workerPolicy : {}) },
    ]),
  ) as Record<CognitiveModelRole, ModelRolePolicy>;
  let sequence = 0;
  let eventSequence = 0;
  const agentEvents = new SqliteScenarioAgentEventStream(sqlite, undefined, () => `event_${++eventSequence}`, () => at);
  const admissions = new ModelAdmissionController(
    DEFAULT_MODEL_RESOURCE_POLICY,
    new SqliteModelAdmissionStore(sqlite),
    () => `admission_${++sequence}`,
    () => at,
    Date.now,
    agentEvents,
  );
  const runtime = new ModelExecutionRuntime(new Map(routes), policies, store, admissions, () => `call_${++sequence}`, () => at, agentEvents);
  return { runtime, store, agentEvents };
}

function context(runId = "run_1") {
  return { role: "worker" as const, snapshotId: `snapshot_${runId}`, runId, caseId: "case_1", workId: "work_1" };
}

afterEach(() => {
  while (open.length) open.pop()!.close();
});

describe("role-aware model execution runtime", () => {
  it("falls back to the next route and records actual usage", async () => {
    const primary = provider(async () => { throw Object.assign(new Error("upstream unavailable"), { status: 503 }); });
    const backup = provider(async (args) => {
      args.onUsage?.({ promptTokens: 8, completionTokens: 4, totalTokens: 12 });
      return { action: "complete" };
    });
    const { runtime, store } = setup([["primary", primary], ["backup", backup]], {
      routeIds: ["primary", "backup"],
      maximumAttemptsPerRoute: 1,
    });

    await expect(runtime.extractJson(context(), request)).resolves.toEqual({ action: "complete" });
    expect(store.list("run_1")).toEqual([
      expect.objectContaining({ routeId: "primary", status: "failed", routeAttempt: 1 }),
      expect.objectContaining({ routeId: "backup", status: "completed", promptTokens: 8, completionTokens: 4, totalTokens: 12 }),
    ]);
    expect(store.usage("run_1", "worker")).toMatchObject({ promptTokens: 8, completionTokens: 4, totalTokens: 12 });
  });

  it("opens a route circuit and skips it on subsequent calls", async () => {
    let primaryCalls = 0;
    const primary = provider(async () => {
      primaryCalls += 1;
      throw Object.assign(new Error("network failure"), { code: "ECONNRESET" });
    });
    const backup = provider(async () => ({ action: "wait" }));
    const { runtime, store } = setup([["primary", primary], ["backup", backup]], {
      routeIds: ["primary", "backup"],
      maximumAttemptsPerRoute: 1,
      circuitFailureThreshold: 1,
    });

    await runtime.extractJson(context("run_1"), request);
    await runtime.extractJson(context("run_2"), request);
    expect(primaryCalls).toBe(1);
    expect(store.circuit("worker", "primary")).toMatchObject({ consecutiveFailures: 1, openUntil: expect.any(String) });
    expect(store.list("run_2")).toEqual([expect.objectContaining({ routeId: "backup", status: "completed" })]);
  });

  it("rejects a call before provider execution when the Run budget is exhausted", async () => {
    let calls = 0;
    const primary = provider(async (args) => {
      calls += 1;
      args.onUsage?.({ promptTokens: 3, completionTokens: 1, totalTokens: 4 });
      return { action: "wait" };
    });
    const { runtime } = setup([["primary", primary]], { maximumRunTokens: 10, maximumAttemptsPerRoute: 1 });

    await runtime.extractJson(context(), request);
    await expect(runtime.extractJson(context(), request)).rejects.toBeInstanceOf(ModelBudgetExceededError);
    expect(calls).toBe(1);
  });

  it("aborts a timed-out provider call and records the timeout", async () => {
    const hanging = provider(async (args) => new Promise((_resolve, reject) => {
      args.signal?.addEventListener("abort", () => reject(args.signal?.reason), { once: true });
    }));
    const { runtime, store } = setup([["primary", hanging]], { timeoutMs: 5, maximumAttemptsPerRoute: 1 });

    await expect(runtime.extractJson(context(), request)).rejects.toBeTruthy();
    expect(store.list("run_1")).toEqual([expect.objectContaining({ status: "timed_out", routeId: "primary" })]);
  });

  it("cancels an active provider call when its Run is cancelled without opening the route circuit", async () => {
    let started!: () => void;
    const providerStarted = new Promise<void>((resolve) => { started = resolve; });
    const hanging = provider(async (args) => new Promise((_resolve, reject) => {
      started();
      args.signal?.addEventListener("abort", () => reject(args.signal?.reason), { once: true });
    }));
    const { runtime, store } = setup([["primary", hanging]], { maximumAttemptsPerRoute: 1 });

    const pending = runtime.extractJson(context(), request);
    await providerStarted;
    runtime.cancelRun("run_1", "operator cancelled Run");

    await expect(pending).rejects.toThrow("operator cancelled Run");
    expect(store.circuit("worker", "primary").consecutiveFailures).toBe(0);
  });

  it("publishes one canonical item lifecycle for admission and Provider execution", async () => {
    const primary = provider(async (args) => {
      args.onUsage?.({ promptTokens: 2, completionTokens: 1, totalTokens: 3 });
      return { action: "complete" };
    });
    const { runtime, agentEvents } = setup([["primary", primary]], { maximumAttemptsPerRoute: 1 });
    await runtime.extractJson(context(), request);

    const events = agentEvents.list("run_1").events;
    expect(events.map((event) => event.method)).toEqual([
      "item/started", "item/updated", "item/started", "item/completed", "item/completed",
    ]);
    expect(events.filter((event) => event.method === "item/completed").map((event) => event.params.item.type))
      .toEqual(["modelCall", "modelAdmission"]);
  });
});
