import { describe, expect, it } from "vitest";
import type { EvidenceGraphState, KnowledgeNode } from "@traceforge/evidence-graph";
import type { ScenarioRunState, ScenarioWorkItem } from "@traceforge/orchestration-core";
import type { WorkerModelRequest } from "@traceforge/worker-runtime";
import { CognitiveContextDistiller } from "./index.js";

const at = "2026-08-28T00:00:00.000Z";

function work(overrides: Partial<ScenarioWorkItem> = {}): ScenarioWorkItem {
  return {
    id: "first_task",
    runId: "first_run",
    phaseId: "first_phase",
    kind: "first_kind",
    title: "Inspect the first candidate",
    objective: "Produce bounded evidence",
    priority: 50,
    status: "queued",
    allowedWorkerRoles: ["analyst"],
    requiredCapabilities: ["records.read"],
    hypothesisIds: ["first_hypothesis"],
    evidenceRefs: [],
    workerId: null,
    leaseId: null,
    leaseExpiresAt: null,
    attempt: 0,
    maxAttempts: 2,
    idempotencyKey: "first_effect",
    latestCheckpoint: null,
    resumeFromCheckpoint: false,
    pendingApproval: null,
    approvalHistory: [],
    grantedActionKeys: [],
    resultSummary: null,
    error: null,
    createdAt: at,
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

function run(overrides: Partial<ScenarioRunState> = {}): ScenarioRunState {
  return {
    id: "first_run",
    caseId: "first_case",
    definitionKind: "neutral_fixture",
    definitionVersion: 1,
    scenarioPackage: { id: "neutral.fixture", version: "1.0.0", schemaRevision: 1 },
    goal: "Assess the supplied records",
    scopeRef: "first_scope",
    status: "running",
    activePhaseId: "first_phase",
    availableCapabilities: ["records.read"],
    workItems: [work()],
    outputs: [],
    directives: [],
    suspension: null,
    revision: 1,
    blockedReason: null,
    createdAt: at,
    updatedAt: at,
    completedAt: null,
    ...overrides,
  };
}

function node(id: string, runId: string | null): KnowledgeNode {
  return {
    id,
    caseId: "first_case",
    runId,
    kind: "fact",
    title: `${id} title`,
    summary: `${id} summary`,
    status: "active",
    confidence: 0.5,
    properties: {},
    source: null,
    version: 1,
    createdAt: at,
    updatedAt: at,
    invalidatedAt: null,
    invalidationReason: null,
  };
}

function graph(): EvidenceGraphState {
  return {
    caseId: "first_case",
    revision: 4,
    nodes: [node("shared_candidate", null), node("first_candidate", "first_run"), node("unrelated_candidate", "second_run")],
    edges: [],
    createdAt: at,
    updatedAt: at,
  };
}

describe("CognitiveContextDistiller", () => {
  it("bounds Run context, excludes unrelated nodes, and reports omissions", () => {
    const context = new CognitiveContextDistiller().distillRun(
      run({ workItems: [work({ id: "older_task" }), work()] }),
      graph(),
      [
        { type: "run_paused", reason: "first reason", requestedBy: "system", at },
        { type: "run_resumed", reason: "second reason", requestedBy: "system", at },
      ],
      { maximumGraphNodes: 1, maximumRecentEvents: 1, maximumRunItems: 1 },
    );

    expect(context.run.workItems.map((item) => item.id)).toEqual(["first_task"]);
    expect(context.graph.nodes.map((item) => item.id)).toEqual(["first_candidate"]);
    expect(context.recentEvents.map((event) => event.type)).toEqual(["run_resumed"]);
    expect(context.manifest).toMatchObject({
      omittedWorkItems: 1,
      omittedGraphNodes: 1,
      omittedEvents: 1,
      sourceRunRevision: 1,
      sourceGraphRevision: 4,
    });
  });

  it("keeps the semantic fingerprint stable across operational ownership changes", () => {
    const distiller = new CognitiveContextDistiller();
    const budget = { maximumGraphNodes: 10, maximumRecentEvents: 10, maximumRunItems: 10 };
    const before = distiller.distillRun(run(), graph(), [], budget);
    const after = distiller.distillRun(run({
      revision: 2,
      workItems: [work({
        status: "running",
        workerId: "first_worker",
        leaseId: "first_lease",
        leaseExpiresAt: "2026-08-28T00:01:00.000Z",
        startedAt: at,
      })],
    }), graph(), [], budget);

    expect(after.semanticFingerprint).toBe(before.semanticFingerprint);
    expect(after.manifest.sourceRunRevision).toBe(2);
  });

  it("bounds Worker transcript and rejects invalid budgets without a Server host", () => {
    const request: WorkerModelRequest = {
      turnId: "first_turn",
      worker: {
        id: "first_worker",
        roles: ["analyst"],
        capabilities: ["records.read"],
        maxConcurrentWork: 1,
        status: "online",
        heartbeatAt: at,
      },
      assignment: {
        runId: "first_run",
        leaseId: "first_lease",
        leaseExpiresAt: "2026-08-28T00:01:00.000Z",
        runRevision: 1,
        runContext: {
          caseId: "first_case",
          goal: "Assess the supplied records",
          scopeRef: "first_scope",
          activePhaseId: "first_phase",
          directives: [],
        },
        work: work({ status: "running", workerId: "first_worker", leaseId: "first_lease" }),
      },
      tools: [],
      toolResolution: { requestedCapabilities: [], unresolvedCapabilities: [], registryRevision: 1 },
      transcript: [1, 2, 3].map((turn) => ({ turn, kind: "tool" as const, summary: String(turn).repeat(100), refs: [] })),
      steering: ["first instruction", "first instruction", "second instruction"],
    };
    const distiller = new CognitiveContextDistiller();
    const context = distiller.distillWorker(request, 2, 256);

    expect(context.transcript.map((entry) => entry.turn)).toEqual([2, 3]);
    expect(context.steering).toEqual(["first instruction", "second instruction"]);
    expect(context.manifest).toEqual({ omittedTranscriptEntries: 1, omittedTranscriptCharacters: 100 });
    expect(() => distiller.distillWorker(request, 0, 256)).toThrow("Worker context budget is invalid");
    expect(() => distiller.distillRun(run(), graph(), [], {
      maximumGraphNodes: 0,
      maximumRecentEvents: 1,
      maximumRunItems: 1,
    })).toThrow("Context budget maximumGraphNodes must be a positive integer");
  });
});
