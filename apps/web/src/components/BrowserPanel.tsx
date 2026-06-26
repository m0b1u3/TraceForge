import { Browser } from "@phosphor-icons/react";
import { useStore } from "../store.js";
import { startBrowser, stopBrowser, takeoverBrowser, releaseBrowser } from "../api.js";

export function BrowserControls() {
  const { caseId, browserController } = useStore();
  if (!caseId) return null;
  if (browserController === null) {
    return <button className="browser-button" onClick={() => startBrowser(caseId)}><Browser size={15} /> 启动浏览器</button>;
  }
  return (
    <div style={{ display: "flex", gap: 6 }}>
      {browserController === "llm"
        ? <button className="browser-button" onClick={() => takeoverBrowser(caseId)}>接管</button>
        : <button className="browser-button active" onClick={() => releaseBrowser(caseId)}>交回 LLM</button>}
      <button className="browser-button" onClick={() => stopBrowser(caseId)}>停止</button>
    </div>
  );
}
