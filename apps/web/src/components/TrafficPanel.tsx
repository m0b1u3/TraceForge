import { useState } from "react";
import { Pulse } from "@phosphor-icons/react";
import type { TrafficEntry } from "@traceforge/shared";
import { useStore } from "../store.js";
import { BrowserControls } from "./BrowserPanel.js";

function TrafficRow({ t }: { t: TrafficEntry }) {
  const [open, setOpen] = useState(false);
  const headers = Object.entries(t.requestHeaders ?? {});
  return (
    <article className={`request-row st-${String(t.responseStatus).charAt(0)} ${open ? "is-open" : ""}`} title={t.url}>
      <div className="request-top" style={{ cursor: "pointer" }} onClick={() => setOpen((v) => !v)}>
        <span className={`method ${t.method.toLowerCase()}`}>{t.method}</span>
        <strong>{t.responseStatus ?? "—"}</strong>
      </div>
      <p style={{ cursor: "pointer" }} onClick={() => setOpen((v) => !v)}>{t.url}</p>
      {open && (
        <div className="request-detail">
          <div className="request-detail-time">{new Date(t.createdAt).toLocaleString()}</div>
          {headers.length > 0 && (
            <div className="request-detail-block">
              <div className="request-detail-label">请求头</div>
              {headers.map(([k, v]) => <div className="kv" key={k}><span>{k}</span>{v}</div>)}
            </div>
          )}
          <div className="request-detail-block">
            <div className="request-detail-label">响应体</div>
            <pre>{t.responseBody ?? "（未捕获响应体）"}</pre>
          </div>
        </div>
      )}
    </article>
  );
}

export function TrafficPanel() {
  const { caseId, traffic, browserController, browserUrl } = useStore();
  return (
    <aside className="panel traffic-panel">
      <div className="panel-header">
        <div><span className="section-kicker">Capture</span><h2>流量</h2></div>
        {caseId && <BrowserControls />}
      </div>
      <div className="browser-strip">
        <Pulse size={14} />
        <span>{browserController ? (browserUrl || "about:blank") : "未启动共享浏览器"}</span>
        {browserController && <i />}
      </div>
      <div className="request-list">
        {traffic.length === 0 && (
          <div className="tf-guide">
            <div className="tf-guide-title">暂无流量</div>
            <div className="tf-guide-hint">启动共享浏览器后，你和 Agent 的访问都会出现在这里。</div>
          </div>
        )}
        {traffic.map((t) => <TrafficRow t={t} key={t.id} />)}
      </div>
    </aside>
  );
}
