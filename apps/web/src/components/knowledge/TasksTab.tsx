import { useEffect, useRef, useState } from "react";
import { CaretDown, CircleNotch, LockKey, ArrowBendDownRight } from "@phosphor-icons/react";
import type { Hypothesis, Task } from "@traceforge/shared";
import { useStore } from "../../store.js";
import { patchTask } from "../../api.js";
import { FeedbackState } from "../ui/feedback-state.js";
import { KnowledgeWindowFooter, useKnowledgeWindow } from "./knowledge-window.js";
import { ValidationWorkflow } from "./ValidationWorkflow.js";

// Human-editable target statuses (status is a closed state machine; these are the most common wrap-up/reopen actions)
const HUMAN_ACTIONS: { status: Task["status"]; label: string }[] = [
  { status: "done", label: "Complete" },
  { status: "failed", label: "Fail" },
  { status: "open", label: "Reopen" },
  { status: "out_of_scope", label: "Out of scope" },
];

const TARGET_FEEDBACK_MS = 900;

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

function TaskRow({ t, hypotheses, targetRequestId, onFocusHandled }: { t: Task; hypotheses: Hypothesis[]; targetRequestId: number | null; onFocusHandled: (requestId: number) => void }) {
  const [open, setOpen] = useState(false);
  const rowRef = useRef<HTMLElement>(null);
  const [busy, setBusy] = useState<Task["status"] | null>(null);
  const showToast = useStore((s) => s.showToast);
  const upsertTask = useStore((s) => s.upsertTask);
  const set = async (status: Task["status"]) => {
    if (busy) return;
    setBusy(status);
    try {
      const updated = await patchTask(t.id, status);
      upsertTask(updated);
    } catch (e) {
      showToast((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const detailId = `task-detail-${t.id}`;
  useEffect(() => {
    if (targetRequestId === null) return;
    setOpen(true);
    rowRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    rowRef.current?.focus({ preventScroll: true });
    const timer = globalThis.setTimeout(() => onFocusHandled(targetRequestId), TARGET_FEEDBACK_MS);
    return () => globalThis.clearTimeout(timer);
  }, [onFocusHandled, targetRequestId]);
  const focused = targetRequestId !== null;
  const gate = getTaskGatePresentation(t, hypotheses);
  return (
    <article ref={rowRef} tabIndex={-1} aria-current={focused ? "location" : undefined} className={`tf-row tf-row-expandable knowledge-row${focused ? " is-targeted" : ""}${gate ? " is-relationship-gated" : ""}`}>
      <button className="tf-row-head" type="button" aria-expanded={open} aria-controls={detailId} onClick={() => setOpen((v) => !v)}>
        <span className={`tf-tag tf-status-${t.status}`}>{t.status}</span>
        <span className="tf-row-title">
          {t.title}
          {gate && <span className="task-gate-inline"><LockKey size={11} weight="fill" aria-hidden="true" />Relationship gate</span>}
        </span>
        <span className={`tf-prio tf-prio-${t.priority}`}>{t.priority}</span>
        <CaretDown className={`knowledge-caret ${open ? "is-open" : ""}`} size={14} aria-hidden="true" />
      </button>
      {open && (
        <div className="tf-row-detail" id={detailId}>
          {gate && (
            <div className="task-relationship-gate" role="status">
              <div className="task-gate-heading">
                <LockKey size={15} weight="duotone" aria-hidden="true" />
                <span>Waiting for hypothesis conditions</span>
              </div>
              <div className="task-gate-list">
                {gate.blocked.map((hypothesis) => (
                  <div className="task-gate-hypothesis" key={hypothesis.id}>
                    <code>{hypothesis.id}</code>
                    <span>{hypothesis.statement}</span>
                  </div>
                ))}
              </div>
              <div className="task-gate-resume"><ArrowBendDownRight size={13} aria-hidden="true" />{gate.resumeLabel}</div>
            </div>
          )}
          {t.reason && <div className="kv"><span>Reason</span>{t.reason}</div>}
          {t.relatedFacts.length > 0 && <div className="kv"><span>Related facts</span>{t.relatedFacts.join(", ")}</div>}
          <div className="tf-row-actions">
            {HUMAN_ACTIONS.filter((a) => a.status !== t.status).map((a) => (
              <button type="button" key={a.status} className="tf-btn tf-btn-ghost" disabled={busy !== null || (a.status === "open" && gate !== null)} title={a.status === "open" && gate ? "This task reopens automatically when its hypothesis conditions clear." : undefined} onClick={() => set(a.status)}>
                {busy === a.status && <CircleNotch size={13} className="tf-spin" />}{a.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </article>
  );
}

export function TasksTab() {
  const tasks = useStore((s) => s.tasks);
  const hypotheses = useStore((s) => s.hypotheses);
  const navigateToKnowledge = useStore((s) => s.navigateToKnowledge);
  const knowledgeTarget = useStore((s) => s.knowledgeTarget);
  const clearKnowledgeTarget = useStore((s) => s.clearKnowledgeTarget);
  const window = useKnowledgeWindow(tasks.length);
  useEffect(() => {
    if (knowledgeTarget?.kind !== "task") return;
    const targetIndex = tasks.findIndex((task) => task.id === knowledgeTarget.id);
    if (targetIndex >= 0) window.reveal(targetIndex);
  }, [knowledgeTarget, tasks, window]);
  return (
    <>
      <ValidationWorkflow onNavigate={navigateToKnowledge} />
      {tasks.length === 0 && <FeedbackState title="No tasks yet" description="Agent todos and blocked work will appear here. New evidence can reopen completed tasks." />}
      {tasks.slice(0, window.count).map((t) => <TaskRow t={t} hypotheses={hypotheses} key={t.id} targetRequestId={knowledgeTarget?.kind === "task" && knowledgeTarget.id === t.id ? knowledgeTarget.requestId : null} onFocusHandled={clearKnowledgeTarget} />)}
      <KnowledgeWindowFooter visible={window.count} total={tasks.length} onShowMore={window.showMore} />
    </>
  );
}
