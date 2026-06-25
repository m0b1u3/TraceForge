import { useStore } from "../../store.js";
export function TasksTab() {
  const tasks = useStore((s) => s.tasks);
  if (tasks.length === 0) return <div className="tf-guide"><div className="tf-guide-title">暂无 Task</div><div className="tf-guide-hint">Agent 把待办或挂起（如「等凭据后测后台」）记为 Task。新证据出现时可被重启。</div></div>;
  return <>{tasks.map((t) => <div className="tf-row" key={t.id}><span className="tf-tag">{t.status}</span>{t.title}</div>)}</>;
}
