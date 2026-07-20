import type { AttackPath, AttackPathStep, Hypothesis, Task } from "@traceforge/shared";
import { keywordScore } from "@traceforge/reasoning-core";

export interface AttackPathCandidate {
  pathId: string;
  pathTitle: string;
  breakpoint: string;
  nextStepId: string | null;
  nextAction: string;
  score: number;
  evidenceGain: number;
  verificationCost: number;
  operationRisk: number;
  reasons: string[];
}

const COST_BY_KIND: Record<AttackPathStep["kind"], number> = {
  access: 25,
  identity_transition: 35,
  request: 20,
  exploit: 75,
  privilege: 65,
  pivot: 55,
  impact: 70,
};

const RISK_BY_KIND: Record<AttackPathStep["kind"], number> = {
  access: 20,
  identity_transition: 30,
  request: 15,
  exploit: 75,
  privilege: 65,
  pivot: 50,
  impact: 80,
};

const EVIDENCE_BY_STATUS: Record<AttackPathStep["status"], number> = {
  proposed: 90,
  observed: 65,
  verified: 0,
  blocked: 75,
  refuted: 0,
};

const clamp = (value: number): number => Math.max(0, Math.min(100, Math.round(value)));

export function rankAttackPathBreakpoints(input: {
  paths: AttackPath[];
  hypotheses: Hypothesis[];
  tasks: Task[];
  goal: string;
}): AttackPathCandidate[] {
  const hypotheses = new Map(input.hypotheses.map((item) => [item.id, item]));
  const tasks = new Map(input.tasks.map((item) => [item.id, item]));

  return input.paths
    .filter((path) => path.status !== "validated" && path.status !== "invalidated")
    .flatMap((path): AttackPathCandidate[] => {
      const nextStep = [...path.steps]
        .sort((left, right) => left.order - right.order)
        .find((step) => step.status !== "verified" && step.status !== "refuted");
      if (!nextStep && !path.breakpoint) return [];

      const kind = nextStep?.kind ?? "request";
      const evidenceGain = nextStep ? EVIDENCE_BY_STATUS[nextStep.status] : 60;
      const verificationCost = COST_BY_KIND[kind] + (nextStep?.actionId ? -10 : 0);
      const operationRisk = RISK_BY_KIND[kind];
      const linkedHypothesisScore = path.hypothesisIds.length
        ? Math.max(...path.hypothesisIds.map((id) => hypotheses.get(id)?.priorityScore ?? 40))
        : 35;
      const pathText = `${path.title} ${path.objective} ${path.breakpoint ?? ""} ${nextStep?.title ?? ""} ${nextStep?.description ?? ""}`;
      const goalRelevance = clamp(keywordScore(input.goal, pathText) * 8);
      const linkedTask = nextStep?.taskId ? tasks.get(nextStep.taskId) : undefined;
      const readiness = linkedTask
        ? (["open", "approved", "running", "recheck_candidate"].includes(linkedTask.status) ? 100 : 35)
        : 55;
      const score = clamp(
        evidenceGain * 0.3
        + linkedHypothesisScore * 0.2
        + path.confidence * 100 * 0.15
        + goalRelevance * 0.15
        + (100 - verificationCost) * 0.08
        + (100 - operationRisk) * 0.07
        + readiness * 0.05,
      );
      const breakpoint = path.breakpoint || nextStep?.validation || `Verify step: ${nextStep?.title ?? path.title}`;
      const nextAction = linkedTask
        ? `Continue task ${linkedTask.id}: ${linkedTask.title}`
        : nextStep
          ? `${nextStep.status === "blocked" ? "Unblock" : "Verify"} step ${nextStep.id}: ${nextStep.title}`
          : `Resolve breakpoint: ${breakpoint}`;
      return [{
        pathId: path.id,
        pathTitle: path.title,
        breakpoint,
        nextStepId: nextStep?.id ?? null,
        nextAction,
        score,
        evidenceGain,
        verificationCost: clamp(verificationCost),
        operationRisk,
        reasons: [
          `evidence gain ${evidenceGain}`,
          `path confidence ${Math.round(path.confidence * 100)}`,
          `hypothesis relevance ${linkedHypothesisScore}`,
          `cost ${clamp(verificationCost)}`,
          `risk ${operationRisk}`,
        ],
      }];
    })
    .sort((left, right) => right.score - left.score || left.pathId.localeCompare(right.pathId));
}

export function formatAttackPathPlan(candidates: AttackPathCandidate[], limit = 3): string {
  if (!candidates.length) {
    return "No actionable persisted attack-path breakpoint. Continue open hypothesis discovery and record a path when evidence supports one.";
  }
  return [
    "Ranked attack-path breakpoints (guidance, not a closed scope):",
    ...candidates.slice(0, limit).map((candidate, index) =>
      `${index + 1}. ${candidate.pathId} score=${candidate.score} — ${candidate.breakpoint}; next=${candidate.nextAction}; evidence=${candidate.evidenceGain}, cost=${candidate.verificationCost}, risk=${candidate.operationRisk}`),
    "Prefer the highest evidence-gain breakpoint when it serves the current goal. You may pursue a new path hypothesis when new evidence indicates a better direction; record the pivot explicitly.",
  ].join("\n");
}
