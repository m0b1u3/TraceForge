import { useState } from "react";
import { Sparkle, PaperPlaneTilt, ShieldWarning, Globe, CircleNotch } from "@phosphor-icons/react";
import { useStore } from "../store.js";
import { runAgent, resolveApproval, approveScope } from "../api.js";

export function AgentPanel() {
  const { caseId, agentEvents, agentBusy, setAgentBusy, showToast, pendingApproval, pendingScope, setPendingScope, clearPendingApproval, resetAgent, addAgentEvent } = useStore();
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState<"approved" | "rejected" | null>(null);
  if (!caseId) return null;

  const decide = async (decision: "approved" | "rejected") => {
    if (!pendingApproval) return;
    setBusy(decision);
    try { await resolveApproval(pendingApproval.approvalId, decision); }
    catch (e) { showToast((e as Error).message); }
    clearPendingApproval();
    setBusy(null);
  };

  const approveScopeNow = async () => {
    if (!pendingScope) return;
    const host = pendingScope.host;
    setPendingScope(null); // 乐观清卡
    try { await approveScope(caseId, host); }
    catch (e) { showToast((e as Error).message); }
  };

  // 累积保留对话/事件，不在每次发送时清空（历史可往上翻看）；并发运行时禁止再发
  const send = async () => {
    if (!goal.trim() || agentBusy) return;
    const g = goal.trim();
    addAgentEvent({ kind: "user", text: g });
    setGoal("");
    setAgentBusy(true); // 立即置忙（不等 WS agent_started 回来），失败时回滚
    try { await runAgent(caseId, g); }
    catch (e) { showToast((e as Error).message); setAgentBusy(false); }
  };

  return (
    <main className="panel chat-panel">
      <div className="panel-header">
        <div><span className="section-kicker">Agent</span><h2>Run Console</h2></div>
        <div className="panel-header-actions">
          {agentEvents.length > 0 && (
            <button className="tf-btn tf-btn-ghost" onClick={resetAgent} title="清空对话记录">清空</button>
          )}
          <div className="session-state"><Sparkle size={14} /> autonomous</div>
        </div>
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
              <button className="tf-btn tf-btn-accent" onClick={approveScopeNow}>批准纳入</button>
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
          <div className={`message ${e.kind === "user" ? "operator" : e.kind === "error" ? "trace" : "agent"}`} key={i}>
            <span>{e.kind === "user" ? "你" : e.kind}</span><p>{e.text}</p>
          </div>
        ))}
        {agentBusy && (
          <div className="tf-agent-busy"><CircleNotch size={14} className="tf-spin" /> Agent 运行中…</div>
        )}
      </section>
      <div className="composer">
        <textarea
          rows={1} value={goal} onChange={(e) => setGoal(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder={agentBusy ? "Agent 运行中，请稍候…" : "给 agent 一个目标（Enter 发送，Shift+Enter 换行）…"}
        />
        <button disabled={!goal.trim() || agentBusy} onClick={send}>
          {agentBusy ? <CircleNotch size={15} className="tf-spin" /> : <PaperPlaneTilt size={15} weight="fill" />}
        </button>
      </div>
    </main>
  );
}
