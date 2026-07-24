import type { Hypothesis, Task } from "./schemas.js";

export const MAX_ACTIVE_HYPOTHESES = 1;
export const HYPOTHESIS_ACTIVATION_MARGIN = 8;
export const HYPOTHESIS_MIN_RESIDENCY_MS = 2 * 60 * 1000;
export const HYPOTHESIS_FAST_TRACK_SCORE = 88;
export const MIN_ACTIVE_HYPOTHESES = 1;

const ACTIONABLE_TASK_STATUSES = new Set<Task["status"]>(["open", "recheck_candidate", "approved", "running"]);

export interface HypothesisCapacityDecision {
  capacity: number;
  demand: number;
  matureHypotheses: number;
  taskBackedHypotheses: number;
  runningTasks: number;
  highRiskHypotheses: number;
  reason: string;
}

export interface HypothesisRelationshipDecision {
  activationAllowed: boolean;
  prerequisiteBlockers: string[];
  activeConflicts: string[];
  supportBonus: number;
  supportingIds: string[];
  confirmedDerivedFromIds: string[];
}

export function isFastTrackHypothesis(hypothesis: Hypothesis): boolean {
  const factors = hypothesis.scoreFactors;
  if (!factors || (hypothesis.priorityScore ?? 0) < HYPOTHESIS_FAST_TRACK_SCORE) return false;
  return factors.evidenceStrength >= 85
    && (factors.impact >= 85 || factors.pathRelevance >= 85);
}

export function hypothesisActivationStartedAt(hypothesis: Hypothesis): number | null {
  const transition = [...hypothesis.auditTrail].reverse().find((entry) =>
    entry.kind === "promoted" || (entry.kind === "created" && entry.toStatus === "active"));
  if (!transition) return null;
  const timestamp = Date.parse(transition.createdAt);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function getAdaptiveHypothesisCapacity(
  hypotheses: Hypothesis[],
  tasks: Task[],
  runId: string | null | undefined,
): HypothesisCapacityDecision {
  const eligible = hypotheses.filter((item) =>
    (item.runId ?? null) === (runId ?? null) && (item.status === "candidate" || item.status === "active"));
  const runTasks = tasks.filter((task) => (task.runId ?? null) === (runId ?? null));
  const actionableTasks = runTasks.filter((task) => ACTIONABLE_TASK_STATUSES.has(task.status));
  const eligibleIds = new Set(eligible.map((item) => item.id));
  const taskBackedIds = new Set(actionableTasks.flatMap((task) => task.hypothesisIds ?? []).filter((id) => eligibleIds.has(id)));
  const mature = eligible.filter((item) =>
    isFastTrackHypothesis(item)
    || ((item.priorityScore ?? 0) >= 65 && (item.scoreFactors?.evidenceStrength ?? 0) >= 60));
  const supportedIds = new Set([...mature.map((item) => item.id), ...taskBackedIds]);
  const demand = Math.max(MIN_ACTIVE_HYPOTHESES, Math.min(MAX_ACTIVE_HYPOTHESES, supportedIds.size));
  const runningTasks = runTasks.filter((task) => task.status === "running").length;
  const highRiskHypotheses = eligible.filter((item) =>
    (item.priorityScore ?? 0) >= 65 && (item.scoreFactors?.operationRisk ?? 0) >= 75).length;
  const capacity = 1;
  const pressures = [
    runningTasks > 0 ? `${runningTasks} running task${runningTasks === 1 ? "" : "s"}` : null,
    highRiskHypotheses > 0 ? `${highRiskHypotheses} high-risk hypothes${highRiskHypotheses === 1 ? "is" : "es"}` : null,
  ].filter((value): value is string => value !== null);
  return {
    capacity,
    demand,
    matureHypotheses: mature.length,
    taskBackedHypotheses: taskBackedIds.size,
    runningTasks,
    highRiskHypotheses,
    reason: pressures.length
      ? `Serial verification slot ${capacity}/${MAX_ACTIVE_HYPOTHESES}: ${pressures.join(" and ")}; queued hypotheses wait for the current task boundary.`
      : `Serial verification slot ${capacity}/${MAX_ACTIVE_HYPOTHESES}: ${supportedIds.size} evidence- or task-supported hypotheses queued by priority.`,
  };
}

export function getHypothesisRelationshipDecision(
  hypothesis: Hypothesis,
  pool: Hypothesis[],
  selectedActiveIds: Iterable<string> = [],
): HypothesisRelationshipDecision {
  const byId = new Map(pool.map((item) => [item.id, item]));
  const selected = new Set(selectedActiveIds);
  const relations = hypothesis.relations ?? { prerequisiteIds: [], conflictIds: [], supportIds: [], derivedFromIds: [] };
  const prerequisiteBlockers = relations.prerequisiteIds.filter((id) => byId.get(id)?.status !== "confirmed");
  const conflictIds = new Set([
    ...relations.conflictIds,
    ...pool.filter((item) => item.relations?.conflictIds.includes(hypothesis.id)).map((item) => item.id),
  ]);
  const activeConflicts = [...conflictIds].filter((id) => selected.has(id));
  const supportingIds = pool
    .filter((item) => item.relations?.supportIds.includes(hypothesis.id) && (item.status === "active" || item.status === "confirmed"))
    .map((item) => item.id);
  const confirmedDerivedFromIds = relations.derivedFromIds.filter((id) => byId.get(id)?.status === "confirmed");
  const supportBonus = Math.min(10, supportingIds.length * 3 + confirmedDerivedFromIds.length * 2);
  return {
    activationAllowed: prerequisiteBlockers.length === 0 && activeConflicts.length === 0,
    prerequisiteBlockers,
    activeConflicts,
    supportBonus,
    supportingIds,
    confirmedDerivedFromIds,
  };
}
