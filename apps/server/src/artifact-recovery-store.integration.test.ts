import { describe, expect, it } from "vitest";
import { createDb } from "./db/client.js";
import { ArtifactRecoveryStore } from "./stores/artifact-recovery-store.js";

describe("artifact recovery store with real SQLite", () => {
  it("persists one active recovery and its lifecycle evidence", () => {
    const store = new ArtifactRecoveryStore(createDb(":memory:"));
    const input = {
      caseId: "case_1", runId: "run_1", taskId: "task_1", artifactId: "artifact_1",
      analyzerId: "analyzer_1", failedAttemptId: null, beforeFingerprint: "before",
      instruction: "Restore the declared analyzer dependency.",
    };
    const planned = store.create(input);
    expect(store.create(input).id).toBe(planned.id);
    expect(store.update(planned.id, { status: "running" })).toMatchObject({ status: "running" });
    expect(store.update(planned.id, { status: "succeeded", afterFingerprint: "after", result: "Preflight ready." })).toMatchObject({
      status: "succeeded", afterFingerprint: "after", result: "Preflight ready.",
    });
    expect(store.getActive("artifact_1", "analyzer_1")).toBeUndefined();
    expect(store.listByCase("case_1")).toHaveLength(1);
  });
});
