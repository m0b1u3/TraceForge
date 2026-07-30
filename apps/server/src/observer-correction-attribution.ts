import { createHash } from "node:crypto";
import type { AgentEventRefs, ObserverWarning } from "@traceforge/shared";

interface ToolObservation {
  signature: string;
  inputText: string;
  ok: boolean;
  refs: Set<string>;
}

interface PendingCorrection {
  observationIndex: number;
  priorSuccessfulSignatures: Set<string>;
  relatedRefs: Set<string>;
}

export interface CorrectionAttribution {
  attributed: boolean;
  evidence: string;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]),
  );
}

function executionSignature(tool: string, input: unknown): string {
  const serialized = JSON.stringify(stableValue(input)) ?? "null";
  return createHash("sha256")
    .update(`${tool}\n${serialized}`)
    .digest("hex");
}

function refSet(refs: AgentEventRefs | null | undefined): Set<string> {
  return new Set([
    ...(refs?.factIds ?? []),
    ...(refs?.taskIds ?? []),
    ...(refs?.timelineEntryIds ?? []),
  ]);
}

export class ObserverCorrectionAttribution {
  private readonly observations: ToolObservation[] = [];
  private readonly pending = new Map<string, PendingCorrection>();
  private readonly claimedObservationIndexes = new Set<number>();

  issue(warning: Pick<ObserverWarning, "id" | "relatedFacts" | "relatedTasks">): void {
    this.pending.set(warning.id, {
      observationIndex: this.observations.length,
      priorSuccessfulSignatures: new Set(
        this.observations.filter((observation) => observation.ok).map((observation) => observation.signature),
      ),
      relatedRefs: new Set([...warning.relatedFacts, ...warning.relatedTasks]),
    });
  }

  observe(input: {
    tool: string;
    args: unknown;
    ok: boolean;
    refs?: AgentEventRefs | null;
  }): void {
    this.observations.push({
      signature: executionSignature(input.tool, input.args),
      inputText: JSON.stringify(stableValue(input.args)) ?? "null",
      ok: input.ok,
      refs: refSet(input.refs),
    });
  }

  assess(warningId: string): CorrectionAttribution {
    const correction = this.pending.get(warningId);
    if (!correction) {
      return {
        attributed: false,
        evidence: "No tracked Observer correction preceded the warning transition.",
      };
    }

    const after = this.observations
      .map((observation, index) => ({ observation, index }))
      .slice(correction.observationIndex)
      .filter(({ index }) => !this.claimedObservationIndexes.has(index));
    const successful = after.filter(({ observation }) => observation.ok);
    const changed = successful.filter(({ observation }) =>
      !correction.priorSuccessfulSignatures.has(observation.signature));
    const relevant = changed.filter(({ observation }) => {
      if (correction.relatedRefs.size === 0) return true;
      return [...correction.relatedRefs].some((ref) =>
        observation.refs.has(ref) || observation.inputText.includes(ref));
    });
    const withMaterialResult = relevant.filter(({ observation }) => observation.refs.size > 0);
    const recovered = after.find(({ observation }, index) =>
      observation.ok
      && after.slice(0, index).some(({ observation: prior }) =>
        !prior.ok && prior.signature === observation.signature));

    const attributed = withMaterialResult.length > 0 || Boolean(recovered);
    const attributedObservation = withMaterialResult[0] ?? recovered;
    if (attributedObservation) this.claimedObservationIndexes.add(attributedObservation.index);
    const evidence = attributed
      ? [
          `behaviorChange=${changed.length}`,
          `relevantActions=${relevant.length}`,
          `materialResults=${withMaterialResult.length}`,
          `recoveredExecution=${Boolean(recovered)}`,
        ].join("; ")
      : [
          `successfulActions=${successful.length}`,
          `behaviorChange=${changed.length}`,
          `relevantActions=${relevant.length}`,
          "No correction-linked evidence or recovered execution was observed.",
        ].join("; ");
    this.pending.delete(warningId);
    return { attributed, evidence };
  }
}
