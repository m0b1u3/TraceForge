import { useState } from "react";
import { useStore } from "../store.js";
import { runAgent, resolveApproval } from "../api.js";

export function AgentPanel() {
  const { caseId, agentEvents, pendingApproval, resetAgent } = useStore();
  const [goal, setGoal] = useState("看一下已抓的流量，把发现的接口记录为 Fact。");
  if (!caseId) return null;
  return (
    <div className="tf-panel" style={{ height: "100%" }}>
      <div className="tf-panel-head">Agent 对话 <span className="tf-count">{agentEvents.length} events</span></div>
      <div className="tf-panel-body">
        {pendingApproval && (
          <div className="tf-approval">
            <div className="tf-approval-h">需要确认</div>
            <code>{pendingApproval.tool}({pendingApproval.input})</code>
            <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
              <button className="tf-btn tf-btn-accent" onClick={() => resolveApproval(pendingApproval.approvalId, "approved")}>批准</button>
              <button className="tf-btn" onClick={() => resolveApproval(pendingApproval.approvalId, "rejected")}>拒绝</button>
            </div>
          </div>
        )}
        {agentEvents.length === 0 && <div className="tf-empty">给 agent 一个目标并启动，活动会在这里实时显示。</div>}
        {agentEvents.map((e, i) => (
          <div className={`tf-ev tf-ev-${e.kind}`} key={i}>
            <span className="tf-ev-kind">{e.kind}</span>{e.text}
          </div>
        ))}
      </div>
      <div className="tf-panel-foot">
        <input className="tf-input" style={{ flex: 1 }} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="给 agent 一个目标…" />
        <button className="tf-btn tf-btn-accent" onClick={() => { resetAgent(); runAgent(caseId, goal); }}>启动 Agent</button>
      </div>
    </div>
  );
}
