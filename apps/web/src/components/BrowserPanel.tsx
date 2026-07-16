import { useState } from "react";
import { ArrowCounterClockwise, Browser, CircleNotch, HandTap, StopCircle } from "@phosphor-icons/react";
import { useStore } from "../store.js";
import { startBrowser, stopBrowser, takeoverBrowser, releaseBrowser } from "../api.js";
import { useShallow } from "zustand/react/shallow";

function browserActionError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.replace(/\x1b\[[0-9;]*m/g, "").toLowerCase();

  if (normalized.includes("spawn unknown") || normalized.includes("executable doesn't exist")) {
    return "Unable to launch the shared browser. Check that Chromium is installed and permitted to run.";
  }
  if (normalized.includes("no browser session")) {
    return "The shared browser is no longer running. Launch it again to continue.";
  }
  if (normalized.includes("failed to fetch") || normalized.includes("networkerror")) {
    return "Unable to reach the TraceForge server. Check that the server is running.";
  }
  return "The browser action could not be completed. Try again or check the server logs.";
}

export function BrowserControls() {
  const { caseId, browserController, setBrowser, resetBrowser, showToast } = useStore(useShallow((state) => ({
    caseId: state.caseId,
    browserController: state.browserController,
    setBrowser: state.setBrowser,
    resetBrowser: state.resetBrowser,
    showToast: state.showToast,
  })));
  const [busy, setBusy] = useState(false);
  if (!caseId) return null;

  // Show failures and disable controls while a browser action is in flight.
  const run = (fn: () => Promise<void>) => async () => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      const rawMessage = e instanceof Error ? e.message : String(e);
      if (rawMessage.toLowerCase().includes("no browser session")) resetBrowser();
      console.error("Browser action failed", e);
      showToast(browserActionError(e));
    } finally { setBusy(false); }
  };

  if (browserController === null) {
    return (
      <button className="tf-btn tf-btn-primary" disabled={busy} aria-busy={busy} onClick={run(async () => {
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
        ? <button className="tf-btn tf-btn-primary" disabled={busy} aria-busy={busy} aria-label="Take over browser control" onClick={run(async () => {
            const state = await takeoverBrowser(caseId);
            setBrowser(state.controller, state.url);
          })}><HandTap size={14} aria-hidden="true" />Take over</button>
        : <button className="tf-btn tf-btn-primary" disabled={busy} aria-busy={busy} aria-label="Return browser control to Agent" onClick={run(async () => {
            const state = await releaseBrowser(caseId);
            setBrowser(state.controller, state.url);
          })}><ArrowCounterClockwise size={14} aria-hidden="true" />Return to Agent</button>}
      <button className="tf-btn tf-btn-danger" disabled={busy} aria-busy={busy} aria-label="Stop shared browser" onClick={run(async () => {
        await stopBrowser(caseId);
        resetBrowser();
      })}><StopCircle size={14} aria-hidden="true" />Stop</button>
    </div>
  );
}
