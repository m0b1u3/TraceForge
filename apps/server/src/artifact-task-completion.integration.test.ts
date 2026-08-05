import { describe, expect, it } from "vitest";
import { makeRecordTaskTool } from "@traceforge/extension";
import { createDb } from "./db/client.js";
import { evaluateArtifactTaskReadiness } from "./artifact-task-readiness.js";
import { ArtifactAnalysisAttemptStore } from "./stores/artifact-analysis-attempt-store.js";
import { ArtifactStore } from "./stores/artifact-store.js";
import { FactStore } from "./stores/fact-store.js";
import { TaskStore } from "./stores/task-store.js";
import { TimelineStore } from "./stores/timeline-store.js";

describe("artifact-linked Task completion with real SQLite", () => {
  it("keeps a partial no-match Task blocked and releases it after cumulative coverage closes", async () => {
    const db = createDb(":memory:");
    const artifacts = new ArtifactStore(db);
    const attempts = new ArtifactAnalysisAttemptStore(db);
    const facts = new FactStore(db);
    const tasks = new TaskStore(db);
    const timeline = new TimelineStore(db);
    const artifact = artifacts.record({
      caseId: "case_1", runId: "run_1", sourceUrl: null, filename: "evidence.bin",
      relativePath: "downloads/evidence.bin", byteSize: 32, sha256: "a".repeat(64),
      detectedFormat: "structured-binary", mediaType: null,
    });
    const metadataAnalysis = {
      analyzerId: "metadata-analyzer", summary: "Metadata inspected.", findings: [],
      coverage: { metadata: true, text: false, objectGraph: false, limitations: [] },
    };
    artifacts.updateAnalysis(artifact.id, "analyzed", metadataAnalysis.analyzerId, metadataAnalysis);
    const first = attempts.start({
      caseId: "case_1", runId: "run_1", artifactId: artifact.id,
      analyzerId: metadataAnalysis.analyzerId, coverageDimensions: ["metadata"],
    });
    attempts.finish(first.id, "succeeded", null, metadataAnalysis);
    const analysisFact = facts.create("case_1", {
      sourceRunId: "run_1", type: "artifact_analysis", title: "Artifact inspected",
      value: { artifactId: artifact.id }, source: { type: "artifact_analysis", ref: artifact.id },
      confidence: 1, tags: ["artifact", "analysis"],
    });
    const task = tasks.create("case_1", {
      runId: "run_1", title: "Inspect acquired evidence", status: "running", reason: "",
      blockedBy: [], triggerWhen: [], relatedFacts: [analysisFact.id], hypothesisIds: ["hypothesis_1"], priority: "high",
    });
    const completionGate = (candidate: typeof task) => evaluateArtifactTaskReadiness({
      task: candidate,
      facts: facts.listByCase("case_1"),
      artifacts: artifacts.listByCase("case_1"),
      attempts: attempts.listByCase("case_1"),
    });
    const tool = makeRecordTaskTool("case_1", tasks, timeline, () => undefined, "run_1", undefined, completionGate);

    const blocked = await tool.execute({ id: task.id, title: task.title, status: "done" });
    expect(blocked.ok).toBe(true);
    expect(tasks.getById(task.id)).toMatchObject({ status: "blocked", reason: expect.stringContaining("missing cumulative coverage") });

    const contentAnalysis = {
      analyzerId: "content-analyzer", summary: "Content and relationships inspected.", findings: [],
      coverage: { metadata: false, text: true, objectGraph: true, limitations: [] },
    };
    const second = attempts.start({
      caseId: "case_1", runId: "run_1", artifactId: artifact.id,
      analyzerId: contentAnalysis.analyzerId, coverageDimensions: ["text", "object_graph"],
    });
    attempts.finish(second.id, "succeeded", null, contentAnalysis);
    const completed = await tool.execute({ id: task.id, title: task.title, status: "done" });

    expect(completed.ok).toBe(true);
    expect(tasks.getById(task.id)?.status).toBe("done");
  });
});
