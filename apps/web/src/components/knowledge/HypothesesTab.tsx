import { useState, type CSSProperties } from "react";
import { ArrowSquareOut, CaretDown, CheckCircle, Crosshair, Flask, Prohibit } from "@phosphor-icons/react";
import type { Hypothesis } from "@traceforge/shared";
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

function HypothesisRow({ hypothesis }: { hypothesis: Hypothesis }) {
  const [open, setOpen] = useState(hypothesis.status === "active");
  const navigate = useStore((state) => state.navigateToKnowledge);
  const detailId = `hypothesis-detail-${hypothesis.id}`;
  const score = hypothesis.priorityScore ?? 0;
  return (
    <article className={`tf-row tf-row-expandable hypothesis-row is-${hypothesis.status}`}>
      <button type="button" className="tf-row-head" aria-expanded={open} aria-controls={detailId} onClick={() => setOpen((value) => !value)}>
        <span className="hypothesis-state-icon" aria-hidden="true">
          {hypothesis.status === "active" ? <Crosshair size={13} weight="bold" /> : hypothesis.status === "confirmed" ? <CheckCircle size={13} weight="fill" /> : hypothesis.status === "refuted" ? <Prohibit size={13} /> : <Flask size={13} />}
        </span>
        <span className="hypothesis-row-copy"><strong>{hypothesis.statement}</strong><small><span className={`tf-tag hypothesis-status-${hypothesis.status}`}>{hypothesis.status}</span>{hypothesis.runId ? `Run ${hypothesis.runId.slice(-6)}` : "Project knowledge"}</small></span>
        <span className="hypothesis-score" aria-label={`Priority score ${score}`}><strong>{score}</strong><small>priority</small></span>
        <CaretDown className={`knowledge-caret ${open ? "is-open" : ""}`} size={14} aria-hidden="true" />
      </button>
      {open && (
        <div className="tf-row-detail hypothesis-detail" id={detailId}>
          {hypothesis.scoreFactors && <div className="hypothesis-factors" aria-label="Priority score factors">
            {FACTOR_LABELS.map(([key, label]) => <span key={key}><small>{label}</small><strong>{hypothesis.scoreFactors?.[key]}</strong><i style={{ "--factor-value": `${hypothesis.scoreFactors?.[key] ?? 0}%` } as CSSProperties} /></span>)}
          </div>}
          <div className="hypothesis-links">
            <div><span>Evidence</span>{hypothesis.basedOnFactIds.length ? hypothesis.basedOnFactIds.map((id) => <button type="button" key={id} onClick={() => navigate({ kind: "finding", id })}>{id}<ArrowSquareOut size={11} /></button>) : <em>None</em>}</div>
            <div><span>Tasks</span>{hypothesis.relatedTaskIds.length ? hypothesis.relatedTaskIds.map((id) => <button type="button" key={id} onClick={() => navigate({ kind: "task", id })}>{id}<ArrowSquareOut size={11} /></button>) : <em>None</em>}</div>
          </div>
          <footer><code>{hypothesis.id}</code><time dateTime={hypothesis.updatedAt}>Updated {new Date(hypothesis.updatedAt).toLocaleString()}</time></footer>
        </div>
      )}
    </article>
  );
}

export function HypothesesTab() {
  const hypotheses = useStore((state) => state.hypotheses);
  const ranked = rankHypotheses(hypotheses);
  const window = useKnowledgeWindow(ranked.length);
  const active = hypotheses.filter((item) => item.status === "active").length;
  const candidates = hypotheses.filter((item) => item.status === "candidate").length;
  if (hypotheses.length === 0) return <FeedbackState title="No hypotheses yet" description="The Agent will record evidence-backed attack ideas here, then promote the strongest candidates for active verification." />;
  return <>
    <div className="hypothesis-pool-summary" aria-label="Hypothesis pool status">
      <span><strong>{active}</strong> active <small>of 5</small></span>
      <span><strong>{candidates}</strong> candidates</span>
      <span><strong>{hypotheses.length}</strong> total <small>of 30</small></span>
    </div>
    {ranked.slice(0, window.count).map((hypothesis) => <HypothesisRow hypothesis={hypothesis} key={hypothesis.id} />)}
    <KnowledgeWindowFooter visible={window.count} total={ranked.length} onShowMore={window.showMore} />
  </>;
}
