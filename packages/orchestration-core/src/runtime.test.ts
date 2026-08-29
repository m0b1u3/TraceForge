import { describe, expect, it } from "vitest";
import { ScenarioKernel } from "./kernel.js";
import type { ScenarioDefinition } from "./model.js";
import { ScenarioDefinitionRegistry } from "./runtime.js";

const definition: ScenarioDefinition = {
  kind: "example.neutral_investigation",
  version: 1,
  title: "Neutral investigation fixture",
  authorizationActions: ["fixture.scope.read"],
  requiredCapabilities: ["fixture.scope.read"],
  workKinds: [{ id: "candidate_review", defaultWorkerRoles: ["analyst"] }],
  initialPhaseId: "first_phase",
  agentTopology: {
    planner: {
      enabled: false,
      pollIntervalMs: 1_000,
      maximumGraphNodes: 1,
      maximumRecentEvents: 1,
      maximumRunItems: 1,
      maximumProposalsPerEvaluation: 1,
    },
    observer: { enabled: false, pollIntervalMs: 1_000, maximumGraphNodes: 1, maximumRecentEvents: 1, maximumRunItems: 1 },
    workerPools: [{
      id: "analyst_pool",
      role: "analyst",
      workKinds: ["candidate_review"],
      activation: "on_demand",
      minimumInstances: 0,
      maximumInstances: 1,
      maxConcurrentWork: 1,
      capabilities: ["fixture.scope.read"],
    }],
  },
  phases: [{
    id: "first_phase",
    title: "First phase",
    objective: "Review the first candidate",
    allowedWorkKinds: ["candidate_review"],
    maxParallelWork: 1,
    requiredCapabilities: ["fixture.scope.read"],
    transitions: [{ to: "complete", allOf: [{ kind: "decision_record" }] }],
  }],
};

describe("ScenarioDefinitionRegistry", () => {
  it("supports a host with no installed scenarios", () => {
    const registry = new ScenarioDefinitionRegistry();
    expect(registry.list()).toEqual([]);
    expect(() => registry.require("missing.scenario", 1)).toThrow("is not registered");
  });

  it("accepts open scenario, work, role, and output identifiers", () => {
    const registry = new ScenarioDefinitionRegistry([definition]);
    const kernel = new ScenarioKernel(registry.require(definition.kind, definition.version));
    let state = kernel.execute(undefined, {
      type: "start_run",
      runId: "run_1",
      caseId: "case_1",
      goal: "Review candidates",
      scopeRef: "scope_1",
      scenarioPackage: { id: "fixture.neutral", version: "1.0.0", schemaRevision: 1 },
      availableCapabilities: ["fixture.scope.read"],
      at: "2026-08-28T00:00:00.000Z",
    }).state;
    state = kernel.execute(state, {
      type: "propose_work",
      proposal: {
        id: "work_1",
        kind: "candidate_review",
        title: "Review first candidate",
        objective: "Record a decision",
        idempotencyKey: "candidate_review:first",
      },
      at: "2026-08-28T00:00:01.000Z",
    }).state;
    expect(state.workItems[0]).toMatchObject({ kind: "candidate_review", allowedWorkerRoles: ["analyst"] });
  });

  it("rejects definitions whose pools reference undeclared work kinds", () => {
    const invalid = structuredClone(definition);
    invalid.agentTopology.workerPools[0].workKinds = ["undeclared_kind"];
    expect(() => new ScenarioDefinitionRegistry([invalid])).toThrow("references no valid work kinds");
  });
});
