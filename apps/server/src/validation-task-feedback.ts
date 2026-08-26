import type { TimelineEntry } from "@traceforge/shared";

export const VALIDATION_FEEDBACK_HISTORY_LIMIT = 12;

export interface ValidationOutcomeSnapshot {
  evidenceCount: number;
  evidenceSignature: string;
  consensusSignature: string;
  attackPathSignature: string;
}

export interface ValidationFeedbackObservation {
  findingId: string;
  taskId: string;
  tool: string;
  evidenceProduced: number;
  consensusAdvanced: boolean;
  attackPathAdvanced: boolean;
  /**
   * A tool may produce an observable external state transition before the
   * agent records it as evidence. This prevents that boundary from being
   * treated as repetition, but deliberately does not increase evidence or
   * verification scores.
   */
  observableChange?: boolean;
  failed: boolean;
  noProgress: boolean;
}

export interface ValidationFeedbackSummary {
  toolBoundaries: number;
  evidenceProduced: number;
  consensusAdvances: number;
  attackPathAdvances: number;
  failures: number;
  noProgress: number;
  scoreAdjustment: number;
}

export type ValidationFeedbackHistory = Record<string, ValidationFeedbackObservation[]>;

export function observeValidationOutcome(input: {
  findingId: string;
  taskId: string;
  tool: string;
  ok: boolean;
  before: ValidationOutcomeSnapshot;
  after: ValidationOutcomeSnapshot;
  observableChange?: boolean;
}): ValidationFeedbackObservation {
  const evidenceProduced = Math.max(
    input.after.evidenceCount - input.before.evidenceCount,
    input.after.evidenceSignature !== input.before.evidenceSignature ? 1 : 0,
  );
  const consensusAdvanced = input.after.consensusSignature !== input.before.consensusSignature;
  const attackPathAdvanced = input.after.attackPathSignature !== input.before.attackPathSignature;
  return {
    findingId: input.findingId,
    taskId: input.taskId,
    tool: input.tool,
    evidenceProduced,
    consensusAdvanced,
    attackPathAdvanced,
    observableChange: input.observableChange || undefined,
    failed: !input.ok,
    noProgress: input.ok && evidenceProduced === 0 && !consensusAdvanced && !attackPathAdvanced && !input.observableChange,
  };
}

export function appendValidationFeedback(history: ValidationFeedbackHistory, observation: ValidationFeedbackObservation): ValidationFeedbackHistory {
  const existing = history[observation.findingId] ?? [];
  return { ...history, [observation.findingId]: [...existing, observation].slice(-VALIDATION_FEEDBACK_HISTORY_LIMIT) };
}

export function summarizeValidationFeedback(observations: ValidationFeedbackObservation[]): ValidationFeedbackSummary {
  const summary = observations.reduce((value, item) => ({
    toolBoundaries: value.toolBoundaries + 1,
    evidenceProduced: value.evidenceProduced + item.evidenceProduced,
    consensusAdvances: value.consensusAdvances + Number(item.consensusAdvanced),
    attackPathAdvances: value.attackPathAdvances + Number(item.attackPathAdvanced),
    failures: value.failures + Number(item.failed),
    noProgress: value.noProgress + Number(item.noProgress),
  }), { toolBoundaries: 0, evidenceProduced: 0, consensusAdvances: 0, attackPathAdvances: 0, failures: 0, noProgress: 0 });
  const positive = Math.min(18, summary.evidenceProduced * 3 + summary.consensusAdvances * 6 + summary.attackPathAdvances * 7);
  const cost = Math.min(25, summary.failures * 5 + summary.noProgress * 2 + Math.max(0, summary.toolBoundaries - 4));
  return { ...summary, scoreAdjustment: positive - cost };
}

export function summarizeValidationFeedbackHistory(history: ValidationFeedbackHistory): Record<string, ValidationFeedbackSummary> {
  return Object.fromEntries(Object.entries(history).map(([findingId, observations]) => [findingId, summarizeValidationFeedback(observations)]));
}

export function recoverValidationFeedback(entries: TimelineEntry[]): ValidationFeedbackHistory {
  let history: ValidationFeedbackHistory = {};
  for (const entry of entries.filter((item) => item.eventType === "validation_feedback_recorded")) {
    try {
      const observation = JSON.parse(entry.detail) as ValidationFeedbackObservation;
      if (!observation.findingId || !observation.taskId || !observation.tool) continue;
      history = appendValidationFeedback(history, observation);
    } catch {
      // Ignore legacy or malformed audit entries; they must not block a Run.
    }
  }
  return history;
}
