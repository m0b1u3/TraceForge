import type { AttackPath, Fact, Task } from "@traceforge/shared";
import type { ValidationConsensusResult } from "./validation-consensus.js";
import type { ValidationFeedbackSummary } from "./validation-task-feedback.js";

const CONSENSUS_KEY = /^\[Consensus:([^:\]]+):(insufficient|supported|conflicted|refuted)\]/;
const PRIORITY_SCORE: Record<Task["priority"], number> = { high: 25, medium: 15, low: 5 };
const ORDINARY_SCORE: Record<Task["priority"], number> = { high: 50, medium: 35, low: 20 };
const SEVERITY_SCORE: Record<string, number> = { critical: 30, high: 24, medium: 16, low: 8, info: 3 };
const CONSENSUS_SCORE: Record<ValidationConsensusResult["status"], number> = { conflicted: 25, insufficient: 22, supported: 16, refuted: 8 };
const VERIFICATION_COST: Record<ValidationConsensusResult["status"], number> = { conflicted: 12, insufficient: 8, supported: 4, refuted: 3 };

export interface RankedValidationTask {
  task: Task;
  score: number;
  reasons: string[];
  validation: boolean;
}

function severityOf(finding: Fact): string {
  const value = finding.value as { severity?: unknown } | undefined;
  const candidate = String(value?.severity ?? finding.tags.find((tag) => /^(critical|high|medium|low|info)$/i.test(tag)) ?? "info").toLowerCase();
  return candidate in SEVERITY_SCORE ? candidate : "info";
}

export function rankValidationTasks(input: {
  tasks: Task[];
  facts: Fact[];
  consensus: ValidationConsensusResult[];
  paths: AttackPath[];
  feedback?: Record<string, ValidationFeedbackSummary>;
}): RankedValidationTask[] {
  return input.tasks.map((task): RankedValidationTask => {
    const match = CONSENSUS_KEY.exec(task.title);
    if (!match) return { task, score: ORDINARY_SCORE[task.priority], reasons: [`task:${task.priority}`], validation: false };
    const findingId = match[1];
    const finding = input.facts.find((item) => item.id === findingId && item.type === "finding");
    const state = input.consensus.find((item) => item.findingId === findingId);
    if (!finding || !state) return { task, score: 10, reasons: ["validation:orphaned"], validation: true };

    const severity = severityOf(finding);
    const gaps = Number(!finding.observations?.length) + Number(!finding.verificationSummary?.trim()) + Number(!finding.evidenceRefs?.length);
    const strongestPath = input.paths
      .filter((path) => path.status !== "invalidated" && (
        path.findingFactIds.includes(finding.id)
        || (finding.hypothesisIds ?? []).some((id) => path.hypothesisIds.includes(id))))
      .sort((left, right) => right.confidence - left.confidence)[0];
    const pathScore = strongestPath
      ? (strongestPath.status === "validated" ? 15 : strongestPath.status === "exploring" ? 10 : 6) + Math.round(strongestPath.confidence * 5)
      : 0;
    const cost = VERIFICATION_COST[state.status] + Math.min(6, task.triggerWhen.length * 2);
    const feedback = input.feedback?.[finding.id];
    const feedbackAdjustment = feedback?.scoreAdjustment ?? 0;
    const score = Math.max(0, Math.min(100, Math.round(
      PRIORITY_SCORE[task.priority] + 20 + SEVERITY_SCORE[severity] + CONSENSUS_SCORE[state.status] + gaps * 4 + pathScore - cost + feedbackAdjustment,
    )));
    const reasons = [
      `severity:${severity}`,
      `consensus:${state.status}`,
      `evidence-gaps:${gaps}`,
      strongestPath ? `attack-path:${strongestPath.status}` : "attack-path:none",
      `verification-cost:${cost}`,
      `outcome-feedback:${feedbackAdjustment >= 0 ? "+" : ""}${feedbackAdjustment}`,
    ];
    return { task, score, reasons, validation: true };
  }).sort((left, right) => right.score - left.score || left.task.createdAt.localeCompare(right.task.createdAt) || left.task.id.localeCompare(right.task.id));
}

export function formatValidationTaskPriorities(ranked: RankedValidationTask[]): string {
  return ranked.filter((item) => item.validation)
    .map((item) => `${item.task.id}=${item.score} (${item.reasons.join(", ")})`).join("; ");
}
