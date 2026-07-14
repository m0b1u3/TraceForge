import { useState } from "react";
import { Browser, CircleNotch } from "@phosphor-icons/react";
import { useStore } from "../store.js";
import { startBrowser, stopBrowser, takeoverBrowser, releaseBrowser } from "../api.js";

export function BrowserControls() {
  const { caseId, browserController, setBrowser, resetBrowser, showToast } = useStore();
  const [busy, setBusy] = useState(false);
  if (!caseId) return null;

  // Show failures and disable controls while a browser action is in flight.
  const run = (fn: () => Promise<void>) => async () => {
    setBusy(true);
    try { await fn(); } catch (e) { showToast((e as Error).message); } finally { setBusy(false); }
  };

  if (browserController === null) {
    return (
      <button className="tf-btn tf-btn-primary" disabled={busy} onClick={run(async () => {
        const state = await startBrowser(caseId);
        setBrowser(state.controller, state.url);
      })}>
        {busy ? <CircleNotch size={15} className="tf-spin" /> : <Browser size={15} weight="duotone" />} {busy ? "Launching…" : "Launch browser"}
      </button>
    );
  }
  return (
    <div className="tf-btn-group">
      {browserController === "llm"
        ? <button className="tf-btn tf-btn-primary" disabled={busy} onClick={run(async () => {
            const state = await takeoverBrowser(caseId);
            setBrowser(state.controller, state.url);
          })}>Take over</button>
        : <button className="tf-btn tf-btn-primary" disabled={busy} onClick={run(async () => {
            const state = await releaseBrowser(caseId);
            setBrowser(state.controller, state.url);
          })}>Return to LLM</button>}
      <button className="tf-btn tf-btn-danger" disabled={busy} onClick={run(async () => {
        await stopBrowser(caseId);
        resetBrowser();
      })}>Stop</button>
    </div>
  );
}
