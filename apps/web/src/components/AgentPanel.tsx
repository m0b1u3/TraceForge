import { useEffect, useRef, useState } from "react";
import { Sparkle, PaperPlaneTilt, ShieldWarning, Globe, CircleNotch } from "@phosphor-icons/react";
import { useStore } from "../store.js";
import { Button } from "@/components/ui/button";
import {
  Alert,
  AlertTitle,
  AlertDescription,
} from "@/components/ui/alert";
import type { AgentRun } from "@traceforge/shared";
import { runAgent, resolveApproval, approveScope, steerAgentRun, interruptAgentRun } from "../api.js";
import { AgentEventRow } from "./agent/AgentEventRow.js";
import { buildAgentConversationItems } from "./agent/agent-conversation.js";

export { buildAgentConversationItems, type AgentConversationItem } from "./agent/agent-conversation.js";

export function scopeApprovalContinuationGoal(host: string): string {
  return `Approved ${host}. Continue testing this target. Start the shared browser and visit the homepage, record real observations, and do not fabricate conclusions.`;
}

export function scopeApprovalContinuationEventText(host: string, isSteering: boolean): string {
  const goal = scopeApprovalContinuationGoal(host);
  return isSteering ? `[steering] ${goal}` : goal;
}

export function shouldStickToBottomAfterUpdate(el: Pick<HTMLElement, "scrollTop" | "clientHeight" | "scrollHeight">): boolean {
  const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
  return distanceFromBottom <= 80;
}

export function isStopButtonDisabled(stopping: boolean, status: AgentRun["status"]): boolean {
  return stopping || (status !== "queued" && status !== "running");
}

export function canClearAgentConversation(agentBusy: boolean, hasActiveRun: boolean): boolean {
  return !agentBusy && !hasActiveRun;
}

export function canSubmitAgentInstruction(goal: string, agentBusy: boolean, hasActiveRun: boolean): boolean {
  return goal.trim().length > 0 && (!agentBusy || hasActiveRun);
}

export function AgentPanel() {
  const {
    caseId, agentEvents, agentBusy, setAgentBusy, showToast, pendingApproval,
    pendingScope, setPendingScope, clearPendingApproval, resetAgent, addAgentEvent,
    activeRun, setActiveRun, tokenUsage,
  } = useStore();
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState<"approved" | "rejected" | null>(null);
  const [stopping, setStopping] = useState(false);
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
    if (!canSubmitAgentInstruction(goal, agentBusy, Boolean(activeRun))) return;
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
    if (!activeRun || stopping) return;
    setStopping(true);
    try {
      const run = await interruptAgentRun(activeRun.id, "User stopped");
      setActiveRun(run);
    } catch (e) {
      showToast((e as Error).message);
    } finally {
      setStopping(false);
    }
  };

  return (
    <main className="panel chat-panel">
      <div className="panel-header">
        <div><span className="section-kicker">Agent</span><h2>Run Console</h2></div>
        <div className="panel-header-actions">
          {agentEvents.length > 0 && (
            <button
              className="tf-btn tf-btn-ghost"
              disabled={!canClearAgentConversation(agentBusy, Boolean(activeRun))}
              onClick={resetAgent}
              title={activeRun || agentBusy ? "Stop or finish the active run before clearing" : "Clear conversation"}
            >
              Clear
            </button>
          )}
          <div className="session-state token-stats" title="Cumulative LLM token usage for this run">
            Tokens {tokenUsage.totalTokens.toLocaleString()} ({tokenUsage.promptTokens.toLocaleString()} in / {tokenUsage.completionTokens.toLocaleString()} out)
          </div>
          <div className="session-state"><Sparkle size={14} /> autonomous</div>
        </div>
      </div>
      <section
        className="messages"
        role="log"
        aria-live="polite"
        aria-label="Agent conversation"
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
              <Alert key={item.key} variant="warning" className="mx-4 mt-3">
                <ShieldWarning size={15} weight="fill" />
                <AlertTitle>Confirm action</AlertTitle>
                <AlertDescription className="w-full">
                  <span>The agent wants to run a high-risk tool.</span>
                  <code className="mt-2 block rounded-md border bg-muted px-2 py-1.5 font-mono text-xs break-all">
                    {pendingApproval.tool}({pendingApproval.input})
                  </code>
                  <div className="mt-3 flex gap-2">
                    <Button
                      size="sm"
                      disabled={busy !== null}
                      onClick={() => decide("approved")}
                    >
                      {busy === "approved" ? "Approving..." : "Approve"}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy !== null}
                      onClick={() => decide("rejected")}
                    >
                      Reject
                    </Button>
                  </div>
                </AlertDescription>
              </Alert>
            );
          }
          if (item.type === "scope" && pendingScope) {
            return (
              <Alert key={item.key} variant="info" className="mx-4 mt-3">
                <Globe size={15} weight="fill" />
                <AlertTitle>Scope expansion</AlertTitle>
                <AlertDescription className="w-full">
                  <span>
                    Approve adding <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{pendingScope.host}</code> to the authorized scope.
                  </span>
                  <span className="text-muted-foreground">{pendingScope.reason}</span>
                  <div className="mt-3 flex gap-2">
                    <Button size="sm" onClick={approveScopeNow}>Approve</Button>
                    <Button type="button" variant="outline" size="sm" onClick={() => setPendingScope(null)}>Ignore</Button>
                  </div>
                </AlertDescription>
              </Alert>
            );
          }
          if (item.type === "busy") {
            return <div className="tf-agent-busy" role="status" key={item.key}><CircleNotch size={14} className="tf-spin" /> Agent is running…</div>;
          }
          if (item.type === "event") {
            return <AgentEventRow item={item} key={item.key} />;
          }
          return null;
        })}
      </section>
      <div className="composer">
        <textarea
          rows={1} value={goal} onChange={(e) => setGoal(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
          disabled={agentBusy && !activeRun}
          placeholder={activeRun ? "Add steering instruction…" : agentBusy ? "Agent is running…" : "Send a message…"}
        />
        {activeRun && (
          <button
            className="tf-btn tf-btn-danger"
            type="button"
            disabled={isStopButtonDisabled(stopping, activeRun.status)}
            onClick={stopRun}
          >
            Stop
          </button>
        )}
        <button
          className="tf-btn tf-btn-primary"
          type="button"
          aria-label={activeRun ? "Send steering instruction" : "Start agent run"}
          title={activeRun ? "Send steering instruction" : "Start agent run"}
          disabled={!canSubmitAgentInstruction(goal, agentBusy, Boolean(activeRun))}
          onClick={send}
        >
          {agentBusy ? <CircleNotch size={15} className="tf-spin" /> : <PaperPlaneTilt size={15} weight="fill" />}
        </button>
      </div>
    </main>
  );
}
