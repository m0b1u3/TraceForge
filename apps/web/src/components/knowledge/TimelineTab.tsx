import { useStore } from "../../store.js";
import { FeedbackState } from "../ui/feedback-state.js";
import { KnowledgeWindowFooter, useKnowledgeWindow } from "./knowledge-window.js";
import { listTimeline } from "../../api.js";
import { useOlderHistory } from "../../hooks/use-older-history.js";

const TIMELINE_HISTORY_PAGE_SIZE = 500;

function formatTimelineTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

export function TimelineTab() {
  const timeline = useStore((s) => s.timeline);
  const caseId = useStore((s) => s.caseId);
  const history = useOlderHistory({
    caseId,
    live: timeline,
    pageSize: TIMELINE_HISTORY_PAGE_SIZE,
    loadPage: (id, limit, offset) => listTimeline(id, { limit, offset }),
  });
  const combinedTimeline = history.items;
  const window = useKnowledgeWindow(combinedTimeline.length);
  if (timeline.length === 0) return <FeedbackState title="No timeline events yet" description="Key Fact, Task, and Action recordings will appear here in chronological order." />;
  return (
    <>
      <div className="history-source-bar">
        <button type="button" disabled={history.loading || history.exhausted} onClick={() => void history.loadOlder()}>
          {history.loading ? "Loading…" : history.exhausted ? "Beginning reached" : "Load earlier events"}
        </button>
        {history.olderCount > 0 && <span>{history.olderCount} earlier loaded</span>}
        {history.error && <span role="alert">{history.error}</span>}
      </div>
      {combinedTimeline.slice(0, window.count).map((e) => (
        <div className="timeline-item" key={e.id}>
          <div className="timeline-meta"><span className="tf-tag">{e.eventType}</span><time dateTime={e.createdAt}>{formatTimelineTime(e.createdAt)}</time></div>
          <div className="timeline-detail">{e.detail}</div>
        </div>
      ))}
      <KnowledgeWindowFooter visible={window.count} total={combinedTimeline.length} onShowMore={window.showMore} />
    </>
  );
}
