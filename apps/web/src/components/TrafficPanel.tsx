import { Browser, Browsers, CaretRight, Crosshair, HandTap, Pulse, Robot, Trash } from "@phosphor-icons/react";
import type { TrafficEntry } from "@traceforge/shared";
import { memo } from "react";
import { useStore } from "../store.js";
import { BrowserControls } from "./BrowserPanel.js";
import { MethodBadge } from "./design-system/MethodBadge.js";
import { StatusDot, type StatusDotTone } from "./design-system/StatusDot.js";
import { useShallow } from "zustand/react/shallow";

export function formatTrafficTime(createdAt: string, locale = globalThis.navigator?.language ?? "en-US", timeZone?: string): string {
  return new Date(createdAt).toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone,
  });
}

const TrafficRow = memo(function TrafficRow({ t, selected, onSelect }: { t: TrafficEntry; selected: boolean; onSelect: (id: string) => void }) {
  const requestTime = formatTrafficTime(t.createdAt);
  const status = t.responseStatus ?? "Pending";
  const statusClass = t.responseStatus === null ? "st-pending" : `st-${String(t.responseStatus).charAt(0)}`;
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
        onClick={() => onSelect(t.id)}
      >
        <span className="request-row-head">
          <CaretRight className="request-row-caret" size={14} aria-hidden="true" />
          <MethodBadge method={t.method} />
          <strong>{status}</strong>
          <span className="request-row-host">{host}</span>
          <time className="request-row-time" dateTime={t.createdAt}>{requestTime}</time>
        </span>
        <span className="request-row-url">{path || t.url}</span>
        <span className="request-row-full-url">{t.url}</span>
      </button>
    </article>
  );
});

export function TrafficPanel() {
  const { traffic, clearTraffic, browserController, browserUrl, selectedTrafficId, selectTraffic } = useStore(useShallow((state) => ({ traffic: state.traffic, clearTraffic: state.clearTraffic, browserController: state.browserController, browserUrl: state.browserUrl, selectedTrafficId: state.selectedTrafficId, selectTraffic: state.selectTraffic })));
  const statusTone: StatusDotTone = browserController === "human" ? "busy" : browserController ? "active" : "idle";
  return (
    <aside className="panel traffic-panel">
      <header className="panel-header">
        <div className="panel-heading"><Browsers size={16} weight="duotone" aria-hidden="true" /><span className="section-kicker">Traffic capture</span></div>
        <div className="panel-header-actions">
          <BrowserControls />
        </div>
      </header>
      <div className="capture-summary">
        <div><span>Connection</span><strong><StatusDot tone={statusTone} />{browserController ? "Connected" : "Offline"}</strong></div>
        <div><span>Control owner</span><strong>{browserController === "human" ? <HandTap size={13} aria-hidden="true" /> : <Robot size={13} aria-hidden="true" />}{browserController === "human" ? "Operator" : browserController === "llm" ? "Agent" : "None"}</strong></div>
        <div><span>Requests captured</span><strong>{traffic.length.toLocaleString()}</strong></div>
      </div>
      <div className="capture-readiness-block">
        <span className="capture-subhead">Readiness</span>
        <div><Browser size={14} /><span>Browser</span><strong>{browserController ? "Capture ready" : "Not connected"}</strong></div>
        <div><Crosshair size={14} /><span>Target</span><strong title={browserUrl || undefined}>{browserUrl ? "Reachable" : "Not set"}</strong></div>
        <div><Pulse size={14} /><span>Requests</span><strong>{traffic.length}</strong></div>
      </div>
      <div className="traffic-list-toolbar">
        <span className="is-active">Live</span>
        <strong>{traffic.length} captured</strong>
      </div>
      <div className="request-list">
        {traffic.length === 0 && (
          <div className="capture-empty">
            <Browsers className="capture-empty-icon" size={24} weight="duotone" aria-hidden="true" />
            <span>No traffic captured</span>
            <p>{browserController ? "Requests will appear here as the browser navigates the target." : "Launch the shared browser to start a trace."}</p>
          </div>
        )}
        {traffic.map((t) => <TrafficRow t={t} selected={selectedTrafficId === t.id} onSelect={selectTraffic} key={t.id} />)}
      </div>
      <footer className="traffic-footer"><span>{browserController ? "Capture active" : "Capture paused"}</span><button className="tf-btn tf-btn-ghost" disabled={traffic.length === 0} onClick={clearTraffic}><Trash size={13} />Clear</button></footer>
    </aside>
  );
}
