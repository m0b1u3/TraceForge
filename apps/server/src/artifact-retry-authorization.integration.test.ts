import { describe, expect, it } from "vitest";
import { createDb } from "./db/client.js";
import { ArtifactRetryAuthorizationStore } from "./stores/artifact-retry-authorization-store.js";

describe("artifact retry authorization with real SQLite", () => {
  it("persists and consumes one authorization exactly once", () => {
    const store = new ArtifactRetryAuthorizationStore(createDb(":memory:"));
    const authorization = store.authorize({
      caseId: "case_1",
      runId: "run_1",
      artifactId: "artifact_1",
      analyzerId: "analyzer_1",
      failedAttemptId: "attempt_1",
      preflightFingerprint: "fingerprint_1",
      reason: "A transient external condition was independently resolved.",
    });

    expect(store.getActive("artifact_1", "analyzer_1")).toEqual(authorization);
    expect(store.consume(authorization.id)).toMatchObject({ status: "consumed" });
    expect(store.getActive("artifact_1", "analyzer_1")).toBeUndefined();
    expect(store.consume(authorization.id)).toMatchObject({ status: "consumed" });
    expect(store.listByCase("case_1")).toHaveLength(1);
  });

  it("revokes a previous unused authorization when a new one is granted", () => {
    const store = new ArtifactRetryAuthorizationStore(createDb(":memory:"));
    const first = store.authorize({
      caseId: "case_1", runId: null, artifactId: "artifact_1", analyzerId: "analyzer_1",
      failedAttemptId: "attempt_1", preflightFingerprint: "fingerprint_1", reason: "First reviewed retry.",
    });
    const second = store.authorize({
      caseId: "case_1", runId: null, artifactId: "artifact_1", analyzerId: "analyzer_1",
      failedAttemptId: "attempt_2", preflightFingerprint: "fingerprint_1", reason: "New failure reviewed.",
    });

    expect(store.getById(first.id)).toMatchObject({ status: "revoked" });
    expect(store.getActive("artifact_1", "analyzer_1")?.id).toBe(second.id);
  });
});
