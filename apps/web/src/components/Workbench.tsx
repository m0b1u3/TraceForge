import { lazy, Suspense } from "react";
import { CircleNotch, Warning } from "@phosphor-icons/react";
import { useShallow } from "zustand/react/shallow";
import { useStore } from "../store.js";
import { AgentPanel } from "./AgentPanel.js";
import { GraphView } from "./GraphView.js";
import { KnowledgePanel } from "./KnowledgePanel.js";
import { TopBar } from "./TopBar.js";
import { TrafficPanel } from "./TrafficPanel.js";
import { WorkspaceLayout } from "./WorkspaceLayout.js";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

const GraphModal = lazy(async () => {
  const module = await import("./GraphModal.js");
  return { default: module.GraphModal };
});

const SettingsModal = lazy(async () => {
  const module = await import("./SettingsModal.js");
  return { default: module.SettingsModal };
});

function DeferredSurface({ label }: { label: string }) {
  return <div className="tf-modal-bg" role="status" aria-live="polite" aria-label={`Loading ${label}`}><div className="deferred-surface"><CircleNotch className="tf-spin" size={18} /><span>Loading {label}…</span></div></div>;
}

function ObserverConfirmation() {
  const pendingConfirmation = useStore((state) => state.pendingConfirmation);
  const clearPendingConfirmation = useStore((state) => state.clearPendingConfirmation);
  const setActiveTab = useStore((state) => state.setActiveTab);
  if (!pendingConfirmation) return null;
  const { warning } = pendingConfirmation;
  return (
    <Alert variant="warning" className="observer-confirmation">
      <Warning className="observer-confirmation-icon" size={18} weight="fill" />
      <AlertTitle className="observer-confirmation-title"><span>Observer intervention</span><strong>{warning.title}</strong></AlertTitle>
      <AlertDescription className="observer-confirmation-body">
        <p title={warning.description}>{warning.description}</p>
        <div className="observer-confirmation-actions">
          <Button type="button" size="sm" onClick={() => { setActiveTab("observer"); clearPendingConfirmation(); }}>Review warning</Button>
          <Button type="button" variant="outline" size="sm" onClick={clearPendingConfirmation}>Dismiss</Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}

export default function Workbench() {
  const { graphModalOpen, settingsModalOpen } = useStore(useShallow((state) => ({ graphModalOpen: state.graphModalOpen, settingsModalOpen: state.settingsModalOpen })));
  return <>
    <TopBar />
    <main className="workspace-page">
      <ObserverConfirmation />
      <WorkspaceLayout traffic={<TrafficPanel />} canvas={<GraphView interactive />} knowledge={<KnowledgePanel />} dock={<AgentPanel />} />
    </main>
    {graphModalOpen && <Suspense fallback={<DeferredSurface label="attack graph" />}><GraphModal /></Suspense>}
    {settingsModalOpen && <Suspense fallback={<DeferredSurface label="settings" />}><SettingsModal /></Suspense>}
  </>;
}
