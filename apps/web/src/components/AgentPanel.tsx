import { useState } from "react";
import { Sparkle, PaperPlaneTilt, Wrench, ArrowBendDownRight, CheckCircle, WarningCircle, Flag, ChatText } from "@phosphor-icons/react";
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
  const { caseId, agentEvents, pendingApproval, pendingScope, setPendingScope, resetAgent } = useStore();
  const [goal, setGoal] = useState("看一下已抓的流量，把发现的接口记录为 Fact。");
  if (!caseId) return null;
  return (
    <div className="tf-panel" style={{ height: "100%" }}>
      <div className="tf-panel-head"><Sparkle size={13} weight="bold" style={{ opacity: 0.6 }} /> Agent 对话 <span className="tf-count">{agentEvents.length} events</span></div>
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
        {pendingScope && caseId && (
          <div className="tf-approval">
            <div className="tf-approval-h">授权范围扩展请求</div>
            <div>agent 建议把 <code>{pendingScope.host}</code> 纳入授权范围。</div>
            <div style={{ color: "var(--tf-muted)", marginTop: 4 }}>{pendingScope.reason}</div>
            <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
              <button className="tf-btn tf-btn-accent" onClick={() => { approveScope(caseId, pendingScope.host); }}>批准纳入</button>
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
