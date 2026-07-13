import { useStore } from "../../store.js";

function formatTimelineTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

export function TimelineTab() {
  const timeline = useStore((s) => s.timeline);
  if (timeline.length === 0) return <div className="tf-guide"><div className="tf-guide-title">No timeline events yet.</div><div className="tf-guide-hint">Key actions like Fact / Task / Action recordings appear here in chronological order.</div></div>;
  return <>{timeline.map((e) => (
    <div className="timeline-item" key={e.id}>
      <div className="timeline-meta"><span className="tf-tag">{e.eventType}</span><time dateTime={e.createdAt}>{formatTimelineTime(e.createdAt)}</time></div>
      <div className="timeline-detail">{e.detail}</div>
    </div>
  ))}</>;
}
