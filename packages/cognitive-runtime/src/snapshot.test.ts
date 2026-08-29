import { describe, expect, it } from "vitest";
import {
  CognitiveSnapshotRuntime,
  type CognitiveSnapshotLifecycleEvent,
  type CognitiveSnapshotPersistencePort,
  type CognitiveSnapshotRecord,
  type StoredCognitiveSnapshot,
} from "./snapshot.js";

const at = "2026-08-28T01:00:00.000Z";
const request = {
  system: "Evaluate the bounded state",
  user: JSON.stringify({ candidate: "first candidate" }),
  schema: { type: "object", properties: { action: { type: "string" } }, required: ["action"] },
};

class MemorySnapshotPersistence implements CognitiveSnapshotPersistencePort {
  readonly records = new Map<string, StoredCognitiveSnapshot>();

  getStored(id: string): StoredCognitiveSnapshot | undefined {
    return this.records.get(id);
  }

  insertPrepared(record: CognitiveSnapshotRecord, requestFingerprint: string): void {
    if (this.records.has(record.id)) throw new Error(`Duplicate cognitive snapshot ${record.id}`);
    this.records.set(record.id, { record, requestFingerprint, outputJson: null });
  }

  listPrepared(): StoredCognitiveSnapshot[] {
    return [...this.records.values()].filter(({ record }) => record.status === "prepared");
  }

  markCompleted(id: string, output: unknown, outputJson: string, completedAt: string): void {
    const stored = this.records.get(id)!;
    this.records.set(id, {
      ...stored,
      record: { ...stored.record, status: "completed", output, error: null, completedAt },
      outputJson,
    });
  }

  markFailed(id: string, error: string, completedAt: string): boolean {
    const stored = this.records.get(id)!;
    if (stored.record.status === "completed") return false;
    this.records.set(id, {
      ...stored,
      record: { ...stored.record, status: "failed", error, completedAt },
    });
    return true;
  }

  failAllPrepared(error: string, completedAt: string): number {
    let changed = 0;
    for (const [id, stored] of this.records) {
      if (stored.record.status !== "prepared") continue;
      this.records.set(id, {
        ...stored,
        record: { ...stored.record, status: "failed", error, completedAt },
      });
      changed += 1;
    }
    return changed;
  }
}

function setup() {
  const persistence = new MemorySnapshotPersistence();
  const events: CognitiveSnapshotLifecycleEvent[] = [];
  const runtime = new CognitiveSnapshotRuntime(persistence, { append: (event) => events.push(event) });
  return { persistence, events, runtime };
}

function prepare(runtime: CognitiveSnapshotRuntime, id = "first_snapshot") {
  return runtime.prepare({
    id,
    consumer: "planner",
    runId: "first_run",
    caseId: "first_case",
    evaluationId: "first_evaluation",
    sourceRunRevision: 3,
    sourceGraphRevision: 2,
    semanticFingerprint: "first_semantic_state",
    request,
    contextManifest: { omittedEvents: 1 },
    at,
  });
}

describe("CognitiveSnapshotRuntime", () => {
  it("prepares an auditable snapshot once and rejects id reuse with different model input", () => {
    const { runtime, events } = setup();
    expect(prepare(runtime)).toMatchObject({ status: "prepared", request, output: null });
    expect(prepare(runtime)).toMatchObject({ status: "prepared" });
    expect(events.map((event) => event.type)).toEqual([
      "turn_started", "turn_progress", "turn_progress", "turn_progress",
    ]);
    expect(() => runtime.prepare({
      id: "first_snapshot",
      consumer: "planner",
      runId: "first_run",
      caseId: "first_case",
      sourceRunRevision: 3,
      request: { ...request, user: "different input" },
      contextManifest: {},
      at,
    })).toThrow("different model input");
  });

  it("completes idempotently and never accepts a different terminal output", () => {
    const { runtime, events } = setup();
    prepare(runtime);
    const output = { action: "wait" };
    expect(runtime.complete("first_snapshot", output, at, { decisionKind: "wait" })).toMatchObject({
      status: "completed",
      output,
    });
    expect(runtime.complete("first_snapshot", output, at)).toMatchObject({ status: "completed" });
    expect(() => runtime.complete("first_snapshot", { action: "continue" }, at)).toThrow("different output");
    expect(events.filter((event) => event.type === "turn_completed")).toHaveLength(1);
  });

  it("keeps completed snapshots terminal when a later failure is reported", () => {
    const { runtime, events } = setup();
    prepare(runtime);
    runtime.complete("first_snapshot", { action: "wait" }, at, { deferTurnCompletion: true });
    expect(runtime.fail("first_snapshot", new Error("late provider error"), at)).toMatchObject({
      status: "completed",
      error: null,
    });
    expect(events.filter((event) => event.type === "turn_completed")).toHaveLength(0);
  });

  it("marks prepared snapshots interrupted during restart recovery", () => {
    const { runtime, persistence, events } = setup();
    prepare(runtime, "first_snapshot");
    prepare(runtime, "second_snapshot");
    runtime.complete("second_snapshot", { action: "wait" }, at);
    events.length = 0;

    expect(runtime.recoverPrepared(at)).toBe(1);
    expect(persistence.getStored("first_snapshot")?.record).toMatchObject({
      status: "failed",
      error: "runtime restarted before cognitive evaluation completed",
    });
    expect(events).toMatchObject([{ type: "turn_completed", status: "interrupted" }]);
  });

  it("replays the exact stored request and audits model failure without mutating the source", async () => {
    const { runtime, persistence } = setup();
    prepare(runtime);
    runtime.complete("first_snapshot", { action: "original" }, at);
    let received: unknown;
    const replayed = await runtime.replay({
      sourceId: "first_snapshot",
      id: "replay_snapshot",
      model: { async extractJson(input) { received = input; return { action: "replayed" }; } },
      now: () => at,
    });

    expect(received).toEqual(request);
    expect(replayed).toMatchObject({
      parentSnapshotId: "first_snapshot",
      consumer: "replay",
      status: "completed",
      output: { action: "replayed" },
    });
    expect(persistence.getStored("first_snapshot")?.record.output).toEqual({ action: "original" });

    await expect(runtime.replay({
      sourceId: "first_snapshot",
      id: "failed_replay",
      model: { async extractJson() { throw new Error("model unavailable"); } },
      now: () => at,
    })).rejects.toThrow("model unavailable");
    expect(persistence.getStored("failed_replay")?.record).toMatchObject({
      status: "failed",
      error: "model unavailable",
    });
  });
});
