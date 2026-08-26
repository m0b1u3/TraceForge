import Fastify from "fastify";
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
import { SqliteRunObserverStore } from "./run-observer.js";
import { SqliteRunPlannerStore } from "./run-planner.js";
import { registerScenarioRoutes } from "./scenario-routes.js";
import {
  registerScenarioCollaborationRoutes,
  ScenarioCollaborationSnapshotService,
  workerHealth,
} from "./scenario-collaboration-snapshot.js";
import { SqliteScenarioEventStore, SqliteWorkerRegistry } from "./scenario-event-store.js";

const databases: Database.Database[] = [];
const now = "2026-08-25T08:00:10.000Z";

afterEach(() => {
  while (databases.length) databases.pop()!.close();
});

async function setup() {
  const app = Fastify();
  const db = createDb(":memory:");
  const sqlite = getSqliteClient(db);
  databases.push(sqlite);
  sqlite.prepare("INSERT INTO cases (id, name, status, scope_rules_json, created_at) VALUES (?, ?, ?, ?, ?)")
    .run("case_1", "Authorized assessment", "active", "{}", "2026-08-25T08:00:00.000Z");
  registerScenarioRoutes(app, sqlite, {
    now: () => now,
    createId: () => "lease_1",
    controlPlane: { leaseDurationMs: 60_000, heartbeatTimeoutMs: 30_000, concurrencyRetries: 3 },
  });
  const definitions = new ScenarioDefinitionRegistry([WEB_BLACKBOX_SCENARIO]);
  const runtime = new DurableScenarioRuntime(new SqliteScenarioEventStore(sqlite), definitions);
  const graph = new SqliteEvidenceGraphStore(sqlite);
  const planner = new SqliteRunPlannerStore(sqlite);
  const observer = new SqliteRunObserverStore(sqlite);
  const workers = new SqliteWorkerRegistry(sqlite);
  registerScenarioCollaborationRoutes(app, new ScenarioCollaborationSnapshotService(
    runtime, definitions, graph, planner, observer, workers,
    { now: () => now, heartbeatTimeoutMs: 30_000, cognitiveAgentsReady: () => true },
  ));
  await app.ready();
  return { app, runtime, graph, planner, observer };
}

