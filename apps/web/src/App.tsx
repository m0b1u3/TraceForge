import { useEffect } from "react";
import { useStore } from "./store.js";
import { TopBar } from "./components/TopBar.js";
import { CaseLauncher } from "./components/CaseLauncher.js";
import { TrafficPanel } from "./components/TrafficPanel.js";
import { AgentPanel } from "./components/AgentPanel.js";
import { KnowledgePanel } from "./components/KnowledgePanel.js";
import { WorkspaceLayout } from "./components/WorkspaceLayout.js";
import { GraphModal } from "./components/GraphModal.js";
import { SettingsModal } from "./components/SettingsModal.js";
import { Button } from "@/components/ui/button";
import {
  Alert,
  AlertTitle,
  AlertDescription,
} from "@/components/ui/alert";

function Toast() {
  const toast = useStore((s) => s.toast);
  if (!toast) return null;
  return <div className="tf-toast" role="status" aria-live="polite">{toast}</div>;
}

function ObserverConfirmation() {
  const pendingConfirmation = useStore((s) => s.pendingConfirmation);
  const clearPendingConfirmation = useStore((s) => s.clearPendingConfirmation);
  const setActiveTab = useStore((s) => s.setActiveTab);
  if (!pendingConfirmation) return null;
  const { warning } = pendingConfirmation;
  return (
    <Alert variant="warning" className="mx-4 mt-3">
      <AlertTitle>Observer intervention required</AlertTitle>
      <AlertDescription className="w-full">
        <span>{warning.title}: {warning.description}</span>
        <div className="mt-3 flex gap-2">
          <Button
            type="button"
            size="sm"
            onClick={() => { setActiveTab("observer"); clearPendingConfirmation(); }}
          >
            View in Observer
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => clearPendingConfirmation()}
          >
            Dismiss
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
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
      <main className="workspace-page">
        <ObserverConfirmation />
        <WorkspaceLayout
          traffic={<TrafficPanel />}
          agent={<AgentPanel />}
          knowledge={<KnowledgePanel />}
        />
      </main>
      <GraphModal />
      <SettingsModal />
      <Toast />
    </div>
  );
}
