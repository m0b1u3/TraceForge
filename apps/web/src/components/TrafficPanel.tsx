import { useState } from "react";
import { CaretRight, Globe } from "@phosphor-icons/react";
import type { TrafficEntry } from "@traceforge/shared";
import { useStore } from "../store.js";
import { BrowserControls } from "./BrowserPanel.js";

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
  const methodClass = ["get", "post", "put", "patch", "delete"].includes(t.method.toLowerCase())
    ? t.method.toLowerCase()
    : "other";
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
          <CaretRight className="request-row-caret" size={14} weight="bold" aria-hidden="true" />
          <span className={`method ${methodClass}`}>{t.method}</span>
          <strong>{status}</strong>
          <time className="request-row-time" dateTime={t.createdAt}>{requestTime}</time>
        </span>
        <span className="request-row-url">{t.url}</span>
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
  const statusClass = browserController === "human" ? "busy" : browserController ? "active" : "";
  return (
    <aside className="panel traffic-panel">
      <header className="panel-header">
        <div className="panel-header-main">
          <Globe size={18} />
          <div>
            <span className="section-kicker">Capture</span>
            <h2>Traffic</h2>
          </div>
        </div>
        <div className="panel-header-actions">
          <BrowserControls />
          <span className="tf-pill traffic-count-pill" aria-live="polite">{traffic.length} req</span>
          <button className="tf-btn tf-btn-ghost" disabled={traffic.length === 0} onClick={clearTraffic}>Clear</button>
        </div>
      </header>
      <div className="browser-strip">
        <span className={`status-dot ${statusClass}`} />
        <span className="browser-url" title={browserUrl || undefined}>{browserUrl || "No browser URL"}</span>
        <span className="tf-pill">{browserController || "idle"}</span>
      </div>
      <div className="request-list">
        {traffic.length === 0 && (
          <div className="tf-guide">
            <div className="tf-guide-title">No traffic yet</div>
            <div className="tf-guide-hint">Launch the shared browser to see captured requests here.</div>
          </div>
        )}
        {traffic.map((t) => <TrafficRow t={t} key={t.id} />)}
      </div>
    </aside>
  );
}
