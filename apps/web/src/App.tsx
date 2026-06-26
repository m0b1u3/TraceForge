import { useEffect } from "react";
import { ShieldCheck } from "@phosphor-icons/react";
import { useStore } from "./store.js";
import { TopBar } from "./components/TopBar.js";
import { CaseLauncher } from "./components/CaseLauncher.js";
import { TrafficPanel } from "./components/TrafficPanel.js";
import { AgentPanel } from "./components/AgentPanel.js";
import { KnowledgePanel } from "./components/KnowledgePanel.js";
import { GraphModal } from "./components/GraphModal.js";

export function App() {
  const { caseId, connectWs } = useStore();
  useEffect(() => { connectWs(); }, [connectWs]);

  if (!caseId) {
    return (
      <div className="app-shell" style={{ placeItems: "center" }}>
        <div className="onboard">
          <div className="brand"><span><ShieldCheck size={16} /></span><div><strong>TraceForge</strong><small>授权红队工作台</small></div></div>
          <h1 className="onboard-title">漏洞挖掘智能体工作台</h1>
          <p className="onboard-sub">让 AI 像有经验的红队搭档一样自主探索、记录证据、持续推理。你随时介入、把关方向。</p>
          <CaseLauncher variant="hero" />
        </div>
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
    </div>
  );
}
