import { describe, expect, it } from "vitest";
import type { ArtifactRecord, RuntimeEvent } from "@traceforge/shared";
import { createDb } from "./db/client.js";
import { connectArtifactEvidenceLifecycle } from "./artifact-evidence-lifecycle.js";
import { FactStore } from "./stores/fact-store.js";
import { TaskStore } from "./stores/task-store.js";
import { TimelineStore } from "./stores/timeline-store.js";

function analyzedArtifact(): ArtifactRecord {
  return {
    id: "artifact_1",
    caseId: "case_1",
    runId: "run_acquisition",
    sourceUrl: "https://target.invalid/download",
    filename: "artifact.bin",
    relativePath: "downloads/artifact.bin",
    byteSize: 128,
    sha256: "a".repeat(64),
    detectedFormat: "structured-binary",
    mediaType: "application/octet-stream",
    status: "analyzed",
    analyzerId: "structured-analyzer",
    analysis: {
      analyzerId: "structured-analyzer",
      summary: "Recovered one candidate with an object relationship.",
      coverage: { metadata: true, text: true, objectGraph: true, limitations: [] },
      findings: [{
        kind: "credential",
        label: "service credential",
        value: "candidate-value",
        confidence: 0.9,
        evidence: [{ objectId: "object_1", relationship: "configuration -> credential" }],
      }],
    },
    error: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
  };
}

describe("artifact evidence lifecycle with real SQLite", () => {
  it("links analyzed evidence to only the currently running Task in the execution Run", () => {
    const db = createDb(":memory:");
    const facts = new FactStore(db);
    const tasks = new TaskStore(db);
    const timeline = new TimelineStore(db);
    const current = tasks.create("case_1", {
      runId: "run_current",
      title: "Validate first candidate",
      status: "running",
      reason: "collecting evidence",
      blockedBy: [],
      triggerWhen: [],
      relatedFacts: [],
      hypothesisIds: ["hypothesis_1"],
      priority: "high",
    });
    const queued = tasks.create("case_1", {
      runId: "run_current",
      title: "Validate second candidate",
      status: "open",
      reason: "queued",
      blockedBy: [],
      triggerWhen: [],
      relatedFacts: [],
      hypothesisIds: ["hypothesis_2"],
      priority: "medium",
    });
    const evidence = facts.create("case_1", {
      sourceRunId: "run_acquisition",
      type: "artifact_evidence",
      title: "Recovered candidate",
      value: { artifactId: "artifact_1", value: "candidate-value" },
      source: { type: "artifact_analysis", ref: "artifact_1" },
      confidence: 0.9,
      tags: ["artifact", "evidence"],
    });
    const events: RuntimeEvent[] = [];

    const result = connectArtifactEvidenceLifecycle({
      runId: "run_current",
      artifact: analyzedArtifact(),
      artifactFacts: [evidence],
      facts,
      tasks,
      timeline,
      emit: (event) => events.push(event),
    });
    const repeated = connectArtifactEvidenceLifecycle({
      runId: "run_current",
      artifact: analyzedArtifact(),
      artifactFacts: [facts.getById(evidence.id)!],
      facts,
      tasks,
      timeline,
      emit: (event) => events.push(event),
    });

    expect(result.task?.id).toBe(current.id);
    expect(tasks.getById(current.id)?.status).toBe("running");
    expect(tasks.getById(current.id)?.relatedFacts).toEqual([evidence.id]);
    expect(tasks.getById(queued.id)?.relatedFacts).toEqual([]);
    expect(facts.getById(evidence.id)?.taskIds).toEqual([current.id]);
    expect(result.runtimeMessage).toContain("Continue this same Task");
    expect(repeated.runtimeMessage).toBeUndefined();
    expect(events.some((event) => event.type === "task_updated")).toBe(true);
    expect(timeline.listByCase("case_1").filter((entry) =>
      entry.eventType === "artifact_evidence_linked")).toHaveLength(1);
  });

  it("is idempotent and does not auto-claim a queued Task", () => {
    const db = createDb(":memory:");
    const facts = new FactStore(db);
    const tasks = new TaskStore(db);
    const timeline = new TimelineStore(db);
    const queued = tasks.create("case_1", {
      runId: "run_current",
      title: "Validate candidate",
      status: "open",
      reason: "queued",
      blockedBy: [],
      triggerWhen: [],
      relatedFacts: [],
      hypothesisIds: ["hypothesis_1"],
      priority: "high",
    });
    const evidence = facts.create("case_1", {
      sourceRunId: "run_acquisition",
      type: "artifact_analysis",
      title: "Artifact analysis",
      value: { artifactId: "artifact_1" },
      source: { type: "artifact_analysis", ref: "artifact_1" },
      confidence: 0.8,
      tags: ["artifact", "analysis"],
    });

    const first = connectArtifactEvidenceLifecycle({
      runId: "run_current",
      artifact: analyzedArtifact(),
      artifactFacts: [evidence],
      facts,
      tasks,
      timeline,
      emit: () => undefined,
    });
    const second = connectArtifactEvidenceLifecycle({
      runId: "run_current",
      artifact: analyzedArtifact(),
      artifactFacts: [evidence],
      facts,
      tasks,
      timeline,
      emit: () => undefined,
    });

    expect(first.task).toBeUndefined();
    expect(second.runtimeMessage).toBeUndefined();
    expect(tasks.getById(queued.id)?.status).toBe("open");
    expect(timeline.listByCase("case_1")).toHaveLength(0);
  });

  it("keeps an incomplete analysis gap on the one running Task without starting another Task", () => {
    const db = createDb(":memory:");
    const facts = new FactStore(db);
    const tasks = new TaskStore(db);
    const timeline = new TimelineStore(db);
    const current = tasks.create("case_1", {
      runId: "run_current",
      title: "Investigate current evidence",
      status: "running",
      reason: "analysis in progress",
      blockedBy: [],
      triggerWhen: [],
      relatedFacts: [],
      hypothesisIds: ["hypothesis_1"],
      priority: "high",
    });
    const queued = tasks.create("case_1", {
      runId: "run_current",
      title: "Investigate another candidate",
      status: "open",
      reason: "queued",
      blockedBy: [],
      triggerWhen: [],
      relatedFacts: [],
      hypothesisIds: ["hypothesis_2"],
      priority: "medium",
    });
    const analysisFact = facts.create("case_1", {
      sourceRunId: "run_current",
      type: "artifact_analysis",
      title: "Partial artifact analysis",
      value: { artifactId: "artifact_1" },
      source: { type: "artifact_analysis", ref: "artifact_1" },
      confidence: 1,
      tags: ["artifact", "analysis"],
    });
    const partial = analyzedArtifact();
    partial.analysis = {
      ...partial.analysis!,
      findings: [],
      coverage: {
        metadata: true,
        text: false,
        objectGraph: true,
        limitations: ["Text layer was not inspected."],
      },
    };

    const result = connectArtifactEvidenceLifecycle({
      runId: "run_current",
      artifact: partial,
      artifactFacts: [analysisFact],
      facts,
      tasks,
      timeline,
      emit: () => undefined,
    });

    expect(result.task?.id).toBe(current.id);
    expect(tasks.getById(current.id)?.triggerWhen).toEqual([
      expect.stringContaining("[Artifact coverage artifact_1]"),
    ]);
    expect(tasks.getById(queued.id)?.status).toBe("open");
    expect(result.runtimeMessage).toContain("Cumulative coverage quality: incomplete");
    expect(timeline.listByCase("case_1").filter((entry) =>
      entry.eventType === "artifact_coverage_gap_recorded")).toHaveLength(1);
  });
});
