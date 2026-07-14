import { useState } from "react";
import { Browser, Browsers, CaretRight, Crosshair, Pulse, Trash } from "@phosphor-icons/react";
import type { TrafficEntry } from "@traceforge/shared";
import { useStore } from "../store.js";
import { BrowserControls } from "./BrowserPanel.js";
import { MethodBadge } from "./design-system/MethodBadge.js";
import { StatusDot, type StatusDotTone } from "./design-system/StatusDot.js";

export function formatTrafficTime(createdAt: string, locale = globalThis.navigator?.language ?? "en-US", timeZone?: string): string {
  return new Date(createdAt).toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone,
  });
}

function TrafficRow({ t }: { t: TrafficEntry }) {
  const [open, setOpen] = useState(false);
  const headers = Object.entries(t.requestHeaders ?? {});
  const requestTime = formatTrafficTime(t.createdAt);
  const detailId = `traffic-detail-${t.id}`;
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
    <article className={`request-row ${statusClass} ${open ? "is-open" : ""}`}>
      <button
        type="button"
        className="request-row-trigger"
        aria-expanded={open}
        aria-controls={detailId}
        title={t.url}
        onClick={() => setOpen((value) => !value)}
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
      {open && (
        <div className="request-detail" id={detailId} role="region" aria-label={`${t.method} ${t.url} evidence`}>
          <time className="request-detail-time" dateTime={t.createdAt}>{new Date(t.createdAt).toLocaleString()}</time>
          <div className="request-detail-block">
            <div className="request-detail-label">Request headers</div>
            {headers.length > 0
              ? <dl className="request-header-list">{headers.map(([key, value]) => <div className="kv" key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>
              : <div className="request-detail-empty">No request headers captured</div>}
          </div>
          <div className="request-detail-block">
            <div className="request-detail-label">Request body</div>
            <pre>{t.requestBody ?? "No request body captured"}</pre>
          </div>
          <div className="request-detail-block">
            <div className="request-detail-label">Response body</div>
            <pre>{t.responseBody ?? "No response body captured"}</pre>
          </div>
        </div>
      )}
    </article>
  );
}

export function TrafficPanel() {
  const { traffic, clearTraffic, browserController, browserUrl } = useStore();
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
        {traffic.map((t) => <TrafficRow t={t} key={t.id} />)}
      </div>
      <footer className="traffic-footer"><span>{browserController ? "Capture active" : "Capture paused"}</span><button className="tf-btn tf-btn-ghost" disabled={traffic.length === 0} onClick={clearTraffic}><Trash size={13} />Clear</button></footer>
    </aside>
  );
}
