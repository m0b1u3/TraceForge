import { Browser } from "@phosphor-icons/react";
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
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <button className="tf-btn tf-btn-accent tf-btn-icon" onClick={() => startBrowser(caseId)}><Browser size={15} weight="bold" /> 启动浏览器</button>
            <span className="tf-empty" style={{ lineHeight: 1.6 }}>会弹出一个真实浏览器窗口。LLM 默认自主探索，你可随时「接管」自己操作（如登录），再「交回」。</span>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", gap: 6 }}>
              {browserController === "llm"
                ? <button className="tf-btn" onClick={() => takeoverBrowser(caseId)}>接管</button>
                : <button className="tf-btn tf-btn-accent" onClick={() => releaseBrowser(caseId)}>交回 LLM</button>}
              <button className="tf-btn" onClick={() => stopBrowser(caseId)}>停止</button>
            </div>
            <span className="tf-empty">
              {browserController === "llm" ? "LLM 正在控制。点「接管」可自己操作真窗口。" : "你正在控制真窗口。操作完点「交回 LLM」让 Agent 继续。"}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
