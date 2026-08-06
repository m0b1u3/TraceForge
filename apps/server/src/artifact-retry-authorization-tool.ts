import type { ArtifactRetryAuthorization, RuntimeEvent } from "@traceforge/shared";
import type { ToolDescriptor } from "@traceforge/extension";
import { artifactAnalyzerCapabilityFingerprint, type ArtifactAnalyzerRegistry } from "./artifact-analyzer.js";
import type { ArtifactAnalysisAttemptStore } from "./stores/artifact-analysis-attempt-store.js";
import type { ArtifactRetryAuthorizationStore } from "./stores/artifact-retry-authorization-store.js";
import type { ArtifactStore } from "./stores/artifact-store.js";
import type { TimelineStore } from "./stores/timeline-store.js";

type RetryEvent = Extract<RuntimeEvent, { type: "artifact_retry_authorization_updated" | "timeline_appended" }>;

export function makeAuthorizeArtifactRetryTool(input: {
  caseId: string;
  runId: string;
  artifacts: ArtifactStore;
  attempts: ArtifactAnalysisAttemptStore;
  analyzers: ArtifactAnalyzerRegistry;
  authorizations: ArtifactRetryAuthorizationStore;
  timeline: TimelineStore;
  emit: (event: RetryEvent) => void;
}): ToolDescriptor {
  const publish = (authorization: ArtifactRetryAuthorization) => {
    input.emit({ type: "artifact_retry_authorization_updated", authorization });
    const entry = input.timeline.append(
      input.caseId,
      "artifact_retry_authorized",
      `Artifact=${authorization.artifactId}; analyzer=${authorization.analyzerId}; failedAttempt=${authorization.failedAttemptId}; reason=${authorization.reason}`,
      authorization.artifactId,
      input.runId,
    );
    input.emit({ type: "timeline_appended", entry });
  };
  return {
    name: "authorize_artifact_retry",
    description: "Request human authorization to retry one failed or unsupported artifact analyzer when its preflight identity has not changed. Use only after documenting why a same-condition retry is justified.",
    inputSchema: {
      type: "object",
      properties: {
        artifactId: { type: "string" },
        analyzerId: { type: "string" },
        reason: { type: "string" },
      },
      required: ["artifactId", "analyzerId", "reason"],
    },
    risk: "command",
    source: "builtin",
    executionMode: "serial",
    execute: async (raw) => {
      const request = raw as { artifactId?: string; analyzerId?: string; reason?: string };
      if (!request.artifactId || !request.analyzerId || !request.reason?.trim()) {
        return { ok: false, content: "artifactId, analyzerId, and a concrete retry reason are required" };
      }
      const artifact = input.artifacts.getById(request.artifactId);
      if (!artifact || artifact.caseId !== input.caseId) return { ok: false, content: "Artifact was not found in this Case." };
      const capability = input.analyzers.capabilities(artifact).find((item) =>
        item.analyzerId === request.analyzerId && item.compatible);
      if (!capability) return { ok: false, content: "Analyzer is not compatible with this Artifact." };
      if (capability.availability === "unavailable") {
        return { ok: false, content: `Analyzer preflight is unavailable. ${capability.availabilityReason ?? ""} ${capability.recoveryHint ?? ""}`.trim() };
      }
      const failed = input.attempts.listByArtifact(artifact.id).find((attempt) =>
        attempt.analyzerId === request.analyzerId && ["failed", "unsupported"].includes(attempt.status));
      if (!failed) return { ok: false, content: "No failed or unsupported attempt exists for this Analyzer." };
      const fingerprint = artifactAnalyzerCapabilityFingerprint(capability);
      if (failed.preflightFingerprint && failed.preflightFingerprint !== fingerprint) {
        return { ok: false, content: "Analyzer preflight identity has changed; human retry authorization is unnecessary. Re-plan and run the eligible Analyzer." };
      }
      const authorization = input.authorizations.authorize({
        caseId: input.caseId,
        runId: input.runId,
        artifactId: artifact.id,
        analyzerId: capability.analyzerId,
        failedAttemptId: failed.id,
        preflightFingerprint: fingerprint,
        reason: request.reason.trim(),
      });
      publish(authorization);
      return { ok: true, content: `Authorized one retry for ${capability.analyzerId} against failed attempt ${failed.id}. The authorization is consumed when analysis starts.` };
    },
  };
}
