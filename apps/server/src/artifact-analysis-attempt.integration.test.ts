import { describe, expect, it } from "vitest";
import { createDb } from "./db/client.js";
import { ArtifactAnalyzerRegistry } from "./artifact-analyzer.js";
import { makeAnalyzeArtifactTool } from "./artifact-tools.js";
import { ArtifactAnalysisAttemptStore } from "./stores/artifact-analysis-attempt-store.js";
import { ArtifactStore } from "./stores/artifact-store.js";

describe("artifact analysis attempts with real SQLite", () => {
  it("does not fabricate an execution attempt when no compatible analyzer exists", async () => {
    const db = createDb(":memory:");
    const artifacts = new ArtifactStore(db);
    const attempts = new ArtifactAnalysisAttemptStore(db);
    const artifact = artifacts.record({
      caseId: "case_1",
      runId: "run_1",
      sourceUrl: null,
      filename: "evidence.bin",
      relativePath: "downloads/evidence.bin",
      byteSize: 32,
      sha256: "a".repeat(64),
      detectedFormat: "structured-binary",
      mediaType: "application/octet-stream",
    });
    const tool = makeAnalyzeArtifactTool(
      "case_1",
      process.cwd(),
      artifacts,
      new ArtifactAnalyzerRegistry(),
      { attempts, runId: "run_1" },
    );

    const first = await tool.execute({ artifactId: artifact.id });
    const second = await tool.execute({ artifactId: artifact.id });

    expect(first.ok).toBe(false);
    expect(first.content).toContain("No registered analyzer is compatible");
    expect(second.content).toContain("No registered analyzer is compatible");
    expect(attempts.listByArtifact(artifact.id)).toHaveLength(0);

    await tool.execute({ artifactId: artifact.id, retry: true });
    expect(attempts.listByArtifact(artifact.id)).toHaveLength(0);
  });

  it("persists a running attempt transition without losing its identity", () => {
    const store = new ArtifactAnalysisAttemptStore(createDb(":memory:"));
    const running = store.start({
      caseId: "case_1",
      runId: "run_1",
      artifactId: "artifact_1",
      analyzerId: "analyzer_1",
      coverageDimensions: ["metadata"],
    });
    const finished = store.finish(running.id, "failed", "Analyzer exited.");

    expect(finished).toMatchObject({ id: running.id, status: "failed", error: "Analyzer exited." });
    expect(store.listByCase("case_1")).toEqual([finished]);
  });

  it("recovers unfinished attempts after a process restart", () => {
    const db = createDb(":memory:");
    const firstProcess = new ArtifactAnalysisAttemptStore(db);
    const running = firstProcess.start({
      caseId: "case_1",
      runId: "run_1",
      artifactId: "artifact_1",
      analyzerId: "analyzer_1",
      coverageDimensions: ["object_graph"],
    });

    const recovered = new ArtifactAnalysisAttemptStore(db).recoverInterrupted();
    expect(recovered).toEqual([
      expect.objectContaining({ id: running.id, status: "failed", finishedAt: expect.any(String) }),
    ]);
  });
});
