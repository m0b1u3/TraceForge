import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import {
  DurableScenarioRuntime,
  ScenarioDefinitionRegistry,
  WEB_BLACKBOX_CAPABILITIES,
  WEB_BLACKBOX_SCENARIO,
} from "@traceforge/orchestration-core";
import { createDb, getSqliteClient } from "./db/client.js";
import { SqliteEvidenceGraphStore } from "./evidence-graph-store.js";
import { SqliteScenarioEventStore } from "./scenario-event-store.js";
import {
  RunObserverSupervisor,
  SqliteRunObserverStore,
  type RunObserverDecision,
  type RunObserverModel,
} from "./run-observer.js";

const open: Database.Database[] = [];
const at = "2026-08-25T08:00:00.000Z";

class FixedObserver implements RunObserverModel {
  calls = 0;
  constructor(private readonly decision: RunObserverDecision) {}
  async evaluate() { this.calls += 1; return this.decision; }
}

function setup(decision: RunObserverDecision) {
  const sqlite = getSqliteClient(createDb(":memory:"));
  open.push(sqlite);
  const definitions = new ScenarioDefinitionRegistry([WEB_BLACKBOX_SCENARIO]);
  const events = new SqliteScenarioEventStore(sqlite);
  const runtime = new DurableScenarioRuntime(events, definitions);
  let state = runtime.execute({
    runId: "run_1", commandId: "start", expectedRevision: 0,
    definitionKind: "web_blackbox", definitionVersion: 1,
    command: {
      type: "start_run", runId: "run_1", caseId: "case_1", goal: "Assess authorized surface",
      scopeRef: "scope_1", availableCapabilities: Object.values(WEB_BLACKBOX_CAPABILITIES), at,
    },
  }).state;
  state = runtime.execute({
    runId: state.id, commandId: "work", expectedRevision: state.revision,
    command: { type: "propose_work", proposal: {
      id: "work_1", kind: "research", title: "Map surface", objective: "Collect attributable observations",
      idempotencyKey: "effect_work_1",
    }, at },
  }).state;
  const model = new FixedObserver(decision);
  const observerStore = new SqliteRunObserverStore(sqlite);
  const supervisor = new RunObserverSupervisor(
    runtime, definitions, events, new SqliteEvidenceGraphStore(sqlite), observerStore, model,
    { errorBackoffMs: 1_000, concurrencyRetries: 3 }, () => "evaluation_1", () => at,
  );
  return { runtime, model, observerStore, supervisor };
}

afterEach(() => {
  while (open.length) open.pop()!.close();
});

describe("independent Run Observer", () => {
  it("persists and injects a structured steering directive exactly once", async () => {
    const { runtime, model, observerStore, supervisor } = setup({
      action: "steer", workId: "work_1", instruction: "Compare current coverage with unexplored entities before another request.",
      rationale: "The branch has produced no new graph state.",
    });
    await supervisor.tick();
    const state = runtime.load("run_1")!;
    expect(state.directives).toEqual([expect.objectContaining({ id: "evaluation_1", targetWorkId: "work_1", issuedBy: "observer" })]);
    expect(observerStore.list("run_1")[0]).toMatchObject({ applied: true, resultingRunRevision: state.revision });
    await supervisor.tick();
    expect(model.calls).toBe(1);
    expect(runtime.load("run_1")!.directives).toHaveLength(1);
  });

  it("can terminate one branch without cancelling the Run", async () => {
    const { runtime, supervisor } = setup({ action: "terminate_branch", workId: "work_1", reason: "The branch duplicates a disproved premise." });
    await supervisor.tick();
    const state = runtime.load("run_1")!;
    expect(state.status).toBe("running");
    expect(state.workItems[0].status).toBe("cancelled");
  });
});
