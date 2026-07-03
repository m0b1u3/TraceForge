import { useEffect, useRef, useState } from "react";
import { Sparkle, PaperPlaneTilt, ShieldWarning, Globe, CircleNotch } from "@phosphor-icons/react";
import { useStore } from "../store.js";
import type { AgentUiEvent } from "../store.js";
import { runAgent, resolveApproval, approveScope, steerAgentRun, interruptAgentRun } from "../api.js";

export function scopeApprovalContinuationGoal(host: string): string {
  return `已批准将 ${host} 纳入授权范围。请继续测试该目标，优先启动共享浏览器并访问目标首页，记录真实观察结果，不要编造结论。`;
}

export function scopeApprovalContinuationEventText(host: string, isSteering: boolean): string {
  const goal = scopeApprovalContinuationGoal(host);
  return isSteering ? `[steering] ${goal}` : goal;
}

type PendingApproval = { approvalId: string; tool: string; input: string };
type PendingScope = { host: string; reason: string };

export type AgentConversationItem =
  | { type: "event"; key: string; kind: AgentUiEvent["kind"]; label: string; text: string }
  | { type: "approval"; key: string }
  | { type: "scope"; key: string }
  | { type: "busy"; key: string };

export function buildAgentConversationItems({
  events,
  pendingApproval,
  pendingScope,
  agentBusy,
}: {
  events: AgentUiEvent[];
  pendingApproval: PendingApproval | null;
  pendingScope: PendingScope | null;
  agentBusy: boolean;
}): AgentConversationItem[] {
  const items: AgentConversationItem[] = [];
  let lastVisible: { kind: AgentUiEvent["kind"]; text: string } | null = null;

  events.forEach((event, index) => {
    const display = formatAgentEvent(event);
    if (!display) return;
    if (lastVisible?.kind === display.kind && lastVisible.text === display.text) return;
    if (display.kind === "done" && lastVisible?.kind === "text" && lastVisible.text === display.text) return;
    items.push({ type: "event", key: `event-${index}`, ...display });
    lastVisible = { kind: display.kind, text: display.text };
  });

  if (pendingApproval) items.push({ type: "approval", key: `approval-${pendingApproval.approvalId}` });
  if (pendingScope) items.push({ type: "scope", key: `scope-${pendingScope.host}` });
  if (agentBusy) items.push({ type: "busy", key: "agent-busy" });
  return items;
}

function formatAgentEvent(event: AgentUiEvent): { kind: AgentUiEvent["kind"]; label: string; text: string } | null {
  const text = event.text.trim();
  if (!text || event.kind === "started") return null;
  if (event.kind === "user") return { kind: event.kind, label: "你", text };
  if (event.kind === "error") return { kind: event.kind, label: "错误", text };
  if (event.kind === "tool_call") return { kind: event.kind, label: "工具调用", text: compactToolText(text) };
  if (event.kind === "tool_result") return { kind: event.kind, label: "工具结果", text: compactToolText(text) };
  if (event.kind === "done") return { kind: event.kind, label: "结果", text };
  return { kind: event.kind, label: "Agent", text };
}

function compactToolText(text: string): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length > 180 ? `${singleLine.slice(0, 177)}...` : singleLine;
}

