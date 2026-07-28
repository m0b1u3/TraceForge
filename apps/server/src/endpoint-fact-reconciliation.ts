import {
  classifyEndpointObservation,
  isUnsupportedObservedEndpointFact,
  type Fact,
  type TimelineEntry,
} from "@traceforge/shared";
import type { FactStore } from "./stores/fact-store.js";
import type { TimelineStore } from "./stores/timeline-store.js";

export interface EndpointFactReconciliation {
  facts: Fact[];
  timelineEntries: TimelineEntry[];
}

export function reconcileUnsupportedEndpointFacts(
  caseId: string,
  factStore: FactStore,
  timelineStore: TimelineStore,
): EndpointFactReconciliation {
  const result: EndpointFactReconciliation = { facts: [], timelineEntries: [] };
  for (const fact of factStore.listByCase(caseId).filter(isUnsupportedObservedEndpointFact)) {
    const value = fact.value as Record<string, unknown>;
    const sampleStatus = typeof value.sampleStatus === "number" ? value.sampleStatus : undefined;
    const errorSignal = classifyEndpointObservation(sampleStatus) === "error_signal";
    const updated = factStore.update(fact.id, errorSignal
      ? {
          type: "http_error_signal",
          value: { ...value, evidenceClass: "error_signal" },
          confidence: Math.min(fact.confidence, 0.5),
          tags: [...new Set([...fact.tags, "error-signal", "requires-validation"])],
          validity: "valid",
        }
      : { validity: "superseded" });
    if (!updated) continue;
    const entry = timelineStore.append(
      caseId,
      "fact_updated",
      errorSignal
        ? `Auto-discovered endpoint observation reclassified as an error signal because status ${sampleStatus} requires causal validation.`
        : `Auto-discovered endpoint observation superseded because status ${sampleStatus} does not establish endpoint existence.`,
      fact.id,
    );
    result.facts.push(updated);
    result.timelineEntries.push(entry);
  }
  return result;
}
