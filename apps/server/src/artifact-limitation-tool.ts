import type { ArtifactLimitationDisposition, RuntimeEvent } from "@traceforge/shared";
import { TOOL_SECURITY, type ToolDescriptor } from "@traceforge/extension";
import { aggregateArtifactAnalysis } from "@traceforge/shared";
import type { ArtifactAnalyzerRegistry } from "./artifact-analyzer.js";
import { planArtifactAnalysis } from "./artifact-analysis-planner.js";
import type { ArtifactAnalysisAttemptStore } from "./stores/artifact-analysis-attempt-store.js";
import type { ArtifactLimitationStore } from "./stores/artifact-limitation-store.js";
import type { ArtifactStore } from "./stores/artifact-store.js";
import type { FactStore } from "./stores/fact-store.js";
import type { TaskStore } from "./stores/task-store.js";
import type { TimelineStore } from "./stores/timeline-store.js";

type LimitationEvent = Extract<RuntimeEvent, { type: "artifact_limitation_updated" | "timeline_appended" }>;

export function makeManageArtifactLimitationTool(input: {
  caseId: string;
  runId: string;
  artifacts: ArtifactStore;
  attempts: ArtifactAnalysisAttemptStore;
  analyzers: ArtifactAnalyzerRegistry;
  limitations: ArtifactLimitationStore;
  facts: FactStore;
  tasks: TaskStore;
  timeline: TimelineStore;
  emit: (event: LimitationEvent) => void;
}): ToolDescriptor {
  const publish = (value: ArtifactLimitationDisposition, eventType: string) => {
    input.emit({ type: "artifact_limitation_updated", disposition: value });
    const entry = input.timeline.append(input.caseId, eventType, JSON.stringify(value), value.taskId, input.runId);
    input.emit({ type: "timeline_appended", entry });
  };
  return {
    name: "manage_artifact_limitation",
    description: "Accept or revoke an unresolved artifact-analysis limitation. Acceptance is allowed only after every compatible analyzer path is exhausted or no compatible analyzer exists. It permits Task lifecycle closure but never proves absence or verifies/rejects a security finding.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["accept", "revoke"] },
        taskId: { type: "string" }, artifactId: { type: "string" }, rationale: { type: "string" }, dispositionId: { type: "string" },
      },
      required: ["action"],
    },
    security: TOOL_SECURITY.caseWrite,
    source: "builtin",
    executionMode: "serial",
    execute: async (raw) => {
      const request = raw as { action?: string; taskId?: string; artifactId?: string; rationale?: string; dispositionId?: string };
      if (request.action === "revoke") {
        const current = request.dispositionId ? input.limitations.getById(request.dispositionId) : undefined;
        if (!current || current.caseId !== input.caseId) return { ok: false, content: "Artifact limitation disposition was not found in this Case." };
        const revoked = input.limitations.revoke(current.id)!;
        publish(revoked, "artifact_limitation_revoked");
        return { ok: true, content: `Revoked artifact limitation ${revoked.id}. Re-evaluate the linked Task before completion.` };
      }
      if (request.action !== "accept") return { ok: false, content: "action must be accept or revoke" };
      if (!request.taskId || !request.artifactId || !request.rationale?.trim()) {
        return { ok: false, content: "accept requires taskId, artifactId, and a concrete rationale" };
      }
      const task = input.tasks.getById(request.taskId);
      const artifact = input.artifacts.getById(request.artifactId);
      if (!task || task.caseId !== input.caseId || task.runId !== input.runId) return { ok: false, content: "Task was not found in the current Run." };
      if (!artifact || artifact.caseId !== input.caseId) return { ok: false, content: "Artifact was not found in this Case." };
      if (!task.relatedFacts.some((factId) => {
        const fact = input.facts.getById(factId);
        return fact?.source.type === "artifact_analysis" && fact.source.ref === artifact.id;
      })) return { ok: false, content: "Task is not linked to this Artifact through a recorded Fact." };
      const attempts = input.attempts.listByArtifact(artifact.id);
      const plan = planArtifactAnalysis(artifact, input.analyzers.capabilities(artifact), attempts);
      if (!["blocked", "exhausted"].includes(plan.status)) {
        return {
          ok: false,
          content: `Artifact limitation cannot be accepted while analysis plan is ${plan.status}. ${plan.reason} Environment recovery and analysis exhaustion are different states.`,
        };
      }
      const aggregate = aggregateArtifactAnalysis(artifact, attempts);
      if (aggregate.quality === "substantial") return { ok: false, content: "Artifact has complete cumulative coverage; no limitation acceptance is required." };
      const disposition = input.limitations.accept({
        caseId: input.caseId, runId: input.runId, taskId: task.id, artifactId: artifact.id,
        missingDimensions: aggregate.missingDimensions,
        attemptIds: attempts.map((attempt) => attempt.id).sort(),
        rationale: request.rationale.trim(),
      });
      publish(disposition, "artifact_limitation_accepted");
      return {
        ok: true,
        content: `Accepted artifact limitation ${disposition.id}. Missing=${disposition.missingDimensions.join(",") || "none"}. ${disposition.prohibitedConclusion}`,
      };
    },
  };
}
