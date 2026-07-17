import { useEffect, useMemo, useState } from "react";

export function mergeHistoryById<T extends { id: string }>(older: T[], live: T[]): T[] {
  const liveIds = new Set(live.map((item) => item.id));
  return [...older.filter((item) => !liveIds.has(item.id)), ...live];
}

export function useOlderHistory<T extends { id: string }>({
  caseId,
  live,
  pageSize,
  loadPage,
}: {
  caseId: string | null;
  live: T[];
  pageSize: number;
  loadPage: (caseId: string, limit: number, offset: number) => Promise<T[]>;
}) {
  const [older, setOlder] = useState<T[]>([]);
  const [loading, setLoading] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setOlder([]);
    setLoading(false);
    setExhausted(false);
    setError(null);
  }, [caseId]);

  const items = useMemo(() => mergeHistoryById(older, live), [live, older]);
  const loadOlder = async () => {
    if (!caseId || loading || exhausted) return;
    setLoading(true);
    setError(null);
    try {
      const page = await loadPage(caseId, pageSize, live.length + older.length);
      setOlder((current) => mergeHistoryById(page, current));
      if (page.length < pageSize) setExhausted(true);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const clearOlder = () => {
    setOlder([]);
    setExhausted(false);
    setError(null);
  };

  return { items, olderCount: older.length, loading, exhausted, error, loadOlder, clearOlder };
}
