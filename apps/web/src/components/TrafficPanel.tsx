import { useState } from "react";
import { Globe } from "@phosphor-icons/react";
import type { TrafficEntry } from "@traceforge/shared";
import { useStore } from "../store.js";

function TrafficRow({ t }: { t: TrafficEntry }) {
  const [open, setOpen] = useState(false);
  const headers = Object.entries(t.requestHeaders ?? {});
  return (
    <article className={`request-row st-${String(t.responseStatus).charAt(0)} ${open ? "is-open" : ""}`} title={t.url}>
      <div className="request-row-head" onClick={() => setOpen((v) => !v)}>
        <span className={`method ${t.method.toLowerCase()}`}>{t.method}</span>
        <strong>{t.responseStatus ?? "—"}</strong>
      </div>
      <p className="request-row-url" onClick={() => setOpen((v) => !v)}>{t.url}</p>
      {open && (
        <div className="request-detail">
          <div className="request-detail-time">{new Date(t.createdAt).toLocaleString()}</div>
          {headers.length > 0 && (
            <div className="request-detail-block">
              <div className="request-detail-label">Headers</div>
              {headers.map(([k, v]) => <div className="kv" key={k}><span>{k}</span>{v}</div>)}
            </div>
          )}
          <div className="request-detail-block">
            <div className="request-detail-label">Body</div>
            <pre>{t.responseBody ?? "No body captured"}</pre>
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
          <span className="tf-pill">{traffic.length} req</span>
          <button className="tf-btn tf-btn-ghost" onClick={clearTraffic}>Clear</button>
        </div>
      </header>
      <div className="browser-strip">
        <span className={`status-dot ${statusClass}`} />
        <span className="browser-url">{browserUrl || "No browser URL"}</span>
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
