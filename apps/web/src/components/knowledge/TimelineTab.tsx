import { useStore } from "../../store.js";
export function TimelineTab() {
  const timeline = useStore((s) => s.timeline);
  if (timeline.length === 0) return <div className="tf-guide"><div className="tf-guide-title">暂无事件</div><div className="tf-guide-hint">记录 Fact / Task / Action 等关键动作会按时间顺序出现在这里。</div></div>;
  return <>{timeline.map((e) => <div className="tf-row" key={e.id}><span className="tf-tag">{e.eventType}</span>{e.detail}</div>)}</>;
}
