import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL_RESOURCE_POLICY,
  ModelAdmissionController,
  type ModelAdmissionOutcome,
  type ModelAdmissionStatus,
  type ModelAdmissionStore,
  type ModelCallContext,
  type ModelResourcePolicy,
} from "./index.js";

interface StoredAdmission {
  context: ModelCallContext;
  priority: number;
  status: ModelAdmissionStatus;
  outcome: ModelAdmissionOutcome;
}

class MemoryAdmissionStore implements ModelAdmissionStore {
  readonly records = new Map<string, StoredAdmission>();
  interrupted = 0;

  recoverInterrupted(): number { return this.interrupted; }
  enqueue(id: string, context: ModelCallContext, priority: number): void {
    this.records.set(id, { context, priority, status: "queued", outcome: null });
  }
  admit(id: string): void { this.records.get(id)!.status = "admitted"; }
  finish(id: string, status: Exclude<ModelAdmissionStatus, "queued" | "admitted" | "interrupted">, outcome: ModelAdmissionOutcome): void {
    Object.assign(this.records.get(id)!, { status, outcome });
  }
}

function context(runId: string, role: ModelCallContext["role"], workId?: string): ModelCallContext {
  return { snapshotId: `snapshot.${runId}.${role}`, runId, caseId: "case.first", workId, role };
}

function setup(overrides: Partial<ModelResourcePolicy> = {}) {
  const store = new MemoryAdmissionStore();
  const policy: ModelResourcePolicy = {
    ...DEFAULT_MODEL_RESOURCE_POLICY,
    ...overrides,
    roleConcurrency: { ...DEFAULT_MODEL_RESOURCE_POLICY.roleConcurrency, ...overrides.roleConcurrency },
    rolePriorities: { ...DEFAULT_MODEL_RESOURCE_POLICY.rolePriorities, ...overrides.rolePriorities },
  };
  let id = 0;
  const controller = new ModelAdmissionController(policy, store, () => `admission.${++id}`, () => "2026-08-28T00:00:00.000Z", () => 0);
  return { controller, store };
}

describe("model admission runtime integration harness", () => {
  it("runs without Fastify or a database and prioritizes higher-priority cognitive work", async () => {
    const { controller, store } = setup({ maximumConcurrentCalls: 1 });
    const active = await controller.acquire(context("run.first", "worker", "work.first"));
    let lowerPriorityAdmitted = false;
    const lowerPriority = controller.acquire(context("run.second", "worker", "work.second"))
      .then((permit) => { lowerPriorityAdmitted = true; return permit; });
    const higherPriority = controller.acquire(context("run.third", "observer"));

    active.release("completed");
    const higherPriorityPermit = await higherPriority;
    expect(lowerPriorityAdmitted).toBe(false);
    expect(store.records.get(higherPriorityPermit.id)?.status).toBe("admitted");
    higherPriorityPermit.release("completed");
    (await lowerPriority).release("completed");
  });

  it("enforces per-Run concurrency through the store port", async () => {
    const { controller } = setup({ maximumConcurrentCalls: 2, maximumConcurrentCallsPerRun: 1 });
    const first = await controller.acquire(context("run.first", "worker", "work.first"));
    let sameRunAdmitted = false;
    const sameRun = controller.acquire(context("run.first", "observer"))
      .then((permit) => { sameRunAdmitted = true; return permit; });
    const otherRun = await controller.acquire(context("run.second", "worker", "work.second"));
    expect(sameRunAdmitted).toBe(false);
    otherRun.release("completed");
    first.release("completed");
    (await sameRun).release("completed");
  });
});