describe("Scenario collaboration snapshot", () => {
  it("projects cognitive decisions, Worker health and leases, and bounded knowledge links", async () => {
    const { app, runtime, graph, planner, observer } = await setup();
    await app.inject({
      method: "POST", url: "/api/scenarios/authorizations", payload: {
        id: "scope_1", caseId: "case_1", scenarioKind: "web_blackbox",
        scope: { targets: ["https://authorized.example"], allowedActions: Object.values(WEB_BLACKBOX_CAPABILITIES), deniedActions: [] },
        approvedBy: "operator_1", expiresAt: "2026-08-25T09:00:00.000Z",
      },
    });
    await app.inject({
      method: "POST", url: "/api/scenarios/workers", payload: {
        id: "worker_1", roles: ["researcher"], capabilities: Object.values(WEB_BLACKBOX_CAPABILITIES),
        maxConcurrentWork: 2, status: "online",
      },
    });
    await app.inject({
      method: "POST", url: "/api/scenarios/runs", payload: {
        commandId: "start_1", runId: "run_1", caseId: "case_1", goal: "Map the authorized surface",
        scopeRef: "scope_1", scenarioKind: "web_blackbox", definitionVersion: 1,
      },
    });
    let state = runtime.load("run_1")!;
    let graphState = graph.ensure("case_1", now);
    graphState = graph.execute({
      caseId: "case_1", commandId: "graph_hypothesis", expectedRevision: graphState.revision,
      command: { type: "add_node", at: now, node: {
        id: "hypothesis_1", caseId: "case_1", runId: "run_1", kind: "hypothesis", title: "First candidate",
        summary: "A candidate requiring causal validation", status: "candidate", confidence: 0.5, properties: {}, source: null,
      } },
    }).state;
    graphState = graph.execute({
      caseId: "case_1", commandId: "graph_evidence", expectedRevision: graphState.revision,
      command: { type: "add_node", at: now, node: {
        id: "evidence_1", caseId: "case_1", runId: "run_1", kind: "evidence", title: "First observation",
        summary: "A reproducible observation", status: "active", confidence: 0.8, properties: {},
        source: { type: "tool_result", ref: "artifact://observation", observedAt: now, producerId: "worker_1" },
      } },
    }).state;
    graphState = graph.execute({
      caseId: "case_1", commandId: "graph_edge", expectedRevision: graphState.revision,
      command: { type: "add_edge", at: now, edge: {
        id: "edge_1", sourceId: "evidence_1", targetId: "hypothesis_1", relation: "supports", rationale: "Observation supports investigation",
      } },
    }).state;
    state = runtime.execute({
      runId: "run_1", commandId: "propose_1", expectedRevision: state.revision,
      command: { type: "propose_work", at: now, proposal: {
        id: "work_1", kind: "research", title: "First work package", objective: "Collect bounded observations",
        priority: 70, hypothesisIds: ["hypothesis_1"], evidenceRefs: ["knowledge-node:evidence_1", "artifact://observation"],
        idempotencyKey: "effect_1",
      } },
    }).state;
    await app.inject({ method: "POST", url: "/api/scenarios/runs/run_1/tick" });
    state = runtime.load("run_1")!;
    planner.record({
      id: "planner_1", run: state, graphRevision: graphState.revision, fingerprint: "fingerprint_1", at: now,
      decision: { action: "wait", rationale: "Current Work already covers the active objective" },
    });
    observer.record({
      id: "observer_1", runId: state.id, caseId: state.caseId, runRevision: state.revision,
      graphRevision: graphState.revision, at: now,
      decision: { action: "continue", rationale: "Progress remains bounded and evidence-linked" },
    });

    const response = await app.inject({ method: "GET", url: "/api/scenarios/runs/run_1/collaboration?nodeLimit=2&evaluationLimit=1" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      runId: "run_1",
      runRevision: state.revision,
      graphRevision: graphState.revision,
      agents: {
        planner: { status: "applying", evaluationCount: 1, evaluations: [{ id: "planner_1", decision: { action: "wait" } }] },
        observer: { status: "applying", evaluationCount: 1, evaluations: [{ id: "observer_1", decision: { action: "continue" } }] },
      },
      workers: [{ id: "worker_1", health: "healthy", activeWork: 1, availableSlots: 1, runLeases: [{ workId: "work_1", expired: false }] }],
      knowledge: { totalNodes: 2, totalEdges: 1, countsByKind: { hypothesis: 1, evidence: 1 }, truncated: false },
      workLinks: [{
        workId: "work_1", hypothesisNodeIds: ["hypothesis_1"], evidenceNodeIds: ["evidence_1"],
        linkedNodeIds: ["hypothesis_1", "evidence_1"], externalRefs: ["artifact://observation"],
      }],
    });
    await app.close();
  });

  it("marks future, stale, draining, and offline heartbeats deterministically", () => {
    const base = { id: "worker", roles: ["researcher" as const], capabilities: [], maxConcurrentWork: 1, status: "online" as const };
    expect(workerHealth({ ...base, heartbeatAt: now }, now, 30_000).health).toBe("healthy");
    expect(workerHealth({ ...base, heartbeatAt: "2026-08-25T07:59:00.000Z" }, now, 30_000).health).toBe("stale");
    expect(workerHealth({ ...base, heartbeatAt: "2026-08-25T08:01:00.000Z" }, now, 30_000).health).toBe("stale");
    expect(workerHealth({ ...base, status: "draining", heartbeatAt: now }, now, 30_000).health).toBe("draining");
    expect(workerHealth({ ...base, status: "offline", heartbeatAt: now }, now, 30_000).health).toBe("offline");
  });

  it("returns 404 for an unknown Run and validates projection limits", async () => {
    const { app } = await setup();
    expect((await app.inject({ method: "GET", url: "/api/scenarios/runs/missing/collaboration" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/scenarios/runs/missing/collaboration?nodeLimit=0" })).statusCode).toBe(400);
    await app.close();
  });
});
