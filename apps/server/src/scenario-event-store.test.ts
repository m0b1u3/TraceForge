import { afterEach, describe, expect, it } from "vitest";
import {
  DurableScenarioRuntime,
  IdempotencyConflictError,
  RevisionConflictError,
  ScenarioDefinitionRegistry,
} from "@traceforge/orchestration-core";
import { WEB_BLACKBOX_CAPABILITIES, WEB_BLACKBOX_SCENARIO } from "./test-fixtures/web-blackbox-descriptor.js";
import type Database from "better-sqlite3";
import { createDb, getSqliteClient } from "./db/client.js";
import { SqliteScenarioEventStore, SqliteWorkerRegistry } from "./scenario-event-store.js";
import { ScenarioControlPlane } from "./scenario-control-plane.js";

const now = "2026-08-24T08:00:00.000Z";
const capabilities = Object.values(WEB_BLACKBOX_CAPABILITIES);
const open: Database.Database[] = [];

function setup() {
  const db = createDb(":memory:");
  const sqlite = getSqliteClient(db);
  open.push(sqlite);
  const store = new SqliteScenarioEventStore(sqlite);
  const runtime = new DurableScenarioRuntime(store, new ScenarioDefinitionRegistry([WEB_BLACKBOX_SCENARIO]));
  return { runtime, store, sqlite };
}

function start(runtime: DurableScenarioRuntime) {
  return runtime.execute({
    commandId: "command_start",
    runId: "run_1",
    expectedRevision: 0,
    definitionKind: "web_blackbox",
    definitionVersion: 1,
    command: {
      type: "start_run",
      runId: "run_1",
      caseId: "case_1",
      goal: "Assess the authorized application",
      scopeRef: "scope_1",
      scenarioPackage: { id: "traceforge.web-blackbox", version: "0.1.0", schemaRevision: 1 },
      availableCapabilities: capabilities,
      at: now,
    },
  });
}

afterEach(() => {
  while (open.length) open.pop()!.close();
});

describe("durable scenario control plane", () => {
  it("persists an event stream and restores it through a fresh runtime", () => {
    const { runtime, store } = setup();
    const started = start(runtime);
    const restored = new DurableScenarioRuntime(store, new ScenarioDefinitionRegistry([WEB_BLACKBOX_SCENARIO])).load("run_1");
    expect(restored).toEqual(started.state);
    expect(restored?.scenarioPackage).toEqual({ id: "traceforge.web-blackbox", version: "0.1.0", schemaRevision: 1 });
    expect(store.listRuns()[0]?.scenarioPackage).toEqual(restored?.scenarioPackage);
    expect(store.load("run_1").revision).toBe(1);
  });

  it("replays identical commands and rejects command id reuse", () => {
    const { runtime, store } = setup();
    const first = start(runtime);
    const duplicate = start(runtime);
    expect(duplicate.idempotentReplay).toBe(true);
    expect(store.load("run_1").revision).toBe(1);
    expect(first.state).toEqual(duplicate.state);

    expect(() => runtime.execute({
      commandId: "command_start",
      runId: "run_1",
      expectedRevision: 0,
      definitionKind: "web_blackbox",
      definitionVersion: 1,
      command: { ...startCommand(), goal: "Different goal" },
    })).toThrow(IdempotencyConflictError);
  });

  it("rejects stale revisions without partially appending events", () => {
    const { runtime, store } = setup();
    start(runtime);
    expect(() => runtime.execute({
      commandId: "command_stale",
      runId: "run_1",
      expectedRevision: 0,
      command: {
        type: "propose_work",
        proposal: {
          id: "work_1",
          kind: "research",
          title: "Collect facts",
          objective: "Collect authorized observations",
          idempotencyKey: "effect_work_1",
        },
        at: "2026-08-24T08:00:01.000Z",
      },
    })).toThrow(RevisionConflictError);
    expect(store.load("run_1").revision).toBe(1);
  });

  it("persists worker capabilities and liveness state", () => {
    const { sqlite } = setup();
    const workers = new SqliteWorkerRegistry(sqlite);
    workers.upsert({
      id: "worker_1",
      roles: ["researcher"],
      capabilities: ["http.request"],
      maxConcurrentWork: 2,
      status: "online",
      heartbeatAt: now,
    }, now);
    workers.setStatus("worker_1", "draining", "2026-08-24T08:00:01.000Z");
    workers.heartbeat("worker_1", "2026-08-24T08:00:02.000Z");
    expect(workers.list()).toEqual([{
      id: "worker_1",
      roles: ["researcher"],
      capabilities: ["http.request"],
      maxConcurrentWork: 2,
      status: "draining",
      heartbeatAt: "2026-08-24T08:00:02.000Z",
    }]);
  });

  it("atomically dispatches work and recovers an expired lease", () => {
    const { runtime, sqlite } = setup();
    const registry = new ScenarioDefinitionRegistry([WEB_BLACKBOX_SCENARIO]);
    const workers = new SqliteWorkerRegistry(sqlite);
    start(runtime);
    runtime.execute({
      commandId: "command_propose",
      runId: "run_1",
      expectedRevision: 1,
      command: {
        type: "propose_work",
        proposal: {
          id: "work_1",
          kind: "research",
          title: "Capture authorized scope",
          objective: "Persist the scope and execution inventory",
          idempotencyKey: "effect_work_1",
        },
        at: "2026-08-24T08:00:01.000Z",
      },
    });
    workers.upsert({
      id: "worker_1",
      roles: ["researcher"],
      capabilities,
      maxConcurrentWork: 1,
      status: "online",
      heartbeatAt: "2026-08-24T08:00:02.000Z",
    }, "2026-08-24T08:00:02.000Z");
    const ids = ["lease_1", "lease_2"];
    const controlPlane = new ScenarioControlPlane(runtime, registry, workers, {
      leaseDurationMs: 1_000,
      heartbeatTimeoutMs: 10_000,
      concurrencyRetries: 3,
    }, () => ids.shift()!);

    const assigned = controlPlane.tick("run_1", "2026-08-24T08:00:03.000Z");
    expect(assigned.assignments).toEqual([{
      workId: "work_1",
      workerId: "worker_1",
      leaseId: "lease_1",
      leaseExpiresAt: "2026-08-24T08:00:04.000Z",
    }]);
    expect(workers.activeWorkCounts()).toEqual({ worker_1: 1 });

    workers.heartbeat("worker_1", "2026-08-24T08:00:05.000Z");
    const recovered = controlPlane.tick("run_1", "2026-08-24T08:00:05.000Z");
    expect(recovered.expiredLeaseIds).toEqual(["lease_1"]);
    expect(recovered.assignments[0]?.leaseId).toBe("lease_2");
    expect(recovered.state?.workItems[0].attempt).toBe(2);
    expect(workers.activeWorkCounts()).toEqual({ worker_1: 1 });
  });
});

function startCommand() {
  return {
    type: "start_run" as const,
    runId: "run_1",
    caseId: "case_1",
    goal: "Assess the authorized application",
    scopeRef: "scope_1",
    scenarioPackage: { id: "traceforge.web-blackbox", version: "0.1.0", schemaRevision: 1 },
    availableCapabilities: capabilities,
    at: now,
  };
}
