import { Browser, Browsers, CaretRight, CircleNotch, Crosshair, HandTap, MagnifyingGlass, Pulse, Robot, Trash, Warning, X } from "@phosphor-icons/react";
import type { TrafficEntry } from "@traceforge/shared";
import { memo, useDeferredValue, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store.js";
import { BrowserControls, type BrowserAction } from "./BrowserPanel.js";
import { MethodBadge } from "./design-system/MethodBadge.js";
import { StatusDot, type StatusDotTone } from "./design-system/StatusDot.js";
import { useShallow } from "zustand/react/shallow";
import { Button } from "./ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select.js";
import { listTraffic } from "../api.js";
import { useOlderHistory } from "../hooks/use-older-history.js";

export type TrafficMethodFilter = "all" | "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "other";
export type TrafficStatusFilter = "all" | "pending" | "2xx" | "3xx" | "4xx" | "5xx";
const MAX_RENDERED_REQUESTS = 500;
const TRAFFIC_HISTORY_PAGE_SIZE = 500;

export function filterTraffic(entries: TrafficEntry[], query: string, method: TrafficMethodFilter, status: TrafficStatusFilter): TrafficEntry[] {
  const normalizedQuery = query.trim().toLowerCase();
  return entries.filter((entry) => {
    const normalizedMethod = entry.method.toUpperCase();
    const methodMatches = method === "all"
      || (method === "other"
        ? !["GET", "POST", "PUT", "PATCH", "DELETE"].includes(normalizedMethod)
        : normalizedMethod === method);
    const statusMatches = status === "all"
      || (status === "pending"
        ? entry.responseStatus === null
        : entry.responseStatus !== null && Math.floor(entry.responseStatus / 100) === Number(status[0]));
    const queryMatches = !normalizedQuery || [
      entry.url,
      entry.method,
      entry.responseStatus?.toString() ?? "pending",
      entry.contentType ?? "",
    ].some((value) => value.toLowerCase().includes(normalizedQuery));
    return methodMatches && statusMatches && queryMatches;
  });
}

function formatBytes(value?: number | null): string | null {
  if (value === null || value === undefined) return null;
  if (value < 1024) return `${value} B`;
  return `${(value / 1024).toFixed(value < 10_240 ? 1 : 0)} KB`;
}

export function formatTrafficTime(createdAt: string, locale = globalThis.navigator?.language ?? "en-US", timeZone?: string): string {
  return new Date(createdAt).toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone,
  });
}

const TrafficRow = memo(function TrafficRow({ t, selected, onSelect }: { t: TrafficEntry; selected: boolean; onSelect: (entry: TrafficEntry) => void }) {
  const requestTime = formatTrafficTime(t.createdAt);
  const status = t.responseStatus ?? "Pending";
  const statusClass = t.responseStatus === null ? "st-pending" : `st-${String(t.responseStatus).charAt(0)}`;
  const responseSize = formatBytes(t.responseSize);
  let host = t.url;
  let path = "";
  try {
    const parsed = new URL(t.url);
    host = parsed.host;
    path = `${parsed.pathname}${parsed.search}`;
  } catch {
    // Captured targets may be host/path fragments rather than absolute URLs.
  }
  return (
    <article className={`request-row ${statusClass} ${selected ? "is-selected" : ""}`}>
      <button
        type="button"
        className="request-row-trigger"
        aria-pressed={selected}
        title={t.url}
        onClick={() => onSelect(t)}
      >
        <span className="request-row-head">
          <CaretRight className="request-row-caret" size={14} aria-hidden="true" />
          <MethodBadge method={t.method} />
          <strong>{status}</strong>
          <span className="request-row-host">{host}</span>
          <time className="request-row-time" dateTime={t.createdAt}>{requestTime}</time>
        </span>
        <span className="request-row-url">{path || t.url}</span>
        {(t.contentType || responseSize) && <span className="request-row-meta">{t.contentType?.split(";")[0]}{t.contentType && responseSize ? " · " : ""}{responseSize}</span>}
        <span className="request-row-full-url">{t.url}</span>
      </button>
    </article>
  );
});

