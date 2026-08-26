import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createDb, getSqliteClient } from "./db/client.js";
import {
  DEFAULT_MODEL_RESOURCE_POLICY,
  ModelAdmissionController,
  SqliteModelAdmissionStore,
  type ModelResourcePolicy,
} from "./model-admission-controller.js";

const databases: Database.Database[] = [];
const at = "2026-08-25T12:00:00.000Z";

function context(runId: string, role: "planner" | "observer" | "worker", workId?: string) {
  return { snapshotId: `snapshot_${runId}_${role}`, runId, caseId: "case_1", workId, role };
}

function setup(overrides: Partial<ModelResourcePolicy> = {}) {
  const sqlite = getSqliteClient(createDb(":memory:"));
  databases.push(sqlite);
  const store = new SqliteModelAdmissionStore(sqlite);
  const policy: ModelResourcePolicy = {
    ...DEFAULT_MODEL_RESOURCE_POLICY,
    ...overrides,
    roleConcurrency: { ...DEFAULT_MODEL_RESOURCE_POLICY.roleConcurrency, ...overrides.roleConcurrency },
    rolePriorities: { ...DEFAULT_MODEL_RESOURCE_POLICY.rolePriorities, ...overrides.rolePriorities },
  };
  let id = 0;
  const controller = new ModelAdmissionController(policy, store, () => `admission_${++id}`, () => at);
  return { controller, store };
}

afterEach(() => {
  while (databases.length) databases.pop()!.close();
});

describe("model admission controller", () => {
  it("prioritizes Observer work while preserving bounded global concurrency", async () => {
    const { controller, store } = setup({ maximumConcurrentCalls: 1 });
    const first = await controller.acquire(context("run_1", "worker", "work_1"));
    let workerAdmitted = false;
    const worker = controller.acquire(context("run_2", "worker", "work_2")).then((permit) => { workerAdmitted = true; return permit; });
    const observer = controller.acquire(context("run_3", "observer"));

    first.release("completed");
    const observerPermit = await observer;
    expect(workerAdmitted).toBe(false);
    expect(controller.snapshot()).toMatchObject({ active: 1, queued: 1, activeByRole: { observer: 1 } });
    observerPermit.release("completed");
    const workerPermit = await worker;
    workerPermit.release("completed");

    expect(store.list("run_3")[0]).toMatchObject({ role: "observer", status: "released", outcome: "completed" });
  });

  it("enforces per-Run concurrency without blocking another Run", async () => {
    const { controller } = setup({ maximumConcurrentCalls: 2, maximumConcurrentCallsPerRun: 1 });
    const first = await controller.acquire(context("run_1", "worker", "work_1"));
    let sameRunAdmitted = false;
    const sameRun = controller.acquire(context("run_1", "observer")).then((permit) => { sameRunAdmitted = true; return permit; });
    const otherRun = await controller.acquire(context("run_2", "worker", "work_2"));
    expect(sameRunAdmitted).toBe(false);
    otherRun.release("completed");
    first.release("completed");
    (await sameRun).release("completed");
  });

  it("cancels queued admissions for a cancelled Work", async () => {
    const { controller, store } = setup({ maximumConcurrentCalls: 1 });
    const active = await controller.acquire(context("run_1", "worker", "work_1"));
    const queued = controller.acquire(context("run_1", "worker", "work_2"));
    controller.cancelWork("run_1", "work_2", "branch closed");
    await expect(queued).rejects.toThrow("branch closed");
    expect(store.list("run_1").find((record) => record.workId === "work_2")).toMatchObject({ status: "cancelled", outcome: "cancelled" });
    active.release("completed");
  });

  it("marks admissions left by a previous process as interrupted", () => {
    const sqlite = getSqliteClient(createDb(":memory:"));
    databases.push(sqlite);
    const store = new SqliteModelAdmissionStore(sqlite);
    store.enqueue("orphan", context("run_1", "planner"), 80, at);
    new ModelAdmissionController(DEFAULT_MODEL_RESOURCE_POLICY, store, () => "unused", () => at);
    expect(store.list("run_1")[0]).toMatchObject({ status: "interrupted", outcome: "cancelled", reason: "runtime restarted before release" });
  });
});
