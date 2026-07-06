import { useStore } from "../../store.js";
export function TimelineTab() {
  const timeline = useStore((s) => s.timeline);
  if (timeline.length === 0) return <div className="tf-guide"><div className="tf-guide-title">No timeline events yet.</div><div className="tf-guide-hint">Key actions like Fact / Task / Action recordings appear here in chronological order.</div></div>;
  return <>{timeline.map((e) => (
    <div className="timeline-item" key={e.id}>
      <div className="timeline-time">{e.eventType}</div>
      <div>{e.detail}</div>
    </div>
  ))}</>;
}
