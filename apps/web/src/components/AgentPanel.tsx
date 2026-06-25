import { useState } from "react";
import { Sparkle, PaperPlaneTilt, Wrench, ArrowBendDownRight, CheckCircle, WarningCircle, Flag, ChatText, ShieldWarning, Globe } from "@phosphor-icons/react";
import { useStore } from "../store.js";
import { runAgent, resolveApproval, approveScope } from "../api.js";

function EvIcon({ kind }: { kind: string }) {
  if (kind === "tool_call") return <Wrench size={13} weight="bold" />;
  if (kind === "tool_result") return <ArrowBendDownRight size={13} weight="bold" />;
  if (kind === "error") return <WarningCircle size={14} weight="fill" />;
  if (kind === "done") return <CheckCircle size={14} weight="fill" />;
  if (kind === "started") return <Flag size={13} weight="fill" />;
  return <ChatText size={13} weight="bold" />;
}

function EventItem({ kind, text }: { kind: string; text: string }) {
  // tool_call 文本形如 "tool(arg...)"
  const cls = kind === "tool_call" ? "tf-ev-tool" : kind === "tool_result" ? "tf-ev-result" : `tf-ev-${kind}`;
  if (kind === "tool_call") {
    const m = text.match(/^([^(]+)\((.*)\)$/s);
    const name = m ? m[1] : text;
    const arg = m ? m[2] : "";
    return (
      <div className={`tf-ev ${cls}`}>
        <span className="tf-ev-ico"><EvIcon kind={kind} /></span>
        <span className="tf-ev-body"><span className="tf-ev-name">{name}</span>{arg && <span className="tf-ev-arg">{arg}</span>}</span>
      </div>
    );
  }
  return (
    <div className={`tf-ev ${cls}`}>
      <span className="tf-ev-ico"><EvIcon kind={kind} /></span>
      <span className="tf-ev-body"><span className="tf-ev-text">{text}</span></span>
    </div>
  );
}

export function AgentPanel() {
  const { caseId, agentEvents, pendingApproval, pendingScope, setPendingScope, clearPendingApproval, resetAgent } = useStore();
  const [goal, setGoal] = useState("看一下已抓的流量，把发现的接口记录为 Fact。");
  const [busy, setBusy] = useState<"approved" | "rejected" | null>(null);
  if (!caseId) return null;

  const decide = async (decision: "approved" | "rejected") => {
    if (!pendingApproval) return;
    setBusy(decision);
    try { await resolveApproval(pendingApproval.approvalId, decision); } catch { /* 忽略，下方仍清卡 */ }
    clearPendingApproval();   // 乐观清除，不依赖 WS 回执
    setBusy(null);
  };
  return (
    <div className="tf-panel" style={{ height: "100%" }}>
      <div className="tf-panel-head"><Sparkle size={13} weight="bold" style={{ opacity: 0.6 }} /> Agent 对话 <span className="tf-count">{agentEvents.length} events</span></div>
      <div className="tf-panel-body">
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
        {pendingScope && caseId && (
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
            <div className="tf-guide-step">↓ 在下方输入目标后回车</div>
          </div>
        )}
        {agentEvents.map((e, i) => <EventItem key={i} kind={e.kind} text={e.text} />)}
      </div>
      <div className="tf-panel-foot">
        <input
          className="tf-input" style={{ flex: 1 }} value={goal}
          onChange={(e) => setGoal(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && goal.trim()) { resetAgent(); runAgent(caseId, goal); setGoal(""); } }}
          placeholder="给 agent 一个目标…"
        />
        <button
          className="tf-btn tf-btn-accent tf-btn-icon"
          disabled={!goal.trim()}
          onClick={() => { if (!goal.trim()) return; resetAgent(); runAgent(caseId, goal); setGoal(""); }}
        ><PaperPlaneTilt size={14} weight="fill" /> 启动</button>
      </div>
    </div>
  );
}
