import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createDb, getSqliteClient } from "./db/client.js";
import { registerScenarioAgentEventRoutes, SqliteScenarioAgentEventStream } from "./scenario-agent-event-stream.js";
import { SqliteCognitiveSnapshotStore } from "./cognitive-context-snapshots.js";
import { SqliteModelExecutionStore } from "./model-execution-runtime.js";
import { SqliteModelAdmissionStore } from "./model-admission-controller.js";

const databases: Database.Database[] = [];
const at = "2026-08-25T12:00:00.000Z";

afterEach(() => {
  while (databases.length) databases.pop()!.close();
});

describe("scenario agent event stream", () => {
  it("assigns durable per-Run sequence numbers and replays from a cursor", async () => {
    const sqlite = getSqliteClient(createDb(":memory:"));
    databases.push(sqlite);
    const published: number[] = [];
    let id = 0;
    const stream = new SqliteScenarioAgentEventStream(sqlite, (event) => published.push(event.sequence), () => `event_${++id}`, () => at);
    const base = { runId: "run_1", caseId: "case_1", workId: null, turnId: "turn_1", role: "planner" as const, createdAt: at };
    stream.append({ ...base, method: "turn/started", params: { sourceRunRevision: 1, sourceGraphRevision: 0 } });
    stream.append({
      ...base, method: "item/started",
      params: { item: { type: "modelCall", id: "call_1", routeId: "primary", attempt: 1, status: "inProgress", reservedTokens: 10, usage: null, error: null } },
    });
    stream.append({ ...base, method: "turn/completed", params: { status: "completed", error: null } });

    expect(stream.list("run_1", 0, 2)).toMatchObject({ nextCursor: 2, hasMore: true });
    const tail = stream.list("run_1", 2, 2);
    expect(tail.events.map((event) => [event.sequence, event.method])).toEqual([[3, "turn/completed"]]);
    expect(published).toEqual([1, 2, 3]);

    const reopened = new SqliteScenarioAgentEventStream(sqlite, undefined, () => `event_${++id}`, () => at);
    reopened.append({ ...base, method: "turn/completed", params: { status: "failed", error: "retry failed" } });
    expect(reopened.list("run_1").events.at(-1)?.sequence).toBe(4);
  });

  it("exposes bounded cursor replay over HTTP", async () => {
    const sqlite = getSqliteClient(createDb(":memory:"));
    databases.push(sqlite);
    const stream = new SqliteScenarioAgentEventStream(sqlite, undefined, () => "event_1", () => at);
    stream.append({
      runId: "run_1", caseId: "case_1", workId: null, turnId: "turn_1", role: "observer",
      method: "turn/completed", params: { status: "completed", error: null },
    });
    const app = Fastify();
    registerScenarioAgentEventRoutes(app, stream);
    const response = await app.inject({ method: "GET", url: "/api/scenarios/runs/run_1/agent-events?after=0&limit=10" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ nextCursor: 1, hasMore: false, events: [{ protocolVersion: 1, sequence: 1 }] });
    await app.close();
  });

  it("backfills terminal lifecycle events left between projection commit and publication", () => {
    const sqlite = getSqliteClient(createDb(":memory:"));
    databases.push(sqlite);
    const context = { role: "worker" as const, snapshotId: "turn_1", runId: "run_1", caseId: "case_1", workId: "work_1" };
    const snapshots = new SqliteCognitiveSnapshotStore(sqlite);
    snapshots.prepare({
      id: "turn_1", consumer: "worker", runId: "run_1", caseId: "case_1", workId: "work_1",
      sourceRunRevision: 3, request: { system: "system", user: "state", schema: {} }, contextManifest: {}, at,
    });
    snapshots.complete("turn_1", { type: "block", reason: "bounded" }, at);
    const calls = new SqliteModelExecutionStore(sqlite);
    calls.reserve({ id: "call_1", context, routeId: "primary", routeAttempt: 1, reservedTokens: 4, maximumRunTokens: 100, at });
    calls.finish("call_1", "completed", { promptTokens: 2, completionTokens: 1, totalTokens: 3 }, null, at);
    const admissions = new SqliteModelAdmissionStore(sqlite);
    admissions.enqueue("admission_1", context, 60, at);
    admissions.finish("admission_1", "cancelled", "cancelled", "Run closed", at);

    let eventId = 0;
    const stream = new SqliteScenarioAgentEventStream(sqlite, undefined, () => `event_${++eventId}`, () => at);
    expect(stream.reconcileFromProjections()).toBe(4);
    expect(stream.reconcileFromProjections()).toBe(0);
    expect(stream.list("run_1").events.map((event) => event.method)).toEqual([
      "turn/started", "turn/completed", "item/completed", "item/completed",
    ]);
  });

  it("reconstructs approval Turns from the durable approval projection", () => {
    const sqlite = getSqliteClient(createDb(":memory:"));
    databases.push(sqlite);
    sqlite.prepare(`
      INSERT INTO scenario_work_approvals
        (id, run_id, case_id, work_id, action_key, tool_name, risk, rationale, input_ref, status,
         requested_by_worker_id, resolution_reason, created_at, resolved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "approval_1", "run_1", "case_1", "work_1", "action_1", "http.request", "bounded_write",
      "Operator authorization is required", "artifact:input", "cancelled", "worker_1", "Run closed", at, at,
    );

    let eventId = 0;
    const stream = new SqliteScenarioAgentEventStream(sqlite, undefined, () => `event_${++eventId}`, () => at);
    expect(stream.reconcileFromProjections()).toBe(4);
    expect(stream.reconcileFromProjections()).toBe(0);
    expect(stream.list("run_1").events.map((event) => [
      event.method,
      "item" in event.params ? event.params.item.status : "status" in event.params ? event.params.status : undefined,
    ])).toEqual([
      ["turn/started", undefined],
      ["item/started", "pending"],
      ["item/completed", "cancelled"],
      ["turn/completed", "cancelled"],
    ]);
  });
});
