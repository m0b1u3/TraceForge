import { useEffect } from "react";
import { useStore } from "./store.js";
import { TopBar } from "./components/TopBar.js";
import { BrowserPanel } from "./components/BrowserPanel.js";
import { TrafficPanel } from "./components/TrafficPanel.js";
import { AgentPanel } from "./components/AgentPanel.js";
import { KnowledgePanel } from "./components/KnowledgePanel.js";
import { GraphModal } from "./components/GraphModal.js";

export function App() {
  const { caseId, connectWs } = useStore();
  useEffect(() => { connectWs(); }, [connectWs]);

  if (!caseId) {
    return (
      <div className="tf-center">
        <div className="tf-card">
          <h2>TraceForge 工作台</h2>
          <p className="tf-sub">选择或新建一个 Case 开始。</p>
          <TopBar />
        </div>
      </div>
    );
  }

  return (
    <div className="tf-app">
      <TopBar />
      <div className="tf-cols">
        <div className="tf-col tf-col-left">
          <BrowserPanel />
          <TrafficPanel />
        </div>
        <div className="tf-col"><AgentPanel /></div>
        <div className="tf-col"><KnowledgePanel /></div>
      </div>
      <GraphModal />
    </div>
  );
}
