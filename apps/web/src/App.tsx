import { useEffect } from "react";
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
      <div className="app-shell hero-shell">
        <div className="hero-inner">
          <div className="hero-text">
            <div className="hero-brand"><span className="hero-dot" />TRACEFORGE</div>
            <h1 className="hero-title">漏洞挖掘<br />智能体工作台</h1>
            <p className="hero-sub">让 AI 像有经验的红队搭档一样自主探索、记录证据、持续推理。你随时介入、把关方向，每一步都有依据。</p>
            <div className="hero-feats">
              <span>人机共享浏览器</span><span className="hero-sep" />
              <span>证据驱动 Agent</span><span className="hero-sep" />
              <span>可回溯证据图谱</span>
            </div>
          </div>
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
