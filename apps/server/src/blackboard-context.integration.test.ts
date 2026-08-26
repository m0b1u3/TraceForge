import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import {
  DurableScenarioRuntime,
  ScenarioDefinitionRegistry,
  WEB_BLACKBOX_CAPABILITIES,
  WEB_BLACKBOX_SCENARIO,
} from "@traceforge/orchestration-core";
import type { WorkerModelRequest } from "@traceforge/worker-runtime";
import { BlackboardChangeBus, type BlackboardChange } from "./blackboard-change-bus.js";
import { CognitiveContextDistiller } from "./cognitive-context-distiller.js";
import { createDb, getSqliteClient } from "./db/client.js";
import { SqliteEvidenceGraphStore } from "./evidence-graph-store.js";
import { SqliteScenarioEventStore } from "./scenario-event-store.js";

const open: Database.Database[] = [];
const at = "2026-08-25T10:00:00.000Z";
const capabilities = Object.values(WEB_BLACKBOX_CAPABILITIES);

function setup() {
  const sqlite = getSqliteClient(createDb(":memory:"));
  open.push(sqlite);
  const changes = new BlackboardChangeBus();
  const events = new SqliteScenarioEventStore(sqlite, changes);
  const graphs = new SqliteEvidenceGraphStore(sqlite, changes);
  const runtime = new DurableScenarioRuntime(events, new ScenarioDefinitionRegistry([WEB_BLACKBOX_SCENARIO]));
  const start = {
    runId: "run_1",
    commandId: "start",
    expectedRevision: 0,
    definitionKind: "web_blackbox" as const,
    definitionVersion: 1,
    command: {
      type: "start_run" as const,
      runId: "run_1",
      caseId: "case_1",
      goal: "Assess authorized surface",
      scopeRef: "scope_1",
      availableCapabilities: capabilities,
      at,
    },
  };
  return { changes, events, graphs, runtime, start };
}

afterEach(() => {
  while (open.length) open.pop()!.close();
});

describe("Blackboard wake-up and context distillation", () => {
  it("publishes committed Run and Graph changes once, never idempotent replays", () => {
    const { changes, graphs, runtime, start } = setup();
    const observed: BlackboardChange[] = [];
    const unsubscribe = changes.subscribe((change) => observed.push(change));

    runtime.execute(start);
    runtime.execute(start);
    graphs.ensure("case_1", at);
    graphs.ensure("case_1", at);

    expect(observed).toEqual([
      expect.objectContaining({ kind: "run", runId: "run_1", caseId: "case_1", revision: 1, eventTypes: ["run_started"] }),
      expect.objectContaining({ kind: "graph", caseId: "case_1", revision: 1, eventTypes: ["graph_initialized"] }),
    ]);
    unsubscribe();
    expect(changes.listenerCount()).toBe(0);
  });

  it("keeps semantic fingerprints stable across lease ownership changes", () => {
    const { events, graphs, runtime, start } = setup();
    let state = runtime.execute(start).state;
    state = runtime.execute({
      runId: state.id,
      commandId: "work",
      expectedRevision: state.revision,
      command: {
        type: "propose_work",
        proposal: { id: "work_1", kind: "research", title: "Record scope", objective: "Record scope state", idempotencyKey: "effect_1" },
        at,
      },
    }).state;
    const graph = graphs.ensure("case_1", at);
    const distiller = new CognitiveContextDistiller();
    const budget = { maximumGraphNodes: 10, maximumRecentEvents: 10, maximumRunItems: 10 };
    const before = distiller.distillRun(state, graph, events.load(state.id).events, budget);
    state = runtime.execute({
      runId: state.id,
      commandId: "claim",
      expectedRevision: state.revision,
      command: {
        type: "claim_work",
        workId: "work_1",
        workerId: "worker_1",
        workerRoles: ["researcher"],
        workerCapabilities: capabilities,
        workerCurrentWork: 0,
        workerMaxConcurrentWork: 1,
        leaseId: "lease_1",
        leaseExpiresAt: "2026-08-25T10:01:00.000Z",
        at,
      },
    }).state;
    const after = distiller.distillRun(state, graph, events.load(state.id).events, budget);

    expect(after.semanticFingerprint).toBe(before.semanticFingerprint);
    expect(after.manifest).toMatchObject({ sourceRunRevision: state.revision, sourceGraphRevision: graph.revision });
  });

  it("bounds Worker transcript context and reports what was omitted", () => {
    const { runtime, start } = setup();
    const state = runtime.execute(start).state;
    const work = {
      id: "work_1",
      runId: state.id,
      phaseId: state.activePhaseId,
      kind: "research" as const,
      title: "Record scope",
      objective: "Record scope state",
      priority: 50,
      allowedWorkerRoles: ["researcher" as const],
      requiredCapabilities: [],
      hypothesisIds: [],
      evidenceRefs: [],
      maxAttempts: 2,
      attempt: 1,
      idempotencyKey: "effect_1",
      status: "running" as const,
      workerId: "worker_1",
      leaseId: "lease_1",
      leaseExpiresAt: "2026-08-25T10:01:00.000Z",
      latestCheckpoint: null,
      resumeFromCheckpoint: false,
      pendingApproval: null,
      approvalHistory: [],
      grantedActionKeys: [],
      resultSummary: null,
      error: null,
      createdAt: at,
      updatedAt: at,
      startedAt: at,
      finishedAt: null,
    };
    const request: WorkerModelRequest = {
      worker: { id: "worker_1", roles: ["researcher"], capabilities, maxConcurrentWork: 1, status: "online", heartbeatAt: at },
      assignment: {
        runId: state.id,
        leaseId: "lease_1",
        leaseExpiresAt: "2026-08-25T10:01:00.000Z",
        runRevision: state.revision,
        runContext: { caseId: state.caseId, goal: state.goal, scopeRef: state.scopeRef, activePhaseId: state.activePhaseId, directives: [] },
        work,
      },
      tools: [],
      transcript: [1, 2, 3].map((turn) => ({ turn, kind: "tool" as const, summary: String(turn).repeat(100), refs: [`ref_${turn}`] })),
      steering: ["first", "first", "second"],
    };
    const context = new CognitiveContextDistiller().distillWorker(request, 2, 256);

    expect(context.transcript.map((entry) => entry.turn)).toEqual([2, 3]);
    expect(context.steering).toEqual(["first", "second"]);
    expect(context.manifest).toEqual({ omittedTranscriptEntries: 1, omittedTranscriptCharacters: 100 });
  });
});
