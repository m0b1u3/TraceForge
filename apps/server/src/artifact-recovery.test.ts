import { describe, expect, it } from "vitest";
import { evaluateArtifactRecoveryProof } from "./artifact-recovery-tool.js";
import { artifactAnalyzerCapabilityFingerprint } from "./artifact-analyzer.js";

const unavailable = {
  analyzerId: "structured-analyzer",
  compatible: true,
  coverageDimensions: ["object_graph" as const],
  description: "Structured analyzer",
  availability: "unavailable" as const,
  availabilityReason: "Dependency unavailable",
  identity: "environment-a",
};

describe("artifact recovery proof", () => {
  it("rejects an unchanged preflight even when availability is ready", () => {
    const before = artifactAnalyzerCapabilityFingerprint({ ...unavailable, availability: "ready" });
    expect(evaluateArtifactRecoveryProof(before, { ...unavailable, availability: "ready" })).toMatchObject({
      proven: false, identityChanged: false, available: true,
    });
  });

  it("rejects a changed identity while the analyzer remains unavailable", () => {
    expect(evaluateArtifactRecoveryProof("previous", unavailable)).toMatchObject({
      proven: false, identityChanged: true, available: false,
    });
  });

  it("accepts only a changed and available preflight", () => {
    expect(evaluateArtifactRecoveryProof("previous", { ...unavailable, availability: "ready", identity: "environment-b" })).toMatchObject({
      proven: true, identityChanged: true, available: true,
    });
  });
});
