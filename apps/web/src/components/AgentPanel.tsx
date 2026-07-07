import { useEffect, useRef, useState } from "react";
import { Sparkle, PaperPlaneTilt, ShieldWarning, Globe, CircleNotch } from "@phosphor-icons/react";
import { useStore } from "../store.js";
import type { AgentUiEvent } from "../store.js";
import { runAgent, resolveApproval, approveScope, steerAgentRun, interruptAgentRun } from "../api.js";

export function scopeApprovalContinuationGoal(host: string): string {
  return `Approved ${host}. Continue testing this target. Start the shared browser and visit the homepage, record real observations, and do not fabricate conclusions.`;
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
    if (isNoisyAgentEvent(event)) return;
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

export function shouldStickToBottomAfterUpdate(el: Pick<HTMLElement, "scrollTop" | "clientHeight" | "scrollHeight">): boolean {
  const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
  return distanceFromBottom <= 80;
}

function isNoisyAgentEvent(event: AgentUiEvent): boolean {
  const text = event.text.trim();
  if (!text) return true;
  if (event.kind === "started") return true;
  if (event.kind === "done") return text === "done" || text === "handled";
  if (event.kind === "tool_call") return /^list_traffic\s*\(\s*\{\s*\}\s*\)$/i.test(text);
  if (event.kind === "tool_result") return /^list_traffic\s*→\s*\(暂无流量\)$/i.test(text);
  return false;
}

function formatAgentEvent(event: AgentUiEvent): { kind: AgentUiEvent["kind"]; label: string; text: string } | null {
  const text = event.text.trim();
  if (!text || event.kind === "started") return null;
  if (event.kind === "user") return { kind: event.kind, label: "You", text };
  if (event.kind === "error") return { kind: event.kind, label: "Error", text };
  if (event.kind === "tool_call") return { kind: event.kind, label: "Tool", text: compactToolText(text) };
  if (event.kind === "tool_result") return { kind: event.kind, label: "Tool", text: compactToolText(text) };
  if (event.kind === "done") return { kind: event.kind, label: "Done", text };
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
  const shouldAutoScrollRef = useRef(true);
  const conversationItems = buildAgentConversationItems({ events: agentEvents, pendingApproval, pendingScope, agentBusy });
  const latestAgentText = agentEvents.at(-1)?.text;

  useEffect(() => {
    const el = messagesRef.current;
    if (el && shouldAutoScrollRef.current) el.scrollTop = el.scrollHeight;
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
    setPendingScope(null); // optimistically clear the card
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

  // Accumulate conversation/events; do not clear on each send so history can be scrolled; concurrent runs are blocked
  const send = async () => {
    if (!goal.trim()) return;
    const g = goal.trim();
    setGoal("");
    shouldAutoScrollRef.current = true;
    try {
      if (activeRun) {
        addAgentEvent({ kind: "user", text: `[steering] ${g}` });
        const run = await steerAgentRun(activeRun.id, g);
        setActiveRun(run);
        return;
      }
      addAgentEvent({ kind: "user", text: g });
      setAgentBusy(true); // set busy immediately (before WS agent_started arrives); roll back on failure
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
      const run = await interruptAgentRun(activeRun.id, "User stopped");
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
            <button className="tf-btn tf-btn-ghost" onClick={resetAgent} title="Clear conversation">Clear</button>
          )}
          <div className="session-state"><Sparkle size={14} /> autonomous</div>
        </div>
      </div>
      <section
        className="messages"
        ref={messagesRef}
        onScroll={(event) => {
          shouldAutoScrollRef.current = shouldStickToBottomAfterUpdate(event.currentTarget);
        }}
      >
        {conversationItems.length === 0 && (
          <div className="tf-guide">
            <div className="tf-guide-icon"><Sparkle size={22} weight="duotone" /></div>
            <div className="tf-guide-title">Agent is idle</div>
            <div className="tf-guide-hint">Give it a target, e.g. "test example.com/login for IDOR."</div>
          </div>
        )}
        {conversationItems.map((item) => {
          if (item.type === "approval" && pendingApproval) {
            return (
              <div className="tf-confirm tf-confirm-warn" key={item.key}>
                <div className="tf-confirm-head"><ShieldWarning size={15} weight="fill" /> Confirm action</div>
                <div className="tf-confirm-body">The agent wants to run a high-risk tool.</div>
                <code className="tf-confirm-code">{pendingApproval.tool}({pendingApproval.input})</code>
                <div className="tf-confirm-actions">
                  <button className="tf-btn tf-btn-primary" disabled={busy !== null} onClick={() => decide("approved")}>{busy === "approved" ? "Approving…" : "Approve"}</button>
                  <button className="tf-btn" disabled={busy !== null} onClick={() => decide("rejected")}>Reject</button>
                </div>
              </div>
            );
          }
          if (item.type === "scope" && pendingScope) {
            return (
              <div className="tf-confirm tf-confirm-info" key={item.key}>
                <div className="tf-confirm-head"><Globe size={15} weight="fill" /> Scope expansion</div>
                <div className="tf-confirm-body">Approve adding <code className="tf-confirm-inline">{pendingScope.host}</code> to the authorized scope.</div>
                <div className="tf-confirm-reason">{pendingScope.reason}</div>
                <div className="tf-confirm-actions">
                  <button className="tf-btn tf-btn-primary" onClick={approveScopeNow}>Approve</button>
                  <button className="tf-btn" onClick={() => setPendingScope(null)}>Ignore</button>
                </div>
              </div>
            );
          }
          if (item.type === "busy") {
            return <div className="tf-agent-busy" key={item.key}><CircleNotch size={14} className="tf-spin" /> Agent is running…</div>;
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
          placeholder={activeRun ? "Add steering instruction…" : agentBusy ? "Agent is running…" : "Send a message…"}
        />
        {activeRun && (
          <button className="tf-btn tf-btn-danger" type="button" onClick={stopRun}>
            Stop
          </button>
        )}
        <button className="tf-btn tf-btn-primary" disabled={!goal.trim()} onClick={send}>
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
