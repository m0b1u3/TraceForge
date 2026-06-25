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
        <div className="tf-card" style={{ maxWidth: 460 }}>
          <h2>TraceForge 漏洞挖掘工作台</h2>
          <p className="tf-sub">证据驱动、人机协同的红队推理底座。新建或选择一个 Case 开始。</p>
          <div className="tf-steps">
            <div className="tf-step"><span className="tf-step-n">1</span><span><b>新建 Case</b> — 只需取个名字。授权范围留空，稍后在对话中按需纳入。</span></div>
            <div className="tf-step"><span className="tf-step-n">2</span><span><b>给 Agent 一个目标</b> — 用自然语言描述要测什么。Agent 会自主探索；越界访问会请你确认授权范围。</span></div>
            <div className="tf-step"><span className="tf-step-n">3</span><span><b>观察与介入</b> — 右栏实时看 Facts / Tasks / 图谱 / Observer 提示；可随时接管共享浏览器。</span></div>
          </div>
          <div style={{ borderTop: "1px solid var(--tf-border-soft)", paddingTop: 14 }}>
            <TopBar />
          </div>
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
