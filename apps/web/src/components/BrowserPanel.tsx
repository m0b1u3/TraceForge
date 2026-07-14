import { useState } from "react";
import { LoaderCircle, MonitorUp } from "lucide-react";
import { useStore } from "../store.js";
import { startBrowser, stopBrowser, takeoverBrowser, releaseBrowser } from "../api.js";

export function BrowserControls() {
  const { caseId, browserController, showToast } = useStore();
  const [busy, setBusy] = useState(false);
  if (!caseId) return null;

  // Show failures and disable controls while a browser action is in flight.
  const run = (fn: () => Promise<void>) => async () => {
    setBusy(true);
    try { await fn(); } catch (e) { showToast((e as Error).message); } finally { setBusy(false); }
  };

  if (browserController === null) {
    return (
      <button className="tf-btn tf-btn-primary" disabled={busy} onClick={run(() => startBrowser(caseId))}>
        {busy ? <LoaderCircle size={15} className="tf-spin" /> : <MonitorUp size={15} />} {busy ? "Launching…" : "Launch browser"}
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
