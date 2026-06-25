import { useStore } from "../../store.js";
export function TimelineTab() {
  const timeline = useStore((s) => s.timeline);
  if (timeline.length === 0) return <div className="tf-empty">暂无 Timeline 事件。</div>;
  return <>{timeline.map((e) => <div className="tf-row" key={e.id}><span className="tf-tag">{e.eventType}</span>{e.detail}</div>)}</>;
}
