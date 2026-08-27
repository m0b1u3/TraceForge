import { describe, expect, it } from "vitest";
import type { LlmProvider } from "@traceforge/llm";
import type { WorkerModelRequest } from "@traceforge/worker-runtime";
import { StructuredWorkerModel } from "./structured-worker-model.js";
import { createDb, getSqliteClient } from "./db/client.js";
import { SqliteCognitiveSnapshotStore } from "./cognitive-context-snapshots.js";
import { SqliteScenarioAgentEventStream } from "./scenario-agent-event-stream.js";

function request(): WorkerModelRequest {
  return {
    turnId: "worker_context_1",
    worker: {
      id: "worker_1", roles: ["researcher"], capabilities: ["knowledge.graph.read"], maxConcurrentWork: 1,
      status: "online", heartbeatAt: "2026-08-24T08:00:00.000Z",
    },
    assignment: {
      runId: "run_1", leaseId: "lease_1", leaseExpiresAt: "2026-08-24T09:00:00.000Z", runRevision: 3,
      runContext: { caseId: "case_1", goal: "Assess", scopeRef: "scope_1", activePhaseId: "phase_1", directives: [] },
      work: {
        id: "work_1", runId: "run_1", phaseId: "phase_1", kind: "research", title: "Work", objective: "Collect facts",
        priority: 50, status: "running", allowedWorkerRoles: ["researcher"], requiredCapabilities: [], hypothesisIds: [], evidenceRefs: [],
        workerId: "worker_1", leaseId: "lease_1", leaseExpiresAt: "2026-08-24T09:00:00.000Z", attempt: 1, maxAttempts: 3,
        idempotencyKey: "effect", latestCheckpoint: null, resumeFromCheckpoint: false, pendingApproval: null, approvalHistory: [], grantedActionKeys: [], resultSummary: null, error: null,
        createdAt: "2026-08-24T08:00:00.000Z", startedAt: "2026-08-24T08:00:01.000Z", finishedAt: null,
      },
    },
    tools: [], toolResolution: { requestedCapabilities: [], unresolvedCapabilities: [], registryRevision: 1 }, transcript: [], steering: [],
  };
}

function provider(result: unknown): LlmProvider {
  return {
    async extractJson(input) {
      expect(input.system).toContain("authorized scope");
      expect(input.system).toContain("do not expose private chain-of-thought");
      return result;
    },
    async runTools() { throw new Error("not used"); },
  };
}

describe("StructuredWorkerModel", () => {
  it("converts validated provider JSON into a worker decision", async () => {
    const model = new StructuredWorkerModel(provider({
      type: "invoke_tool",
      invocation: { id: "call_1", tool: "knowledge.graph.snapshot", input: { limit: 20 }, rationale: "Read current evidence" },
    }));
    const result = await model.decide(request());
    expect(result).toMatchObject({ type: "invoke_tool", invocation: { id: "call_1" } });
  });

  it("rejects structurally incomplete model actions", async () => {
    const model = new StructuredWorkerModel(provider({
      type: "invoke_tool",
      invocation: { id: "call_1", tool: "knowledge.graph.snapshot", rationale: "Read" },
    }));
    await expect(model.decide(request()))
      .rejects.toThrow(/omitted input/);
  });

  it("records the exact bounded input and validated Worker decision", async () => {
    const sqlite = getSqliteClient(createDb(":memory:"));
    let eventId = 0;
    const events = new SqliteScenarioAgentEventStream(sqlite, undefined, () => `event_${++eventId}`, () => "2026-08-24T08:00:02.000Z");
    const snapshots = new SqliteCognitiveSnapshotStore(sqlite, events);
    const model = new StructuredWorkerModel(
      provider({ type: "block", reason: "The assigned Work lacks a required reference." }),
      undefined,
      snapshots,
      () => "2026-08-24T08:00:02.000Z",
    );
    await expect(model.decide(request())).resolves.toEqual({ type: "block", reason: "The assigned Work lacks a required reference." });
    expect(snapshots.get("worker_context_1")).toMatchObject({
      consumer: "worker",
      runId: "run_1",
      workId: "work_1",
      status: "completed",
      output: { type: "block", reason: "The assigned Work lacks a required reference." },
    });
    expect(events.list("run_1").events.map((event) => event.method)).toEqual([
      "turn/started", "turn/progress", "turn/progress", "turn/progress", "turn/progress",
    ]);
    sqlite.close();
  });
});
