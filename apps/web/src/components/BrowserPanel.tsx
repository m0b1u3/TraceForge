import { useEffect, useRef, useState } from "react";
import { ArrowCounterClockwise, Browser, CircleNotch, HandTap, StopCircle } from "@phosphor-icons/react";
import { useShallow } from "zustand/react/shallow";
import { startBrowser, stopBrowser, takeoverBrowser, releaseBrowser } from "../api.js";
import { useStore } from "../store.js";

export type BrowserAction = "launch" | "takeover" | "release" | "stop";

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

const actionLabels: Record<BrowserAction, string> = {
  launch: "Launching…",
  takeover: "Taking over…",
  release: "Returning…",
  stop: "Stopping…",
};

export function BrowserControls({ onActionChange }: { onActionChange?: (action: BrowserAction | null) => void }) {
  const { caseId, browserController, setBrowser, resetBrowser, showToast } = useStore(useShallow((state) => ({
    caseId: state.caseId,
    browserController: state.browserController,
    setBrowser: state.setBrowser,
    resetBrowser: state.resetBrowser,
    showToast: state.showToast,
  })));
  const [action, setAction] = useState<BrowserAction | null>(null);
  const actionLock = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  if (!caseId) return null;

  const run = (nextAction: BrowserAction, fn: (activeCaseId: string) => Promise<void>) => async () => {
    if (actionLock.current) return;
    actionLock.current = true;
    setAction(nextAction);
    onActionChange?.(nextAction);
    const activeCaseId = caseId;
    try {
      await fn(activeCaseId);
    } catch (error) {
      if (useStore.getState().caseId !== activeCaseId) return;
      const rawMessage = error instanceof Error ? error.message : String(error);
      if (rawMessage.toLowerCase().includes("no browser session")) resetBrowser();
      console.error("Browser action failed", error);
      showToast(browserActionError(error), "error");
    } finally {
      actionLock.current = false;
      if (mounted.current) {
        setAction(null);
        onActionChange?.(null);
      }
    }
  };

  if (browserController === null) {
    return (
      <button type="button" className="tf-btn tf-btn-primary" disabled={action !== null} aria-busy={action === "launch"} onClick={run("launch", async (activeCaseId) => {
        const state = await startBrowser(activeCaseId);
        if (useStore.getState().caseId === activeCaseId) setBrowser(state.controller, state.url);
      })}>
        {action === "launch" ? <CircleNotch size={15} className="tf-spin" aria-hidden="true" /> : <Browser size={15} weight="duotone" aria-hidden="true" />}
        {action === "launch" ? actionLabels.launch : "Launch browser"}
      </button>
    );
  }

  const busy = action !== null;
  return (
    <div className="tf-btn-group">
      {browserController === "llm"
        ? (
          <button type="button" className="tf-btn tf-btn-primary" disabled={busy} aria-busy={action === "takeover"} aria-label="Take over browser control" onClick={run("takeover", async (activeCaseId) => {
            const state = await takeoverBrowser(activeCaseId);
            if (useStore.getState().caseId === activeCaseId) setBrowser(state.controller, state.url);
          })}>
            {action === "takeover" ? <CircleNotch size={14} className="tf-spin" aria-hidden="true" /> : <HandTap size={14} aria-hidden="true" />}
            {action === "takeover" ? actionLabels.takeover : "Take over"}
          </button>
        )
        : (
          <button type="button" className="tf-btn tf-btn-primary" disabled={busy} aria-busy={action === "release"} aria-label="Return browser control to Agent" onClick={run("release", async (activeCaseId) => {
            const state = await releaseBrowser(activeCaseId);
            if (useStore.getState().caseId === activeCaseId) setBrowser(state.controller, state.url);
          })}>
            {action === "release" ? <CircleNotch size={14} className="tf-spin" aria-hidden="true" /> : <ArrowCounterClockwise size={14} aria-hidden="true" />}
            {action === "release" ? actionLabels.release : "Return to Agent"}
          </button>
        )}
      <button type="button" className="tf-btn tf-btn-danger" disabled={busy} aria-busy={action === "stop"} aria-label="Stop shared browser" onClick={run("stop", async (activeCaseId) => {
        await stopBrowser(activeCaseId);
        if (useStore.getState().caseId === activeCaseId) resetBrowser();
      })}>
        {action === "stop" ? <CircleNotch size={14} className="tf-spin" aria-hidden="true" /> : <StopCircle size={14} aria-hidden="true" />}
        {action === "stop" ? actionLabels.stop : "Stop"}
      </button>
    </div>
  );
}
