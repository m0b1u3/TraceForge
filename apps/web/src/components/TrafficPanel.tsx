import { Pulse } from "@phosphor-icons/react";
import { useStore } from "../store.js";
import { BrowserControls } from "./BrowserPanel.js";

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
        {traffic.map((t) => (
          <article className={`request-row st-${String(t.responseStatus).charAt(0)}`} key={t.id} title={t.url}>
            <div className="request-top">
              <span className={`method ${t.method.toLowerCase()}`}>{t.method}</span>
              <strong>{t.responseStatus}</strong>
            </div>
            <p>{t.url}</p>
          </article>
        ))}
      </div>
    </aside>
  );
}
