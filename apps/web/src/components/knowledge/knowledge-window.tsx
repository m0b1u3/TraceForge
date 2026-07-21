import { useState } from "react";

export const KNOWLEDGE_WINDOW_SIZE = 100;

export function confidencePercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const percentage = value <= 1 ? value * 100 : value;
  return Math.round(Math.min(100, Math.max(0, percentage)));
}

export function useKnowledgeWindow(total: number) {
  const [visibleCount, setVisibleCount] = useState(KNOWLEDGE_WINDOW_SIZE);
  const count = Math.min(total, visibleCount);
  return {
    count,
    hasMore: count < total,
    showMore: () => setVisibleCount((current) => Math.min(total, current + KNOWLEDGE_WINDOW_SIZE)),
    reveal: (index: number) => setVisibleCount((current) => Math.min(total, Math.max(current, index + 1))),
  };
}

export function KnowledgeWindowFooter({
  visible,
  total,
  onShowMore,
}: {
  visible: number;
  total: number;
  onShowMore: () => void;
}) {
  if (visible >= total) return null;
  return (
    <div className="knowledge-window-footer">
      <span>Showing {visible} of {total}</span>
      <button type="button" onClick={onShowMore}>Show next {Math.min(KNOWLEDGE_WINDOW_SIZE, total - visible)}</button>
    </div>
  );
}
