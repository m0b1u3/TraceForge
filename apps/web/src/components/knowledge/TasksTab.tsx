import { useState } from "react";
import type { Task } from "@traceforge/shared";
import { useStore } from "../../store.js";
import { patchTask } from "../../api.js";

// Human-editable target statuses (status is a closed state machine; these are the most common wrap-up/reopen actions)
const HUMAN_ACTIONS: { status: Task["status"]; label: string }[] = [
  { status: "done", label: "Complete" },
  { status: "failed", label: "Fail" },
  { status: "open", label: "Reopen" },
  { status: "out_of_scope", label: "Out of scope" },
];

function TaskRow({ t }: { t: Task }) {
  const [open, setOpen] = useState(false);
  const showToast = useStore((s) => s.showToast);
  const set = async (status: Task["status"]) => {
    try { await patchTask(t.id, status); } // result flows back via WS task_updated
    catch (e) { showToast((e as Error).message); }
  };
  return (
    <div className="tf-row tf-row-expandable">
      <div className="tf-row-head" onClick={() => setOpen((v) => !v)}>
        <span className={`tf-tag tf-status-${t.status}`}>{t.status}</span>
        <span className="tf-row-title">{t.title}</span>
        <span className={`tf-prio tf-prio-${t.priority}`}>{t.priority}</span>
      </div>
      {open && (
        <div className="tf-row-detail">
          {t.reason && <div className="kv"><span>Reason</span>{t.reason}</div>}
          {t.relatedFacts.length > 0 && <div className="kv"><span>Related facts</span>{t.relatedFacts.join(", ")}</div>}
          <div className="tf-row-actions">
            {HUMAN_ACTIONS.filter((a) => a.status !== t.status).map((a) => (
              <button key={a.status} className="tf-btn tf-btn-ghost" onClick={() => set(a.status)}>{a.label}</button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function TasksTab() {
  const tasks = useStore((s) => s.tasks);
  if (tasks.length === 0) return <div className="tf-guide"><div className="tf-guide-title">No tasks yet.</div><div className="tf-guide-hint">Agent records todos or blocked items (e.g. "wait for credentials, then test admin panel") as Tasks. New evidence can reopen them; you can also change status manually.</div></div>;
  return <>{tasks.map((t) => <TaskRow t={t} key={t.id} />)}</>;
}
