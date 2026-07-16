import { lazy, Suspense, useEffect } from "react";
import { CircleNotch } from "@phosphor-icons/react";
import { useStore } from "./store.js";
import { CaseLauncher } from "./components/CaseLauncher.js";

const Workbench = lazy(() => import("./components/Workbench.js"));

function Toast() {
  const toast = useStore((state) => state.toast);
  if (!toast) return null;
  return <div className="tf-toast" role="status" aria-live="polite">{toast}</div>;
}

export function App() {
  const caseId = useStore((state) => state.caseId);
  const connectWs = useStore((state) => state.connectWs);
  useEffect(() => connectWs(), [connectWs]);

  if (!caseId) {
    return (
      <div className="app-shell hero-shell">
        <div className="hero-inner">
          <div className="hero-text">
            <div className="hero-brand"><span className="hero-dot" />TRACEFORGE</div>
            <h1 className="hero-title">Autonomous<br />red-team workbench</h1>
            <p className="hero-sub">Let the Agent explore, capture evidence, and reason through findings while you steer scope, approvals, and direction in real time.</p>
            <div className="hero-feats">
              <span>Shared browser</span><span className="hero-sep" />
              <span>Evidence-driven Agent</span><span className="hero-sep" />
              <span>Traceable graph</span>
            </div>
          </div>
          <CaseLauncher variant="hero" />
        </div>
        <Toast />
      </div>
    );
  }

  return (
    <div className="app-shell">
      <Suspense fallback={<div className="workbench-loading" role="status"><CircleNotch className="tf-spin" size={18} /><span>Loading workbench…</span></div>}>
        <Workbench />
      </Suspense>
      <Toast />
    </div>
  );
}
