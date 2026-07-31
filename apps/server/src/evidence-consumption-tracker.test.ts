import { describe, expect, it } from "vitest";
import { FactSchema } from "@traceforge/shared";
import { artifactEvidenceForConsumption, EvidenceConsumptionTracker } from "./evidence-consumption-tracker.js";

const evidenceFact = FactSchema.parse({
  id: "fact_evidence_1",
  caseId: "case_1",
  sourceRunId: "run_1",
  type: "artifact_evidence",
  title: "Recovered service credential",
  value: {
    artifactId: "artifact_1",
    label: "service credential",
    value: "candidate-value",
    evidence: [{ relationship: "configuration -> credential" }],
  },
  source: { type: "artifact_analysis", ref: "artifact_1" },
  confidence: 0.9,
  tags: ["artifact", "evidence"],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

describe("EvidenceConsumptionTracker", () => {
  it("recognizes use of an evidence value and does not require the Fact ID in tool input", () => {
    const tracker = new EvidenceConsumptionTracker();
    tracker.register("task_1", artifactEvidenceForConsumption([evidenceFact]));

    expect(tracker.observe({
      name: "analyze_artifact",
      input: { artifactId: "artifact_1" },
      content: "analyzed",
      ok: true,
    })).toEqual({ type: "none" });
    expect(tracker.observe({
      name: "http_replay",
      input: { authorization: "candidate-value" },
      content: "status=200",
      ok: true,
    })).toEqual({
      type: "consumed",
      taskId: "task_1",
      refs: [{ kind: "fact", id: "fact_evidence_1" }],
      tool: "http_replay",
    });
  });

  it("requests one replan after two unrelated successful active actions without pausing or repeating", () => {
    const tracker = new EvidenceConsumptionTracker(2);
    tracker.register("task_1", artifactEvidenceForConsumption([evidenceFact]));

    expect(tracker.observe({
      name: "get_fact_detail",
      input: { id: "fact_evidence_1" },
      content: "detail",
      ok: true,
    })).toEqual({ type: "none" });
    expect(tracker.observe({
      name: "http_replay",
      input: { path: "/first" },
      content: "status=404",
      ok: true,
    })).toEqual({ type: "none" });
    expect(tracker.observe({
      name: "navigate",
      input: { url: "https://target.invalid/second" },
      content: "ok",
      ok: true,
    })).toEqual({
      type: "replan",
      taskId: "task_1",
      refs: [{ kind: "fact", id: "fact_evidence_1" }],
      missedActions: 2,
    });
    expect(tracker.observe({
      name: "navigate",
      input: { url: "https://target.invalid/third" },
      content: "ok",
      ok: true,
    })).toEqual({ type: "none" });
  });

  it("closes tracking when the owning Task is released", () => {
    const tracker = new EvidenceConsumptionTracker();
    tracker.register("task_1", artifactEvidenceForConsumption([evidenceFact]));

    expect(tracker.observe({
      name: "manage_validation_task",
      input: { taskId: "task_1", action: "release" },
      content: "released",
      ok: true,
    })).toEqual({ type: "closed", taskId: "task_1" });
    expect(tracker.observe({
      name: "http_replay",
      input: { authorization: "candidate-value" },
      content: "status=200",
      ok: true,
    })).toEqual({ type: "none" });
  });
});