export function AgentPanel() {
  const {
    caseId, agentEvents, agentBusy, setAgentBusy, showToast, pendingApproval,
    pendingScope, setPendingScope, clearPendingApproval, resetAgent, addAgentEvent,
    activeRun, setActiveRun,
  } = useStore();
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState<"approved" | "rejected" | null>(null);
  const messagesRef = useRef<HTMLElement | null>(null);
  const conversationItems = buildAgentConversationItems({ events: agentEvents, pendingApproval, pendingScope, agentBusy });
  const latestAgentText = agentEvents.at(-1)?.text;

  useEffect(() => {
    const el = messagesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [conversationItems.length, latestAgentText]);

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
    const continuation = scopeApprovalContinuationGoal(host);
    setPendingScope(null); // 乐观清卡
    try {
      await approveScope(caseId, host);
      if (activeRun) {
        addAgentEvent({ kind: "user", text: scopeApprovalContinuationEventText(host, true) });
        const run = await steerAgentRun(activeRun.id, continuation);
        setActiveRun(run);
        return;
      }
      addAgentEvent({ kind: "user", text: scopeApprovalContinuationEventText(host, false) });
      setAgentBusy(true);
      const run = await runAgent(caseId, continuation);
      setActiveRun(run);
    }
    catch (e) {
      showToast((e as Error).message);
      if (!activeRun) setAgentBusy(false);
    }
  };

  // 累积保留对话/事件，不在每次发送时清空（历史可往上翻看）；并发运行时禁止再发
  const send = async () => {
    if (!goal.trim()) return;
    const g = goal.trim();
    setGoal("");
    try {
      if (activeRun) {
        addAgentEvent({ kind: "user", text: `[steering] ${g}` });
        const run = await steerAgentRun(activeRun.id, g);
        setActiveRun(run);
        return;
      }
      addAgentEvent({ kind: "user", text: g });
      setAgentBusy(true); // 立即置忙（不等 WS agent_started 回来），失败时回滚
      const run = await runAgent(caseId, g);
      setActiveRun(run);
    }
    catch (e) {
      showToast((e as Error).message);
      if (!activeRun) setAgentBusy(false);
    }
  };

  const stopRun = async () => {
    if (!activeRun) return;
    try {
      const run = await interruptAgentRun(activeRun.id, "用户停止");
      setActiveRun(run);
    } catch (e) {
      showToast((e as Error).message);
    }
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
      <section className="messages" ref={messagesRef}>
        {conversationItems.length === 0 && (
          <div className="tf-guide">
            <div className="tf-guide-icon"><Sparkle size={22} weight="duotone" /></div>
            <div className="tf-guide-title">Agent 待命</div>
            <div className="tf-guide-hint">在下方输入一个目标（如「测试 example.com 的登录接口有没有越权」），Agent 会自主探索并把发现记录为 Fact。</div>
          </div>
        )}
        {conversationItems.map((item) => {
          if (item.type === "approval" && pendingApproval) {
            return (
              <div className="tf-confirm tf-confirm-warn" key={item.key}>
                <div className="tf-confirm-head"><ShieldWarning size={15} weight="fill" /> 需要你确认</div>
                <div className="tf-confirm-body">Agent 请求执行一个高风险动作：</div>
                <code className="tf-confirm-code">{pendingApproval.tool}({pendingApproval.input})</code>
                <div className="tf-confirm-actions">
                  <button className="tf-btn tf-btn-accent" disabled={busy !== null} onClick={() => decide("approved")}>{busy === "approved" ? "批准中…" : "批准执行"}</button>
                  <button className="tf-btn" disabled={busy !== null} onClick={() => decide("rejected")}>拒绝</button>
                </div>
              </div>
            );
          }
          if (item.type === "scope" && pendingScope) {
            return (
              <div className="tf-confirm tf-confirm-info" key={item.key}>
                <div className="tf-confirm-head"><Globe size={15} weight="fill" /> 授权范围扩展请求</div>
                <div className="tf-confirm-body">Agent 建议把 <code className="tf-confirm-inline">{pendingScope.host}</code> 纳入授权范围。</div>
                <div className="tf-confirm-reason">{pendingScope.reason}</div>
                <div className="tf-confirm-actions">
                  <button className="tf-btn tf-btn-accent" onClick={approveScopeNow}>批准纳入</button>
                  <button className="tf-btn" onClick={() => setPendingScope(null)}>忽略</button>
                </div>
              </div>
            );
          }
          if (item.type === "busy") {
            return <div className="tf-agent-busy" key={item.key}><CircleNotch size={14} className="tf-spin" /> Agent 运行中…</div>;
          }
          if (item.type === "event") {
            return (
              <div className={`message ${messageClassName(item.kind)}`} key={item.key}>
                <span>{item.label}</span><p>{item.text}</p>
              </div>
            );
          }
          return null;
        })}
      </section>
      <div className="composer">
        <textarea
          rows={1} value={goal} onChange={(e) => setGoal(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder={activeRun ? "给当前 run 补充指令（Enter 发送）…" : agentBusy ? "Agent 运行中，请稍候…" : "给 agent 一个目标（Enter 发送，Shift+Enter 换行）…"}
        />
        {activeRun && (
          <button className="tf-btn" type="button" onClick={stopRun}>
            停止
          </button>
        )}
        <button disabled={!goal.trim()} onClick={send}>
          {agentBusy ? <CircleNotch size={15} className="tf-spin" /> : <PaperPlaneTilt size={15} weight="fill" />}
        </button>
      </div>
    </main>
  );
}

function messageClassName(kind: AgentUiEvent["kind"]): string {
  if (kind === "user") return "operator";
  if (kind === "error") return "trace";
  if (kind === "tool_call" || kind === "tool_result") return "tool";
  return "agent";
}
