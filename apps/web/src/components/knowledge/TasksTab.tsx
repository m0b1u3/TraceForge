import { useState } from "react";
import { CaretDown, CircleNotch } from "@phosphor-icons/react";
import type { Task } from "@traceforge/shared";
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

function TaskRow({ t }: { t: Task }) {
  const [open, setOpen] = useState(false);
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
  return (
    <article className="tf-row tf-row-expandable knowledge-row">
      <button className="tf-row-head" type="button" aria-expanded={open} aria-controls={detailId} onClick={() => setOpen((v) => !v)}>
        <span className={`tf-tag tf-status-${t.status}`}>{t.status}</span>
        <span className="tf-row-title">{t.title}</span>
        <span className={`tf-prio tf-prio-${t.priority}`}>{t.priority}</span>
        <CaretDown className={`knowledge-caret ${open ? "is-open" : ""}`} size={14} aria-hidden="true" />
      </button>
      {open && (
        <div className="tf-row-detail" id={detailId}>
          {t.reason && <div className="kv"><span>Reason</span>{t.reason}</div>}
          {t.relatedFacts.length > 0 && <div className="kv"><span>Related facts</span>{t.relatedFacts.join(", ")}</div>}
          <div className="tf-row-actions">
            {HUMAN_ACTIONS.filter((a) => a.status !== t.status).map((a) => (
              <button type="button" key={a.status} className="tf-btn tf-btn-ghost" disabled={busy !== null} onClick={() => set(a.status)}>
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
  const window = useKnowledgeWindow(tasks.length);
  return (
    <>
      <ValidationWorkflow />
      {tasks.length === 0 && <FeedbackState title="No tasks yet" description="Agent todos and blocked work will appear here. New evidence can reopen completed tasks." />}
      {tasks.slice(0, window.count).map((t) => <TaskRow t={t} key={t.id} />)}
      <KnowledgeWindowFooter visible={window.count} total={tasks.length} onShowMore={window.showMore} />
    </>
  );
}
