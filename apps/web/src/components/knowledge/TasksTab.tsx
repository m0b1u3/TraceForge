import { useStore } from "../../store.js";
export function TasksTab() {
  const tasks = useStore((s) => s.tasks);
  if (tasks.length === 0) return <div className="tf-empty">暂无 Task。</div>;
  return <>{tasks.map((t) => <div className="tf-row" key={t.id}><span className="tf-tag">{t.status}</span>{t.title}</div>)}</>;
}