export function TrafficPanel() {
  const { caseId, traffic, clearTraffic, browserController, browserUrl, selectedTrafficId, inspectTraffic } = useStore(useShallow((state) => ({ caseId: state.caseId, traffic: state.traffic, clearTraffic: state.clearTraffic, browserController: state.browserController, browserUrl: state.browserUrl, selectedTrafficId: state.selectedTrafficId, inspectTraffic: state.inspectTraffic })));
  const history = useOlderHistory({
    caseId,
    live: traffic,
    pageSize: TRAFFIC_HISTORY_PAGE_SIZE,
    loadPage: (id, limit, offset) => listTraffic(id, { limit, offset }),
  });
  const allTraffic = history.items;
  const statusTone: StatusDotTone = browserController === "human" ? "busy" : browserController ? "active" : "idle";
  const [clearOpen, setClearOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [browserAction, setBrowserAction] = useState<BrowserAction | null>(null);
  const [query, setQuery] = useState("");
  const [methodFilter, setMethodFilter] = useState<TrafficMethodFilter>("all");
  const [statusFilter, setStatusFilter] = useState<TrafficStatusFilter>("all");
  const deferredQuery = useDeferredValue(query);
  const visibleTraffic = useMemo(
    () => filterTraffic(allTraffic, deferredQuery, methodFilter, statusFilter),
    [allTraffic, deferredQuery, methodFilter, statusFilter],
  );
  const renderedTraffic = useMemo(() => {
    if (visibleTraffic.length <= MAX_RENDERED_REQUESTS) return visibleTraffic;
    const latest = visibleTraffic.slice(-MAX_RENDERED_REQUESTS);
    const selected = selectedTrafficId ? visibleTraffic.find((entry) => entry.id === selectedTrafficId) : undefined;
    return selected && !latest.some((entry) => entry.id === selected.id) ? [selected, ...latest.slice(1)] : latest;
  }, [selectedTrafficId, visibleTraffic]);
  const filtersActive = query.trim().length > 0 || methodFilter !== "all" || statusFilter !== "all";
  const requestListRef = useRef<HTMLDivElement | null>(null);
  const followTail = useRef(true);
  const previousTrafficLength = useRef(traffic.length);
  const browserTransitioning = browserAction !== null;
  const connectionLabel = browserAction === "launch" ? "Connecting" : browserAction === "stop" ? "Disconnecting" : browserController ? "Connected" : "Offline";
  const ownerLabel = browserAction === "takeover" || browserAction === "release" ? "Switching" : browserController === "human" ? "Operator" : browserController === "llm" ? "Agent" : "None";
  useLayoutEffect(() => {
    const list = requestListRef.current;
    if (list && traffic.length > previousTrafficLength.current && followTail.current) list.scrollTop = list.scrollHeight;
    previousTrafficLength.current = traffic.length;
  }, [traffic.length]);
  const handleListScroll = () => {
    const list = requestListRef.current;
    if (!list) return;
    followTail.current = list.scrollHeight - list.scrollTop - list.clientHeight < 32;
  };
  const resetFilters = () => {
    setQuery("");
    setMethodFilter("all");
    setStatusFilter("all");
  };
  const confirmClear = async () => {
    setClearing(true);
    const cleared = await clearTraffic();
    setClearing(false);
    if (cleared) {
      history.clearOlder();
      setClearOpen(false);
    }
  };
  return (
    <>
    <aside className="panel traffic-panel">
      <header className="panel-header">
        <div className="panel-heading"><Browsers size={16} weight="duotone" aria-hidden="true" /><span className="section-kicker">Traffic capture</span></div>
        <div className="panel-header-actions">
          <BrowserControls onActionChange={setBrowserAction} />
        </div>
      </header>
      <div className="capture-summary">
        <div><span>Connection</span><strong><StatusDot tone={browserTransitioning ? "busy" : statusTone} />{connectionLabel}</strong></div>
        <div><span>Control owner</span><strong>{browserTransitioning ? <CircleNotch className="is-spinning" size={13} aria-hidden="true" /> : browserController === "human" ? <HandTap size={13} aria-hidden="true" /> : <Robot size={13} aria-hidden="true" />}{ownerLabel}</strong></div>
        <div><span>Requests captured</span><strong>{traffic.length.toLocaleString()}</strong></div>
      </div>
      <div className="capture-readiness-block">
        <span className="capture-subhead">Readiness</span>
        <div><Browser size={14} /><span>Browser</span><strong>{browserAction === "launch" ? "Starting" : browserAction === "stop" ? "Stopping" : browserController ? "Capture ready" : "Not connected"}</strong></div>
        <div><Crosshair size={14} /><span>Target</span><strong title={browserUrl || undefined}>{browserUrl ? "Reachable" : "Not set"}</strong></div>
        <div><Pulse size={14} /><span>Requests</span><strong>{traffic.length}</strong></div>
      </div>
      <div className="traffic-list-toolbar">
        <span className="is-active">Live</span>
        <strong>{visibleTraffic.length > renderedTraffic.length ? `${renderedTraffic.length} of ${visibleTraffic.length}` : filtersActive ? `${visibleTraffic.length} / ${traffic.length}` : `${traffic.length} captured`}</strong>
      </div>
      <div className="traffic-filter-bar" role="search" aria-label="Filter captured requests">
        <label className="traffic-search">
          <MagnifyingGlass size={13} aria-hidden="true" />
          <span className="sr-only">Search captured requests</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search…" />
          {query && <button type="button" aria-label="Clear request search" onClick={() => setQuery("")}><X size={12} /></button>}
        </label>
        <Select value={methodFilter} onValueChange={(value) => setMethodFilter(value as TrafficMethodFilter)}>
          <SelectTrigger size="sm" aria-label="Filter by HTTP method"><SelectValue /></SelectTrigger>
          <SelectContent position="popper" align="start">
            <SelectItem value="all">Method</SelectItem>
            <SelectItem value="GET">GET</SelectItem>
            <SelectItem value="POST">POST</SelectItem>
            <SelectItem value="PUT">PUT</SelectItem>
            <SelectItem value="PATCH">PATCH</SelectItem>
            <SelectItem value="DELETE">DELETE</SelectItem>
            <SelectItem value="other">Other</SelectItem>
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value as TrafficStatusFilter)}>
          <SelectTrigger size="sm" aria-label="Filter by response status"><SelectValue /></SelectTrigger>
          <SelectContent position="popper" align="start">
            <SelectItem value="all">Status</SelectItem>
            <SelectItem value="pending">Pending</SelectItem>
            <SelectItem value="2xx">2xx</SelectItem>
            <SelectItem value="3xx">3xx</SelectItem>
            <SelectItem value="4xx">4xx</SelectItem>
            <SelectItem value="5xx">5xx</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="request-list" ref={requestListRef} onScroll={handleListScroll}>
        {traffic.length === 0 && (
          <div className="capture-empty">
            <Browsers className="capture-empty-icon" size={24} weight="duotone" aria-hidden="true" />
            <span>No traffic captured</span>
            <p>{browserController ? "Requests will appear here as the browser navigates the target." : "Launch the shared browser to start a trace."}</p>
          </div>
        )}
        {traffic.length > 0 && visibleTraffic.length === 0 && (
          <div className="capture-empty traffic-filter-empty">
            <MagnifyingGlass className="capture-empty-icon" size={22} aria-hidden="true" />
            <span>No matching requests</span>
            <p>Adjust the search or filters to return to the live trace.</p>
            <button type="button" className="tf-btn tf-btn-ghost" onClick={resetFilters}>Reset filters</button>
          </div>
        )}
        <div className="history-source-bar">
          <button type="button" disabled={!caseId || history.loading || history.exhausted} onClick={() => void history.loadOlder()}>
            {history.loading ? "Loading…" : history.exhausted ? "Beginning reached" : "Load earlier requests"}
          </button>
          {history.olderCount > 0 && <span>{history.olderCount} earlier loaded</span>}
          {history.error && <span role="alert">{history.error}</span>}
        </div>
        {visibleTraffic.length > renderedTraffic.length && <p className="traffic-window-note">Showing the latest {renderedTraffic.length}. Refine the filters to inspect loaded history.</p>}
        {renderedTraffic.map((t) => <TrafficRow t={t} selected={selectedTrafficId === t.id} onSelect={inspectTraffic} key={t.id} />)}
      </div>
      <footer className="traffic-footer"><span aria-live="polite">{browserTransitioning ? "Updating browser…" : browserController ? "Capture active" : "Capture paused"}</span><button type="button" className="tf-btn tf-btn-ghost" disabled={traffic.length === 0 || browserTransitioning} onClick={() => setClearOpen(true)}><Trash size={13} />Clear</button></footer>
    </aside>
    <Dialog open={clearOpen} onOpenChange={(open) => { if (!clearing) setClearOpen(open); }}>
      <DialogContent className="traffic-clear-dialog" showCloseButton={false}>
        <DialogHeader>
          <span className="traffic-clear-icon" aria-hidden="true"><Warning size={16} weight="fill" /></span>
          <DialogTitle>Clear captured traffic?</DialogTitle>
          <DialogDescription>This permanently removes {traffic.length.toLocaleString()} captured {traffic.length === 1 ? "request" : "requests"} from this engagement. Agent events and findings are not affected.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" size="sm" disabled={clearing} onClick={() => setClearOpen(false)}>Cancel</Button>
          <Button variant="destructive" size="sm" disabled={clearing} onClick={() => void confirmClear()}>
            {clearing ? <CircleNotch className="is-spinning" size={14} aria-hidden="true" /> : <Trash size={14} aria-hidden="true" />}
            {clearing ? "Clearing…" : "Clear traffic"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}
