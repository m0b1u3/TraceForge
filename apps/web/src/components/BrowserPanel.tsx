import { useStore } from "../store.js";
import { startBrowser, stopBrowser, takeoverBrowser, releaseBrowser } from "../api.js";

export function BrowserPanel() {
  const { caseId, browserController, browserUrl } = useStore();
  if (!caseId) return null;
  return (
    <div className="tf-panel">
      <div className="tf-panel-head">
        共享浏览器
        {browserController && <span className="tf-count">{browserUrl || "about:blank"}</span>}
      </div>
      <div className="tf-panel-body">
        {browserController === null ? (
          <button className="tf-btn tf-btn-accent" onClick={() => startBrowser(caseId)}>启动浏览器</button>
        ) : (
          <div style={{ display: "flex", gap: 6 }}>
            {browserController === "llm"
              ? <button className="tf-btn" onClick={() => takeoverBrowser(caseId)}>接管</button>
              : <button className="tf-btn tf-btn-accent" onClick={() => releaseBrowser(caseId)}>交回 LLM</button>}
            <button className="tf-btn" onClick={() => stopBrowser(caseId)}>停止</button>
          </div>
        )}
      </div>
    </div>
  );
}
