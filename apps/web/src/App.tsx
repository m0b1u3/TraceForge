import { useEffect } from "react";
import { useStore } from "./store.js";
import { TopBar } from "./components/TopBar.js";
import { CaseLauncher } from "./components/CaseLauncher.js";
import { TrafficPanel } from "./components/TrafficPanel.js";
import { AgentPanel } from "./components/AgentPanel.js";
import { KnowledgePanel } from "./components/KnowledgePanel.js";
import { GraphModal } from "./components/GraphModal.js";

function Toast() {
  const toast = useStore((s) => s.toast);
  if (!toast) return null;
  return <div className="tf-toast">{toast}</div>;
}

export function App() {
  const { caseId, connectWs } = useStore();
  useEffect(() => { connectWs(); }, [connectWs]);

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
      <TopBar />
      <section className="workspace">
        <TrafficPanel />
        <AgentPanel />
        <KnowledgePanel />
      </section>
      <GraphModal />
      <Toast />
    </div>
  );
}
