import type { RuntimeEvent } from "@traceforge/shared";
import {
  assessValidationExperiment,
  type ToolDescriptor,
} from "@traceforge/extension";
import type { FactStore } from "./stores/fact-store.js";
import type { TimelineStore } from "./stores/timeline-store.js";
import type { TrafficStore } from "./stores/traffic-store.js";
import type { ValidationConclusionStore } from "./stores/validation-conclusion-store.js";
import type { ValidationConsensusStore } from "./stores/validation-consensus-store.js";
import { evaluateValidationConsensus } from "./validation-consensus.js";

export function makeRecordValidationConclusionTool(input: {
  caseId: string;
  runId: string;
  facts: FactStore;
  traffic: TrafficStore;
  conclusions: ValidationConclusionStore;
  consensus: ValidationConsensusStore;
  timeline: TimelineStore;
  emit: (event: RuntimeEvent) => void;
}): ToolDescriptor {
  return {
    name: "record_validation_conclusion",
    description: "Assess persisted baseline/variant traffic, save a structured validation conclusion, and conservatively update the linked Finding lifecycle. Supports advances candidate to validating; inconclusive never advances; strong refutation reopens verified findings for review.",
    risk: "normal",
    source: "builtin",
    inputSchema: {
      type: "object",
      properties: {
        findingId: { type: "string" },
        gapId: { type: "string" },
        baselineTrafficId: { type: "string" },
        variantTrafficId: { type: "string" },
        protectedFields: { type: "array", items: { type: "string" } },
        confirmationTrafficId: { type: "string" },
        expectedBusinessState: { type: "object" },
        identityId: { type: "string" },
      },
      required: ["findingId", "gapId", "baselineTrafficId", "variantTrafficId"],
    },
    execute: async (raw) => {
      const value = raw as {
        findingId?: string;
        gapId?: string;
        baselineTrafficId?: string;
        variantTrafficId?: string;
        protectedFields?: string[];
        confirmationTrafficId?: string;
        expectedBusinessState?: Record<string, unknown>;
        identityId?: string;
      };
      const finding = value.findingId ? input.facts.getById(value.findingId) : undefined;
      if (!finding || finding.caseId !== input.caseId || finding.type !== "finding") {
        return { ok: false, content: "findingId must reference a Finding in this case" };
      }
      const entries = input.traffic.listByCase(input.caseId);
      const baseline = entries.find((entry) => entry.id === value.baselineTrafficId);
      const variant = entries.find((entry) => entry.id === value.variantTrafficId);
      const confirmation = entries.find((entry) => entry.id === value.confirmationTrafficId);
      if (!baseline || !variant) return { ok: false, content: "baselineTrafficId and variantTrafficId must reference traffic in this case" };
      if (value.confirmationTrafficId && !confirmation) return { ok: false, content: "confirmationTrafficId must reference traffic in this case" };

      const assessment = assessValidationExperiment({
        baseline,
        variant,
        protectedFields: value.protectedFields,
        confirmation,
        expectedBusinessState: value.expectedBusinessState,
      });
      const conclusion = input.conclusions.create({
        caseId: input.caseId,
        runId: input.runId,
        findingId: finding.id,
        gapId: value.gapId ?? "",
        baselineTrafficId: baseline.id,
        variantTrafficId: variant.id,
        confirmationTrafficId: confirmation?.id ?? null,
        identityId: value.identityId ?? variant.identityId ?? null,
        assessment,
      });
      const consensus = input.consensus.upsert(input.caseId, evaluateValidationConsensus({
        findingId: finding.id,
        conclusions: input.conclusions.listByCase(input.caseId),
        traffic: entries,
      }));

      let updatedFinding = finding;
      if (assessment.verdict === "supports" && assessment.confidence >= 0.75) {
        updatedFinding = input.facts.update(finding.id, {
          findingStatus: finding.findingStatus === "candidate" ? "validating" : finding.findingStatus,
          observations: [...(finding.observations ?? []), {
            id: `obs_${conclusion.id}`,
            sourceType: "traffic",
            sourceRef: variant.id,
            runId: input.runId,
            identityId: conclusion.identityId,
            condition: `gap=${conclusion.gapId}; baseline=${baseline.id}; variant=${variant.id}`,
            summary: `Validation ${assessment.verdict} (${assessment.confidence}): ${assessment.signals.join(" ")}`,
            observedAt: conclusion.createdAt,
          }],
        }) ?? finding;
      } else if (assessment.verdict === "refutes" && assessment.confidence >= 0.8 && finding.findingStatus === "verified") {
        updatedFinding = input.facts.update(finding.id, { findingStatus: "needs_review" }) ?? finding;
      }
      if (consensus.status === "conflicted" && ["validating", "verified"].includes(updatedFinding.findingStatus ?? "")) {
        updatedFinding = input.facts.update(finding.id, { findingStatus: "needs_review" }) ?? updatedFinding;
      }

      if (updatedFinding.updateCount !== finding.updateCount) input.emit({ type: "fact_updated", fact: updatedFinding });
      const entry = input.timeline.append(
        input.caseId,
        "validation_conclusion_recorded",
        `${conclusion.verdict} (${conclusion.confidence}) for ${finding.id}; gap=${conclusion.gapId}`,
        conclusion.id,
        input.runId,
      );
      input.emit({ type: "timeline_appended", entry });
      const consensusEntry = input.timeline.append(
        input.caseId,
        "validation_consensus_updated",
        `${consensus.status}; ${consensus.rationale.join("; ")}; recommendation=${consensus.recommendation}`,
        finding.id,
        input.runId,
      );
      input.emit({ type: "timeline_appended", entry: consensusEntry });
      return { ok: true, content: JSON.stringify({ conclusion, consensus, findingStatus: updatedFinding.findingStatus }, null, 2) };
    },
  };
}
