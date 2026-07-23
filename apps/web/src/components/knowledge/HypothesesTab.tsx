import { useEffect, useState, type CSSProperties } from "react";
import { ArrowDown, ArrowSquareOut, ArrowUp, CaretDown, CheckCircle, Crosshair, Flask, HourglassMedium, Lightning, LockKey, Prohibit } from "@phosphor-icons/react";
import {
  HYPOTHESIS_ACTIVATION_MARGIN,
  HYPOTHESIS_MIN_RESIDENCY_MS,
  getAdaptiveHypothesisCapacity,
  hypothesisActivationStartedAt,
  isFastTrackHypothesis,
  type Hypothesis,
  type Task,
} from "@traceforge/shared";
import { useStore } from "../../store.js";
import { FeedbackState } from "../ui/feedback-state.js";
import { KnowledgeWindowFooter, useKnowledgeWindow } from "./knowledge-window.js";

type HypothesisGroup = "active" | "candidate" | "resolved";

export function hypothesisGroup(hypothesis: Hypothesis): HypothesisGroup {
  if (hypothesis.status === "active") return "active";
  if (hypothesis.status === "candidate") return "candidate";
  return "resolved";
}

export function rankHypotheses(hypotheses: Hypothesis[]): Hypothesis[] {
  const groupOrder: Record<HypothesisGroup, number> = { active: 0, candidate: 1, resolved: 2 };
  return [...hypotheses].sort((left, right) =>
    groupOrder[hypothesisGroup(left)] - groupOrder[hypothesisGroup(right)]
    || (right.priorityScore ?? 0) - (left.priorityScore ?? 0)
    || right.updatedAt.localeCompare(left.updatedAt));
}

const FACTOR_LABELS: Array<[keyof NonNullable<Hypothesis["scoreFactors"]>, string]> = [
  ["impact", "Impact"],
  ["evidenceStrength", "Evidence"],
  ["pathRelevance", "Path"],
  ["freshness", "Freshness"],
  ["verificationCost", "Cost"],
  ["operationRisk", "Risk"],
];

