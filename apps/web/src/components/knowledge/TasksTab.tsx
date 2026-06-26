import { useState } from "react";
import type { Task } from "@traceforge/shared";
import { useStore } from "../../store.js";
import { patchTask } from "../../api.js";

// 人工可手动改的目标状态（status 是封闭状态机，这里只给人最常用的几个收尾/重启动作）
const HUMAN_ACTIONS: { status: Task["status"]; label: string }[] = [
  { status: "done", label: "标记完成" },
  { status: "failed", label: "标记失败" },
  { status: "open", label: "重新打开" },
  { status: "out_of_scope", label: "标记越界" },
];

function TaskRow({ t }: { t: Task }) {
  const [open, setOpen] = useState(false);
  const showToast = useStore((s) => s.showToast);
  const set = async (status: Task["status"]) => {
    try { await patchTask(t.id, status); } // 结果经 WS task_updated 回流刷新
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
          {t.reason && <div className="kv"><span>说明</span>{t.reason}</div>}
          {t.relatedFacts.length > 0 && <div className="kv"><span>关联 Fact</span>{t.relatedFacts.join(", ")}</div>}
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
  if (tasks.length === 0) return <div className="tf-guide"><div className="tf-guide-title">暂无 Task</div><div className="tf-guide-hint">Agent 把待办或挂起（如「等凭据后测后台」）记为 Task。新证据出现时可被重启；你也可点开手动改状态。</div></div>;
  return <>{tasks.map((t) => <TaskRow t={t} key={t.id} />)}</>;
}
