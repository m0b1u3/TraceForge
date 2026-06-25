import { useEffect } from "react";
import { useStore } from "./store.js";
import { TopBar } from "./components/TopBar.js";

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
          <div className="tf-panel"><div className="tf-panel-head">共享浏览器</div></div>
          <div className="tf-panel"><div className="tf-panel-head">流量</div></div>
        </div>
        <div className="tf-col"><div className="tf-panel-head">Agent 对话</div></div>
        <div className="tf-col"><div className="tf-panel-head">知识</div></div>
      </div>
    </div>
  );
}
