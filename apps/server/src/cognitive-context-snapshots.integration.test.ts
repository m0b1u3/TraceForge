import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { LlmProvider } from "@traceforge/llm";
import { createDb, getSqliteClient } from "./db/client.js";
import { registerCognitiveSnapshotRoutes, SqliteCognitiveSnapshotStore } from "./cognitive-context-snapshots.js";

const open: Database.Database[] = [];
const at = "2026-08-25T11:00:00.000Z";
const request = {
  system: "Bounded system instruction",
  user: JSON.stringify({ run: "run_1", boundedContext: ["fact_1"] }),
  schema: { type: "object", properties: { action: { type: "string" } }, required: ["action"] },
};

function setup() {
  const sqlite = getSqliteClient(createDb(":memory:"));
  open.push(sqlite);
  return { sqlite, store: new SqliteCognitiveSnapshotStore(sqlite) };
}

afterEach(() => {
  while (open.length) open.pop()!.close();
});

describe("cognitive input snapshots", () => {
  it("persists exact model input before binding the structured output", () => {
    const { store } = setup();
    const prepared = store.prepare({
      id: "snapshot_1",
      consumer: "planner",
      runId: "run_1",
      caseId: "case_1",
      evaluationId: "evaluation_1",
      sourceRunRevision: 4,
      sourceGraphRevision: 7,
      semanticFingerprint: "semantic_1",
      request,
      contextManifest: { omittedEvents: 3 },
      at,
    });
    expect(prepared).toMatchObject({ status: "prepared", request, output: null });

    const completed = store.complete("snapshot_1", { action: "wait", rationale: "No state gap" }, at);
    expect(completed).toMatchObject({
      status: "completed",
      output: { action: "wait", rationale: "No state gap" },
      sourceRunRevision: 4,
      sourceGraphRevision: 7,
    });
    expect(store.prepare({
      id: "snapshot_1",
      consumer: "planner",
      runId: "run_1",
      caseId: "case_1",
      sourceRunRevision: 4,
      request,
      contextManifest: {},
      at,
    }).status).toBe("completed");
    expect(() => store.prepare({
      id: "snapshot_1",
      consumer: "planner",
      runId: "run_1",
      caseId: "case_1",
      sourceRunRevision: 4,
      request: { ...request, user: "different" },
      contextManifest: {},
      at,
    })).toThrow(/different model input/);
  });

  it("replays the exact stored request without mutating the source snapshot", async () => {
    const { store } = setup();
    store.prepare({
      id: "snapshot_1",
      consumer: "observer",
      runId: "run_1",
      caseId: "case_1",
      sourceRunRevision: 5,
      sourceGraphRevision: 2,
      request,
      contextManifest: { omittedGraphNodes: 4 },
      at,
    });
    store.complete("snapshot_1", { action: "continue", rationale: "Original" }, at);
    let received: unknown;
    const provider: LlmProvider = {
      async extractJson(input) {
        received = input;
        return { action: "continue", rationale: "Replay" };
      },
      async runTools() { throw new Error("not used"); },
    };
    const app = Fastify();
    registerCognitiveSnapshotRoutes(app, store, provider, () => true, () => "replay_1", () => at);

    const list = await app.inject({ method: "GET", url: "/api/scenarios/runs/run_1/cognitive-snapshots" });
    expect(list.statusCode).toBe(200);
    expect(list.json()[0]).not.toHaveProperty("request");
    expect(list.json()[0]).not.toHaveProperty("output");

    const replay = await app.inject({ method: "POST", url: "/api/scenarios/cognitive-snapshots/snapshot_1/replay" });
    expect(replay.statusCode).toBe(200);
    expect(received).toEqual(request);
    expect(replay.json()).toMatchObject({
      id: "replay_1",
      parentSnapshotId: "snapshot_1",
      consumer: "replay",
      status: "completed",
      output: { action: "continue", rationale: "Replay" },
    });
    expect(store.get("snapshot_1")!.output).toEqual({ action: "continue", rationale: "Original" });
    await app.close();
  });

  it("keeps a failed inference as an auditable terminal snapshot", () => {
    const { store } = setup();
    store.prepare({
      id: "snapshot_failed",
      consumer: "worker",
      runId: "run_1",
      caseId: "case_1",
      workId: "work_1",
      sourceRunRevision: 6,
      request,
      contextManifest: {},
      at,
    });
    expect(store.fail("snapshot_failed", new Error("provider unavailable"), at)).toMatchObject({
      status: "failed",
      error: "provider unavailable",
    });
  });
});
