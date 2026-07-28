import { lazy, Suspense } from "react";
import { CircleNotch, Warning } from "@phosphor-icons/react";
import { useShallow } from "zustand/react/shallow";
import { useStore } from "../store.js";
import { AgentPanel } from "./AgentPanel.js";
import { KnowledgePanel } from "./KnowledgePanel.js";
import { TopBar } from "./TopBar.js";
import { TrafficPanel } from "./TrafficPanel.js";
import { WorkspaceLayout } from "./WorkspaceLayout.js";
import { HypothesesTab } from "./knowledge/HypothesesTab.js";
import { McpTab } from "./knowledge/McpTab.js";
import { ObserverTab } from "./knowledge/ObserverTab.js";
import { ReportsTab } from "./knowledge/ReportsTab.js";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog.js";

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
  const setKnowledgeDialog = useStore((state) => state.setKnowledgeDialog);
  if (!pendingConfirmation) return null;
  const { warning } = pendingConfirmation;
  return (
    <Alert variant="warning" className="observer-confirmation">
      <Warning className="observer-confirmation-icon" size={18} weight="fill" />
      <AlertTitle className="observer-confirmation-title"><span>Observer intervention</span><strong>{warning.title}</strong></AlertTitle>
      <AlertDescription className="observer-confirmation-body">
        <p title={warning.description}>{warning.description}</p>
        <div className="observer-confirmation-actions">
          <Button type="button" size="sm" onClick={() => { setKnowledgeDialog("observer"); clearPendingConfirmation(); }}>Review warning</Button>
          <Button type="button" variant="outline" size="sm" onClick={clearPendingConfirmation}>Dismiss</Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}

const KNOWLEDGE_DIALOG_TITLE = { hypotheses: "Hypotheses", mcp: "MCP tools", observer: "Observer", reports: "Reports" } as const;

function KnowledgeDialogHost() {
  const { knowledgeDialog, setKnowledgeDialog } = useStore(useShallow((state) => ({ knowledgeDialog: state.knowledgeDialog, setKnowledgeDialog: state.setKnowledgeDialog })));
  if (!knowledgeDialog) return null;
  return (
    <Dialog open onOpenChange={(open) => { if (!open) setKnowledgeDialog(null); }}>
      <DialogContent className="knowledge-dialog">
        <DialogHeader><DialogTitle>{KNOWLEDGE_DIALOG_TITLE[knowledgeDialog]}</DialogTitle></DialogHeader>
        <div className="knowledge-dialog-body">
          {knowledgeDialog === "hypotheses" && <HypothesesTab />}
          {knowledgeDialog === "mcp" && <McpTab />}
          {knowledgeDialog === "observer" && <ObserverTab />}
          {knowledgeDialog === "reports" && <ReportsTab />}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function Workbench() {
  const { graphModalOpen, settingsModalOpen } = useStore(useShallow((state) => ({ graphModalOpen: state.graphModalOpen, settingsModalOpen: state.settingsModalOpen })));
  return <>
    <TopBar />
    <main className="workspace-page">
      <ObserverConfirmation />
      <WorkspaceLayout traffic={<TrafficPanel />} agent={<AgentPanel />} knowledge={<KnowledgePanel />} />
    </main>
    <KnowledgeDialogHost />
    {graphModalOpen && <Suspense fallback={<DeferredSurface label="attack graph" />}><GraphModal /></Suspense>}
    {settingsModalOpen && <Suspense fallback={<DeferredSurface label="settings" />}><SettingsModal /></Suspense>}
  </>;
}
