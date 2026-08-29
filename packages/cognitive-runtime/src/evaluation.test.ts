import { describe, expect, it } from "vitest";
import {
  CognitiveEvaluationRunner,
  type CognitiveEvaluationSnapshotPort,
} from "./evaluation.js";
import type {
  CognitiveSnapshotRecord,
  CompleteCognitiveSnapshotOptions,
  PrepareCognitiveSnapshotInput,
} from "./snapshot.js";

const at = "2026-08-28T02:00:00.000Z";
const request = {
  system: "Use the injected evaluation policy",
  user: JSON.stringify({ candidate: "first candidate" }),
  schema: { type: "object", properties: { action: { type: "string" } } },
};

function record(input: PrepareCognitiveSnapshotInput): CognitiveSnapshotRecord {
  return {
    id: input.id,
    parentSnapshotId: input.parentSnapshotId ?? null,
    consumer: input.consumer,
    runId: input.runId,
    caseId: input.caseId,
    workId: input.workId ?? null,
    evaluationId: input.evaluationId ?? null,
    sourceRunRevision: input.sourceRunRevision,
    sourceGraphRevision: input.sourceGraphRevision ?? null,
    semanticFingerprint: input.semanticFingerprint ?? null,
    request: input.request,
    contextManifest: input.contextManifest,
    status: "prepared",
    output: null,
    error: null,
    createdAt: input.at,
    completedAt: null,
  };
}

class RecordingSnapshots implements CognitiveEvaluationSnapshotPort {
  readonly calls: Array<{ method: string; value?: unknown }> = [];
  private prepared?: CognitiveSnapshotRecord;

  prepare(input: PrepareCognitiveSnapshotInput): CognitiveSnapshotRecord {
    this.calls.push({ method: "prepare", value: input });
    this.prepared = record(input);
    return this.prepared;
  }

  complete(id: string, output: unknown, completedAt: string, options?: CompleteCognitiveSnapshotOptions): CognitiveSnapshotRecord {
    this.calls.push({ method: "complete", value: { id, output, completedAt, options } });
    return { ...this.prepared!, status: "completed", output, completedAt };
  }

  fail(id: string, error: unknown, completedAt: string): CognitiveSnapshotRecord {
    const message = error instanceof Error ? error.message : String(error);
    this.calls.push({ method: "fail", value: { id, message, completedAt } });
    return { ...this.prepared!, status: "failed", error: message, completedAt };
  }
}

const snapshot = {
  id: "first_evaluation",
  consumer: "planner" as const,
  runId: "first_run",
  caseId: "first_case",
  sourceRunRevision: 2,
  request,
  contextManifest: { omittedEvents: 1 },
};

describe("CognitiveEvaluationRunner", () => {
  it("runs the injected model and parser between snapshot prepare and completion", async () => {
    const snapshots = new RecordingSnapshots();
    const order: string[] = [];
    const runner = new CognitiveEvaluationRunner(snapshots, () => at);
    const decision = await runner.run({
      snapshot,
      model: { async extractJson(received) { order.push("model"); expect(received).toEqual(request); return { action: "continue" }; } },
      parse(value) { order.push("parse"); return value as { action: string }; },
      completion: (parsed) => ({ decisionKind: parsed.action, outcome: "continue" }),
    });

    expect(decision).toEqual({ action: "continue" });
    expect(order).toEqual(["model", "parse"]);
    expect(snapshots.calls.map((call) => call.method)).toEqual(["prepare", "complete"]);
    expect(snapshots.calls[1]?.value).toMatchObject({
      options: { decisionKind: "continue", outcome: "continue" },
    });
  });

  it("records model invocation failures as snapshot failures", async () => {
    const snapshots = new RecordingSnapshots();
    const runner = new CognitiveEvaluationRunner(snapshots, () => at);

    await expect(runner.run({
      snapshot,
      model: { async extractJson() { throw new Error("model unavailable"); } },
      parse: (value) => value,
    })).rejects.toThrow("model unavailable");
    expect(snapshots.calls.map((call) => call.method)).toEqual(["prepare", "fail"]);
  });

  it("records decision parser failures as snapshot failures", async () => {
    const snapshots = new RecordingSnapshots();
    const runner = new CognitiveEvaluationRunner(snapshots, () => at);

    await expect(runner.run({
      snapshot,
      model: { async extractJson() { return { action: "unsupported" }; } },
      parse() { throw new Error("decision schema rejected output"); },
    })).rejects.toThrow("decision schema rejected output");
    expect(snapshots.calls.map((call) => call.method)).toEqual(["prepare", "fail"]);
  });

  it("can run without persistence while keeping every policy dependency injected", async () => {
    const runner = new CognitiveEvaluationRunner();
    await expect(runner.run({
      snapshot,
      model: { async extractJson() { return { result: "first result" }; } },
      parse(value) { return value as { result: string }; },
    })).resolves.toEqual({ result: "first result" });
  });
});