export interface HypothesisScheduleState {
  kind: "protected" | "replaceable" | "fast-track" | "vacancy" | "waiting" | "resolved";
  label: string;
  detail: string;
  boundaryScore: number | null;
  pointsNeeded: number;
  residencyRemainingMs: number;
  capacity: number;
  capacityReason: string;
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function getHypothesisScheduleState(hypothesis: Hypothesis, pool: Hypothesis[], tasks: Task[], now: number): HypothesisScheduleState {
  const runPool = pool.filter((item) => (item.runId ?? null) === (hypothesis.runId ?? null));
  const capacityDecision = getAdaptiveHypothesisCapacity(runPool, tasks, hypothesis.runId);
  if (hypothesis.status !== "active" && hypothesis.status !== "candidate") {
    return {
      kind: "resolved", label: "Resolved", detail: "No longer participates in active scheduling.",
      boundaryScore: null, pointsNeeded: 0, residencyRemainingMs: 0,
      capacity: capacityDecision.capacity, capacityReason: capacityDecision.reason,
    };
  }
  const active = runPool.filter((item) => item.status === "active");
  const boundaryScore = active.length ? Math.min(...active.map((item) => item.priorityScore ?? 0)) : null;
  if (hypothesis.status === "active") {
    const startedAt = hypothesisActivationStartedAt(hypothesis);
    const remaining = startedAt === null ? 0 : Math.max(0, HYPOTHESIS_MIN_RESIDENCY_MS - (now - startedAt));
    return remaining > 0
      ? { kind: "protected", label: `Protected ${formatDuration(remaining)}`, detail: "Minimum active residency prevents premature replacement while verification starts.", boundaryScore, pointsNeeded: 0, residencyRemainingMs: remaining, capacity: capacityDecision.capacity, capacityReason: capacityDecision.reason }
      : { kind: "replaceable", label: "Active · open", detail: `May be replaced by a candidate that clears the ${HYPOTHESIS_ACTIVATION_MARGIN}-point margin.`, boundaryScore, pointsNeeded: 0, residencyRemainingMs: 0, capacity: capacityDecision.capacity, capacityReason: capacityDecision.reason };
  }
  if (isFastTrackHypothesis(hypothesis)) {
    return { kind: "fast-track", label: "Fast-track ready", detail: "Strong evidence and high impact or path relevance allow immediate promotion.", boundaryScore, pointsNeeded: 0, residencyRemainingMs: 0, capacity: capacityDecision.capacity, capacityReason: capacityDecision.reason };
  }
  if (active.length < capacityDecision.capacity) {
    return { kind: "vacancy", label: "Slot available", detail: "Eligible for promotion at the next scheduler pass.", boundaryScore, pointsNeeded: 0, residencyRemainingMs: 0, capacity: capacityDecision.capacity, capacityReason: capacityDecision.reason };
  }
  const activationScore = (boundaryScore ?? 0) + HYPOTHESIS_ACTIVATION_MARGIN;
  const pointsNeeded = Math.max(0, activationScore - (hypothesis.priorityScore ?? 0));
  const allIncumbentsProtected = active.every((item) => {
    const startedAt = hypothesisActivationStartedAt(item);
    return startedAt !== null && now - startedAt < HYPOTHESIS_MIN_RESIDENCY_MS;
  });
  return {
    kind: "waiting",
    label: pointsNeeded > 0 ? `Needs +${pointsNeeded}` : "Margin cleared",
    detail: pointsNeeded > 0
      ? `Needs ${pointsNeeded} more priority points to clear the activation boundary at ${activationScore}.`
      : allIncumbentsProtected
        ? "Score margin is clear; promotion waits for an incumbent residency lock to expire."
        : "Score margin is clear and the hypothesis is eligible at the next scheduler pass.",
    boundaryScore,
    pointsNeeded,
    residencyRemainingMs: 0,
    capacity: capacityDecision.capacity,
    capacityReason: capacityDecision.reason,
  };
}

function ScheduleSignal({ state }: { state: HypothesisScheduleState }) {
  if (state.kind === "resolved") return null;
  const icon = state.kind === "protected"
    ? <LockKey size={11} weight="fill" />
    : state.kind === "fast-track"
      ? <Lightning size={11} weight="fill" />
      : state.kind === "waiting"
        ? <HourglassMedium size={11} />
        : <Crosshair size={11} />;
  return <span className={`hypothesis-schedule-signal is-${state.kind}`} title={state.detail}>{icon}<span>{state.label}</span></span>;
}

function HypothesisRow({ hypothesis, pool, tasks, now }: { hypothesis: Hypothesis; pool: Hypothesis[]; tasks: Task[]; now: number }) {
  const [open, setOpen] = useState(hypothesis.status === "active");
  const navigate = useStore((state) => state.navigateToKnowledge);
  const detailId = `hypothesis-detail-${hypothesis.id}`;
  const score = hypothesis.priorityScore ?? 0;
  const schedule = getHypothesisScheduleState(hypothesis, pool, tasks, now);
  return (
    <article className={`tf-row tf-row-expandable hypothesis-row is-${hypothesis.status}`}>
      <button type="button" className="tf-row-head" aria-expanded={open} aria-controls={detailId} onClick={() => setOpen((value) => !value)}>
        <span className="hypothesis-state-icon" aria-hidden="true">
          {hypothesis.status === "active" ? <Crosshair size={13} weight="bold" /> : hypothesis.status === "confirmed" ? <CheckCircle size={13} weight="fill" /> : hypothesis.status === "refuted" ? <Prohibit size={13} /> : <Flask size={13} />}
        </span>
        <span className="hypothesis-row-copy"><strong>{hypothesis.statement}</strong><small><span className={`tf-tag hypothesis-status-${hypothesis.status}`}>{hypothesis.status}</span>{hypothesis.runId ? `Run ${hypothesis.runId.slice(-6)}` : "Project knowledge"}<ScheduleSignal state={schedule} /></small></span>
        <span className="hypothesis-score" aria-label={`Priority score ${score}`}><strong>{score}</strong><small>priority</small></span>
        <CaretDown className={`knowledge-caret ${open ? "is-open" : ""}`} size={14} aria-hidden="true" />
      </button>
      {open && (
        <div className="tf-row-detail hypothesis-detail" id={detailId}>
          <section className={`hypothesis-scheduling is-${schedule.kind}`} aria-label="Scheduling decision">
            <header><span>{schedule.kind === "fast-track" ? <Lightning size={13} weight="fill" /> : schedule.kind === "protected" ? <LockKey size={13} weight="fill" /> : <Crosshair size={13} />} Scheduling</span><strong>{schedule.label}</strong></header>
            <p>{schedule.detail}</p>
            <small className="hypothesis-capacity-note">{schedule.capacityReason}</small>
            {schedule.boundaryScore !== null && <div className="hypothesis-boundary">
              <span>score <strong>{score}</strong></span>
              <i aria-hidden="true"><b style={{ "--hypothesis-score": `${score}%`, "--hypothesis-boundary": `${Math.min(100, schedule.boundaryScore + HYPOTHESIS_ACTIVATION_MARGIN)}%` } as CSSProperties} /></i>
              <span>activation <strong>{schedule.boundaryScore + HYPOTHESIS_ACTIVATION_MARGIN}</strong></span>
            </div>}
          </section>
          {hypothesis.scoreFactors && <div className="hypothesis-factors" aria-label="Priority score factors">
            {FACTOR_LABELS.map(([key, label]) => <span key={key}><small>{label}</small><strong>{hypothesis.scoreFactors?.[key]}</strong><i style={{ "--factor-value": `${hypothesis.scoreFactors?.[key] ?? 0}%` } as CSSProperties} /></span>)}
          </div>}
          <div className="hypothesis-links">
            <div><span>Evidence</span>{hypothesis.basedOnFactIds.length ? hypothesis.basedOnFactIds.map((id) => <button type="button" key={id} onClick={() => navigate({ kind: "finding", id })}>{id}<ArrowSquareOut size={11} /></button>) : <em>None</em>}</div>
            <div><span>Tasks</span>{hypothesis.relatedTaskIds.length ? hypothesis.relatedTaskIds.map((id) => <button type="button" key={id} onClick={() => navigate({ kind: "task", id })}>{id}<ArrowSquareOut size={11} /></button>) : <em>None</em>}</div>
          </div>
          <section className="hypothesis-audit" aria-label="Hypothesis history">
            <h4>Decision history <span>{hypothesis.auditTrail.length}</span></h4>
            {[...hypothesis.auditTrail].reverse().map((transition) => (
              <div className={`hypothesis-audit-entry is-${transition.kind}`} key={transition.id}>
                <span aria-hidden="true">{transition.kind === "promoted" ? <ArrowUp size={11} /> : transition.kind === "demoted" ? <ArrowDown size={11} /> : <i />}</span>
                <div>
                  <strong>{transition.kind}</strong>
                  <p>{transition.reason}</p>
                  <small>
                    {transition.previousScore !== transition.nextScore && `${transition.previousScore ?? "—"} → ${transition.nextScore ?? "—"} · `}
                    {new Date(transition.createdAt).toLocaleString()}
                  </small>
                  {transition.evidenceFactIds.length > 0 && <aside>{transition.evidenceFactIds.map((id) => <button type="button" key={id} onClick={() => navigate({ kind: "finding", id })}>{id}<ArrowSquareOut size={10} /></button>)}</aside>}
                </div>
              </div>
            ))}
          </section>
          <footer><code>{hypothesis.id}</code><time dateTime={hypothesis.updatedAt}>Updated {new Date(hypothesis.updatedAt).toLocaleString()}</time></footer>
        </div>
      )}
    </article>
  );
}

export function HypothesesTab() {
  const hypotheses = useStore((state) => state.hypotheses);
  const tasks = useStore((state) => state.tasks);
  const activeRunId = useStore((state) => state.activeRun?.id ?? null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!hypotheses.some((item) => item.status === "active" && (hypothesisActivationStartedAt(item) ?? 0) + HYPOTHESIS_MIN_RESIDENCY_MS > Date.now())) return;
    const interval = globalThis.setInterval(() => setNow(Date.now()), 1_000);
    return () => globalThis.clearInterval(interval);
  }, [hypotheses]);
  const ranked = rankHypotheses(hypotheses);
  const knowledgeWindow = useKnowledgeWindow(ranked.length);
  const schedulingRunId = activeRunId ?? ranked.find((item) => item.status === "active" || item.status === "candidate")?.runId ?? null;
  const runPool = hypotheses.filter((item) => (item.runId ?? null) === schedulingRunId);
  const capacityDecision = getAdaptiveHypothesisCapacity(runPool, tasks, schedulingRunId);
  const active = runPool.filter((item) => item.status === "active").length;
  const candidates = runPool.filter((item) => item.status === "candidate").length;
  if (hypotheses.length === 0) return <FeedbackState title="No hypotheses yet" description="The Agent will record evidence-backed attack ideas here, then promote the strongest candidates for active verification." />;
  return <>
    <div className="hypothesis-pool-summary" aria-label="Hypothesis pool status">
      <span title={capacityDecision.reason}><strong>{active}</strong> active <small>of {capacityDecision.capacity}</small></span>
      <span><strong>{candidates}</strong> candidates</span>
      <span><strong>{hypotheses.length}</strong> total <small>of 30</small></span>
    </div>
    {ranked.slice(0, knowledgeWindow.count).map((hypothesis) => <HypothesisRow hypothesis={hypothesis} pool={hypotheses} tasks={tasks} now={now} key={hypothesis.id} />)}
    <KnowledgeWindowFooter visible={knowledgeWindow.count} total={ranked.length} onShowMore={knowledgeWindow.showMore} />
  </>;
}
