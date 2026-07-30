import { createHash } from "node:crypto";
import type {
  AgentEventRefs,
  ObserverCorrectionAudit,
  ObserverWarning,
} from "@traceforge/shared";

interface ToolObservation {
  tool: string;
  signature: string;
  inputText: string;
  ok: boolean;
  refs: Set<string>;
}

interface PendingCorrection {
  observationIndex: number;
  priorSuccessfulSignatures: Set<string>;
  relatedRefs: Set<string>;
  trigger: string | null;
  instruction: string;
}

export interface CorrectionAttribution {
  attributed: boolean;
  audit: ObserverCorrectionAudit;
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

  issue(warning: Pick<
    ObserverWarning,
    "id" | "relatedFacts" | "relatedTasks" | "lastCorrectionTrigger" | "suggestedAction"
  >): void {
    this.pending.set(warning.id, {
      observationIndex: this.observations.length,
      priorSuccessfulSignatures: new Set(
        this.observations.filter((observation) => observation.ok).map((observation) => observation.signature),
      ),
      relatedRefs: new Set([...warning.relatedFacts, ...warning.relatedTasks]),
      trigger: warning.lastCorrectionTrigger,
      instruction: warning.suggestedAction,
    });
  }

  observe(input: {
    tool: string;
    args: unknown;
    ok: boolean;
    refs?: AgentEventRefs | null;
  }): void {
    this.observations.push({
      tool: input.tool,
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
        audit: {
          version: 1,
          attributed: false,
          reason: "no_tracked_correction",
          trigger: null,
          instruction: "",
          actions: [],
          evidenceRefs: [],
          summary: "No tracked Observer correction preceded the warning transition.",
        },
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
    const summary = withMaterialResult.length > 0
      ? `The correction was followed by ${changed.length} changed action(s); ${withMaterialResult.length} relevant action(s) produced traceable evidence.`
      : recovered
        ? "An execution that failed after the correction subsequently succeeded with the same scope and input."
        : `The warning ended, but ${successful.length} successful action(s) produced no correction-linked evidence or recovered execution.`;
    const auditActions = after.slice(0, 6).map(({ observation }) => ({
      tool: observation.tool,
      outcome: observation.ok ? "succeeded" as const : "failed" as const,
      evidenceRefs: [...observation.refs].slice(0, 12),
    }));
    const evidenceRefs = [...new Set(
      (attributedObservation ? [...attributedObservation.observation.refs] : [])
        .filter(Boolean),
    )].slice(0, 12);
    this.pending.delete(warningId);
    return {
      attributed,
      audit: {
        version: 1,
        attributed,
        reason: withMaterialResult.length > 0
          ? "correction_linked_result"
          : recovered
            ? "execution_recovered"
            : "no_linked_result",
        trigger: correction.trigger,
        instruction: correction.instruction,
        actions: auditActions,
        evidenceRefs,
        summary,
      },
    };
  }
}
