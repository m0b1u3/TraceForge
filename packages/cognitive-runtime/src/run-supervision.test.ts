import { describe, expect, it } from "vitest";
import type { EvidenceGraphState } from "@traceforge/evidence-graph";
import type { ScenarioDefinition, ScenarioRunState } from "@traceforge/orchestration-core";
import {
  parseRunObserverDecision,
  parseRunPlannerDecision,
  StructuredRunObserverModel,
  StructuredRunPlannerModel,
} from "./index.js";

const at = "2026-09-03T00:00:00.000Z";

function run(): ScenarioRunState {
  return {
    id: "first_run", caseId: "first_case", definitionKind: "neutral_fixture", definitionVersion: 1,
    scenarioPackage: { id: "neutral.fixture", version: "1.0.0", schemaRevision: 1 },
    goal: "Assess supplied records", scopeRef: "first_scope", status: "running", activePhaseId: "first_phase",
    availableCapabilities: ["records.read"], workItems: [], outputs: [], directives: [], suspension: null,
    revision: 1, blockedReason: null, createdAt: at, updatedAt: at, completedAt: null,
  };
}

function graph(): EvidenceGraphState {
  return { caseId: "first_case", revision: 1, nodes: [], edges: [], createdAt: at, updatedAt: at };
}

function definition(): ScenarioDefinition {
  return {
    kind: "neutral_fixture", version: 1, title: "Neutral fixture", authorizationActions: [], requiredCapabilities: [],
    initialPhaseId: "first_phase", phases: [{ id: "first_phase", title: "First phase", objective: "Assess records",
      allowedWorkKinds: ["research"], maxParallelWork: 1, requiredCapabilities: [], transitions: [] }],
    workKinds: [{ id: "research", defaultWorkerRoles: ["analyst"], minimumHypothesisRefs: 0 }],
    agentTopology: {
      planner: { enabled: true, pollIntervalMs: 1000, maximumRecentEvents: 10, maximumGraphNodes: 10,
        maximumRunItems: 10, maximumProposalsPerEvaluation: 4 },
      observer: { enabled: true, pollIntervalMs: 1000, maximumRecentEvents: 10, maximumGraphNodes: 10, maximumRunItems: 10 },
      workerPools: [{ id: "analysts", role: "analyst", capabilities: ["records.read"], workKinds: ["research"],
        activation: "resident", minimumInstances: 1, maximumInstances: 1, maxConcurrentWork: 1 }],
    },
  };
}

describe("package-owned Run decision supervision", () => {
  it("builds and parses Planner and Observer model evaluations without Server adapters", async () => {
    const requests: string[] = [];
    const planner = new StructuredRunPlannerModel({ extractJson: async (request) => {
      requests.push(request.user);
      return { action: "wait", rationale: "No state change is justified" };
    } });
    const observer = new StructuredRunObserverModel({ extractJson: async (request) => {
      requests.push(request.user);
      return { action: "continue", rationale: "The run remains healthy" };
    } });

    await expect(planner.evaluate({ contextId: "planner_snapshot", run: run(), definition: definition(), graph: graph(),
      recentEvents: [], maximumGraphNodes: 10, maximumRunItems: 10 })).resolves.toEqual({
      action: "wait", rationale: "No state change is justified",
    });
    await expect(observer.evaluate({ contextId: "observer_snapshot", run: run(), graph: graph(), recentEvents: [],
      maximumGraphNodes: 10, maximumRunItems: 10 })).resolves.toEqual({
      action: "continue", rationale: "The run remains healthy",
    });
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.includes("first_scope"))).toBe(true);
  });

  it("rejects malformed decisions at the package boundary", () => {
    expect(() => parseRunPlannerDecision({ action: "plan", rationale: "missing changes" })).toThrow();
    expect(() => parseRunObserverDecision({ action: "steer", workId: "first", instruction: "" })).toThrow();
  });
});
