import { Clock, Lightbulb, LockKey } from "@phosphor-icons/react";
import type { Hypothesis, Task, TimelineEntry } from "@traceforge/shared";
import { useStore } from "../../store.js";
import { InspectorShell } from "./EvidenceInspector.js";

function formatTime(iso: string) {
  try {
    return new Date(iso).toLocaleTimeString(undefined, { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return iso;
  }
}

export function getTaskGatePresentation(t: Task, hypotheses: Hypothesis[]) {
  if (!t.relationshipGate) return null;
  const byId = new Map(hypotheses.map((hypothesis) => [hypothesis.id, hypothesis]));
  return {
    blocked: t.relationshipGate.blockedHypothesisIds.map((id) => ({
      id,
      statement: byId.get(id)?.statement ?? "Referenced hypothesis",
    })),
    resumeLabel: t.relationshipGate.resumeStatus
      ? `Returns to ${t.relationshipGate.resumeStatus.replace("_", " ")} when cleared`
      : "Current execution will not be interrupted",
  };
}

export function TaskInspector({ task }: { task: Task }) {
  const close = useStore((state) => state.selectTask);
  const selectFact = useStore((state) => state.selectFact);
  const facts = useStore((state) => state.facts);
  const hypotheses = useStore((state) => state.hypotheses);
  const gate = getTaskGatePresentation(task, hypotheses);
  const related = task.relatedFacts
    .map((id) => facts.find((fact) => fact.id === id))
    .filter((fact): fact is NonNullable<typeof fact> => Boolean(fact));
  return (
    <InspectorShell kicker="Investigation task" title={task.title} icon={<Lightbulb size={15} />} onClose={() => close(null)}>
      <dl className="inspector-meta">
        <div><dt>Status</dt><dd>{task.status}</dd></div>
        <div><dt>Priority</dt><dd>{task.priority}</dd></div>
        <div><dt>Updates</dt><dd>{task.updateCount}</dd></div>
        <div><dt>Task ID</dt><dd><code>{task.id}</code></dd></div>
      </dl>
      {gate && (
        <section className="inspector-data-block" role="status">
          <header><span><LockKey size={11} weight="fill" aria-hidden="true" /> Waiting for hypothesis conditions</span></header>
          <div className="inspector-link-list">
            {gate.blocked.map((hypothesis) => (
              <div className="inspector-gate-hypothesis" key={hypothesis.id}>
                <code>{hypothesis.id}</code>
                <span>{hypothesis.statement}</span>
              </div>
            ))}
          </div>
          <p>{gate.resumeLabel}</p>
        </section>
      )}
      {task.reason && (
        <section className="inspector-data-block"><header><span>Reason</span></header><pre>{task.reason}</pre></section>
      )}
      {task.blockedBy.length > 0 && (
        <dl className="inspector-meta"><div><dt>Blocked by</dt><dd>{task.blockedBy.join(", ")}</dd></div></dl>
      )}
      {related.length > 0 && (
        <section className="inspector-data-block">
          <header><span>Related evidence</span></header>
          <div className="inspector-link-list">
            {related.map((fact) => (
              <button key={fact.id} type="button" className="inspector-link" onClick={() => selectFact(fact.id)}>{fact.title}</button>
            ))}
          </div>
        </section>
      )}
    </InspectorShell>
  );
}

export function TimelineEventInspector({ entry }: { entry: TimelineEntry }) {
  const close = useStore((state) => state.selectTimelineNode);
  return (
    <InspectorShell kicker="Timeline event" title={entry.eventType.replace(/_/g, " ")} icon={<Clock size={15} />} onClose={() => close(null)}>
      <dl className="inspector-meta">
        <div><dt>Time</dt><dd>{formatTime(entry.createdAt)}</dd></div>
        <div><dt>Type</dt><dd>{entry.eventType}</dd></div>
        {entry.refId && <div><dt>Ref</dt><dd><code>{entry.refId}</code></dd></div>}
        <div><dt>Entry ID</dt><dd><code>{entry.id}</code></dd></div>
      </dl>
      <section className="inspector-data-block"><header><span>Detail</span></header><pre>{entry.detail}</pre></section>
    </InspectorShell>
  );
}
