import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import {
  DurableScenarioRuntime,
  ScenarioDefinitionRegistry,
} from "@traceforge/orchestration-core";
import { WEB_BLACKBOX_CAPABILITIES, WEB_BLACKBOX_SCENARIO } from "@traceforge/scenario-web-blackbox";
import { createDb, getSqliteClient } from "./db/client.js";
import { SqliteEvidenceGraphStore } from "./evidence-graph-store.js";
import { SqliteScenarioEventStore } from "./scenario-event-store.js";
import {
  planningFingerprint,
  RunPlannerSupervisor,
  SqliteRunPlannerStore,
  type RunPlannerDecision,
  type RunPlannerModel,
} from "./run-planner.js";

const open: Database.Database[] = [];
const at = "2026-08-25T09:00:00.000Z";
const capabilities = Object.values(WEB_BLACKBOX_CAPABILITIES);

class SequencePlanner implements RunPlannerModel {
  calls = 0;

  constructor(private readonly decisions: RunPlannerDecision[]) {}

  async evaluate(): Promise<RunPlannerDecision> {
    const decision = this.decisions[this.calls];
    this.calls += 1;
    if (!decision) throw new Error("Unexpected Planner evaluation");
    return decision;
  }
}

function setup(decisions: RunPlannerDecision[]) {
  const sqlite = getSqliteClient(createDb(":memory:"));
  open.push(sqlite);
  const definitions = new ScenarioDefinitionRegistry([WEB_BLACKBOX_SCENARIO]);
  const events = new SqliteScenarioEventStore(sqlite);
  const runtime = new DurableScenarioRuntime(events, definitions);
  const graphs = new SqliteEvidenceGraphStore(sqlite);
  const plannerStore = new SqliteRunPlannerStore(sqlite);
  const model = new SequencePlanner(decisions);
  let evaluationSequence = 0;
  runtime.execute({
    runId: "run_1",
    commandId: "start",
    expectedRevision: 0,
    definitionKind: "web_blackbox",
    definitionVersion: 1,
    command: {
      type: "start_run",
      runId: "run_1",
      caseId: "case_1",
      goal: "Assess the authorized surface",
      scopeRef: "scope_1",
      scenarioPackage: { id: "traceforge.web-blackbox", version: "0.1.0", schemaRevision: 1 },
      availableCapabilities: capabilities,
      at,
    },
  });
  const supervisor = new RunPlannerSupervisor(
    runtime,
    definitions,
    events,
    graphs,
    plannerStore,
    model,
    3,
    () => `evaluation_${++evaluationSequence}`,
    () => at,
  );
  return { runtime, graphs, plannerStore, model, supervisor };
}

afterEach(() => {
  while (open.length) open.pop()!.close();
});

describe("independent Run Planner", () => {
  it("persists a bounded plan and creates server-owned Work exactly once", async () => {
    const plan: RunPlannerDecision = {
      action: "plan",
      rationale: "The active phase has no scope inventory Work.",
      proposals: [{
        kind: "research",
        title: "Capture scope and capability inventory",
        objective: "Record the authorized scope and available execution capabilities.",
        priority: 80,
        requiredCapabilities: [WEB_BLACKBOX_CAPABILITIES.scopeRead],
        hypothesisIds: [],
        evidenceRefs: ["scope_1"],
        maxAttempts: 2,
      }],
      cancellations: [],
      reprioritizations: [],
    };
    const { runtime, plannerStore, model, supervisor } = setup([
      plan,
      { action: "wait", rationale: "The planned Work is queued for execution." },
    ]);

    await supervisor.tick();
    expect(runtime.load("run_1")!.workItems).toEqual([
      expect.objectContaining({
        id: "planner-work-evaluation_1-0",
        status: "queued",
        priority: 80,
        idempotencyKey: "planner-effect:evaluation_1:0",
      }),
    ]);
    expect(plannerStore.list("run_1")[0]).toMatchObject({ id: "evaluation_1", applied: true, decision: plan });

    await supervisor.tick();
    await supervisor.tick();
    expect(model.calls).toBe(2);
    expect(runtime.load("run_1")!.workItems).toHaveLength(1);
  });

  it("does not replan for lease ownership and heartbeat-only execution changes", () => {
    const { runtime, graphs } = setup([]);
    let state = runtime.execute({
      runId: "run_1",
      commandId: "work",
      expectedRevision: runtime.load("run_1")!.revision,
      command: {
        type: "propose_work",
        proposal: {
          id: "work_1",
          kind: "research",
          title: "Record scope",
          objective: "Record authorized scope state.",
          idempotencyKey: "effect_work_1",
        },
        at,
      },
    }).state;
    const graph = graphs.ensure("case_1", at);
    const before = planningFingerprint(state, graph, 200, 100);
    state = runtime.execute({
      runId: "run_1",
      commandId: "claim",
      expectedRevision: state.revision,
      command: {
        type: "claim_work",
        workId: "work_1",
        workerId: "researcher_1",
        workerRoles: ["researcher"],
        workerCapabilities: capabilities,
        workerCurrentWork: 0,
        workerMaxConcurrentWork: 1,
        leaseId: "lease_1",
        leaseExpiresAt: "2026-08-25T09:01:00.000Z",
        at,
      },
    }).state;
    expect(planningFingerprint(state, graph, 200, 100)).toBe(before);
  });

  it("uses deterministic transition guards after phase requirements are satisfied", async () => {
    const { runtime, model, supervisor } = setup([
      { action: "wait", rationale: "No additional Work is required before the guarded transition." },
    ]);
    let state = runtime.execute({
      runId: "run_1",
      commandId: "scope-work",
      expectedRevision: runtime.load("run_1")!.revision,
      command: {
        type: "propose_work",
        proposal: {
          id: "scope_work",
          kind: "research",
          title: "Record scope",
          objective: "Record authorized scope and execution capabilities.",
          idempotencyKey: "effect_scope_work",
        },
        at,
      },
    }).state;
    state = runtime.execute({
      runId: "run_1",
      commandId: "claim-scope-work",
      expectedRevision: state.revision,
      command: {
        type: "claim_work",
        workId: "scope_work",
        workerId: "researcher_1",
        workerRoles: ["researcher"],
        workerCapabilities: capabilities,
        workerCurrentWork: 0,
        workerMaxConcurrentWork: 1,
        leaseId: "lease_scope",
        leaseExpiresAt: "2026-08-25T09:01:00.000Z",
        at,
      },
    }).state;
    state = runtime.execute({
      runId: "run_1",
      commandId: "complete-scope-work",
      expectedRevision: state.revision,
      command: {
        type: "complete_work",
        workId: "scope_work",
        leaseId: "lease_scope",
        summary: "Scope and capabilities recorded.",
        outputs: [
          { id: "scope_output", kind: "scope_snapshot", summary: "Authorized scope", refs: ["scope_1"], createdAt: at },
          { id: "capability_output", kind: "capability_inventory", summary: "Available capabilities", refs: ["scope_1"], createdAt: at },
        ],
        at,
      },
    }).state;
    expect(state.activePhaseId).toBe("scope_setup");

    await supervisor.tick();
    expect(model.calls).toBe(1);
    expect(runtime.load("run_1")!.activePhaseId).toBe("surface_mapping");
  });
});
