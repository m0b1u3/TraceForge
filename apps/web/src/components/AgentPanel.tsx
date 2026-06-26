import { useState } from "react";
import { Sparkle, PaperPlaneTilt, ShieldWarning, Globe } from "@phosphor-icons/react";
import { useStore } from "../store.js";
import { runAgent, resolveApproval, approveScope } from "../api.js";

export function AgentPanel() {
  const { caseId, agentEvents, pendingApproval, pendingScope, setPendingScope, clearPendingApproval, resetAgent } = useStore();
  const [goal, setGoal] = useState("看一下已抓的流量，把发现的接口记录为 Fact。");
  const [busy, setBusy] = useState<"approved" | "rejected" | null>(null);
  if (!caseId) return null;

  const decide = async (decision: "approved" | "rejected") => {
    if (!pendingApproval) return;
    setBusy(decision);
    try { await resolveApproval(pendingApproval.approvalId, decision); } catch { /* 忽略，下方仍清卡 */ }
    clearPendingApproval();
    setBusy(null);
  };

  const send = () => { if (!goal.trim()) return; resetAgent(); runAgent(caseId, goal); setGoal(""); };

  return (
    <main className="panel chat-panel">
      <div className="panel-header">
        <div><span className="section-kicker">Agent</span><h2>Run Console</h2></div>
        <div className="session-state"><Sparkle size={14} /> autonomous</div>
      </div>
      <section className="messages">
        {pendingApproval && (
          <div className="tf-confirm tf-confirm-warn">
            <div className="tf-confirm-head"><ShieldWarning size={15} weight="fill" /> 需要你确认</div>
            <div className="tf-confirm-body">Agent 请求执行一个高风险动作：</div>
            <code className="tf-confirm-code">{pendingApproval.tool}({pendingApproval.input})</code>
            <div className="tf-confirm-actions">
              <button className="tf-btn tf-btn-accent" disabled={busy !== null} onClick={() => decide("approved")}>{busy === "approved" ? "批准中…" : "批准执行"}</button>
              <button className="tf-btn" disabled={busy !== null} onClick={() => decide("rejected")}>拒绝</button>
            </div>
          </div>
        )}
        {pendingScope && (
          <div className="tf-confirm tf-confirm-info">
            <div className="tf-confirm-head"><Globe size={15} weight="fill" /> 授权范围扩展请求</div>
            <div className="tf-confirm-body">Agent 建议把 <code className="tf-confirm-inline">{pendingScope.host}</code> 纳入授权范围。</div>
            <div className="tf-confirm-reason">{pendingScope.reason}</div>
            <div className="tf-confirm-actions">
              <button className="tf-btn tf-btn-accent" onClick={() => { approveScope(caseId, pendingScope.host); setPendingScope(null); }}>批准纳入</button>
              <button className="tf-btn" onClick={() => setPendingScope(null)}>忽略</button>
            </div>
          </div>
        )}
        {agentEvents.length === 0 && !pendingScope && (
          <div className="tf-guide">
            <div className="tf-guide-icon"><Sparkle size={22} weight="duotone" /></div>
            <div className="tf-guide-title">Agent 待命</div>
            <div className="tf-guide-hint">在下方输入一个目标（如「测试 example.com 的登录接口有没有越权」），Agent 会自主探索并把发现记录为 Fact。</div>
          </div>
        )}
        {agentEvents.map((e, i) => (
          <div className={`message ${e.kind === "error" ? "trace" : "agent"}`} key={i}>
            <span>{e.kind}</span><p>{e.text}</p>
          </div>
        ))}
      </section>
      <div className="composer">
        <input
          value={goal} onChange={(e) => setGoal(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") send(); }}
          placeholder="给 agent 一个目标…"
        />
        <button disabled={!goal.trim()} onClick={send}><PaperPlaneTilt size={15} weight="fill" /></button>
      </div>
    </main>
  );
}
