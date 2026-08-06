import { describe, expect, it } from "vitest";
import { createDb } from "./db/client.js";
import { ArtifactAnalyzerRegistry } from "./artifact-analyzer.js";
import { makeManageArtifactLimitationTool } from "./artifact-limitation-tool.js";
import { evaluateArtifactTaskReadiness } from "./artifact-task-readiness.js";
import { ArtifactAnalysisAttemptStore } from "./stores/artifact-analysis-attempt-store.js";
import { ArtifactLimitationStore } from "./stores/artifact-limitation-store.js";
import { ArtifactStore } from "./stores/artifact-store.js";
import { FactStore } from "./stores/fact-store.js";
import { TaskStore } from "./stores/task-store.js";
import { TimelineStore } from "./stores/timeline-store.js";

describe("artifact limitation disposition with real SQLite", () => {
  it("accepts only an exhausted gap and invalidates the acceptance after new analysis", async () => {
    const db = createDb(":memory:");
    const artifacts = new ArtifactStore(db);
    const attempts = new ArtifactAnalysisAttemptStore(db);
    const limitations = new ArtifactLimitationStore(db);
    const facts = new FactStore(db);
    const tasks = new TaskStore(db);
    const timeline = new TimelineStore(db);
    const artifact = artifacts.record({
      caseId: "case_1", runId: "run_1", sourceUrl: null, filename: "evidence.bin", relativePath: "downloads/evidence.bin",
      byteSize: 32, sha256: "a".repeat(64), detectedFormat: "unsupported-binary", mediaType: null,
    });
    const fact = facts.create("case_1", {
      sourceRunId: "run_1", type: "artifact_analysis", title: "Artifact acquired", value: { artifactId: artifact.id },
      source: { type: "artifact_analysis", ref: artifact.id }, confidence: 1, tags: ["artifact"],
    });
    const task = tasks.create("case_1", {
      runId: "run_1", title: "Inspect acquired evidence", status: "blocked", reason: "No compatible analyzer",
      blockedBy: [], triggerWhen: [], relatedFacts: [fact.id], hypothesisIds: ["hypothesis_1"], priority: "high",
    });
    const events: string[] = [];
    const tool = makeManageArtifactLimitationTool({
      caseId: "case_1", runId: "run_1", artifacts, attempts, analyzers: new ArtifactAnalyzerRegistry(), limitations,
      facts, tasks, timeline, emit: (event) => events.push(event.type),
    });

    const accepted = await tool.execute({ action: "accept", taskId: task.id, artifactId: artifact.id, rationale: "No compatible analyzer is registered; preserve this unresolved boundary." });
    expect(accepted.ok).toBe(true);
    const disposition = limitations.getActive(task.id, artifact.id)!;
    expect(disposition).toMatchObject({ status: "accepted", missingDimensions: ["metadata", "text", "object_graph"] });
    expect(disposition.prohibitedConclusion).toContain("does not prove content absence");
    expect(events).toContain("artifact_limitation_updated");
    expect(evaluateArtifactTaskReadiness({
      task, facts: [fact], artifacts: [artifact], attempts: [], dispositions: [disposition],
    }).allowed).toBe(true);
    expect(evaluateArtifactTaskReadiness({
      task, facts: [fact], artifacts: [artifact], attempts: [], dispositions: [disposition],
      capabilitiesByArtifact: {
        [artifact.id]: [{
          analyzerId: "newly-available-analyzer", compatible: true, coverageDimensions: ["metadata"],
          description: "Newly registered metadata analyzer", availability: "ready",
        }],
      },
    }).allowed).toBe(false);

    const attempt = attempts.start({
      caseId: "case_1", runId: "run_1", artifactId: artifact.id,
      analyzerId: "later-analyzer", coverageDimensions: ["metadata"],
    });
    attempts.finish(attempt.id, "failed", "Analyzer could not complete the new path.", null);
    expect(evaluateArtifactTaskReadiness({
      task, facts: [fact], artifacts: [artifact], attempts: attempts.listByCase("case_1"), dispositions: [disposition],
    }).allowed).toBe(false);
  });
});
