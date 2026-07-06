import { useState } from "react";
import { Browser, CircleNotch } from "@phosphor-icons/react";
import { useStore } from "../store.js";
import { startBrowser, stopBrowser, takeoverBrowser, releaseBrowser } from "../api.js";

export function BrowserControls() {
  const { caseId, browserController, showToast } = useStore();
  const [busy, setBusy] = useState(false);
  if (!caseId) return null;

  // 包一层：失败提示用户、进行中禁用按钮（避免冷启动期间狂点触发多次 start）
  const run = (fn: () => Promise<void>) => async () => {
    setBusy(true);
    try { await fn(); } catch (e) { showToast((e as Error).message); } finally { setBusy(false); }
  };

  if (browserController === null) {
    return (
      <button className="tf-btn tf-btn-primary" disabled={busy} onClick={run(() => startBrowser(caseId))}>
        {busy ? <CircleNotch size={15} className="tf-spin" /> : <Browser size={15} />} {busy ? "Launching…" : "Launch browser"}
      </button>
    );
  }
  return (
    <div className="tf-btn-group">
      {browserController === "llm"
        ? <button className="tf-btn tf-btn-primary" disabled={busy} onClick={run(() => takeoverBrowser(caseId))}>Take over</button>
        : <button className="tf-btn tf-btn-primary" disabled={busy} onClick={run(() => releaseBrowser(caseId))}>Return to LLM</button>}
      <button className="tf-btn tf-btn-danger" disabled={busy} onClick={run(() => stopBrowser(caseId))}>Stop</button>
    </div>
  );
}
