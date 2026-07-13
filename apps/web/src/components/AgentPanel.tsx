import { useEffect, useRef, useState } from "react";
import { Sparkle, PaperPlaneTilt, CircleNotch } from "@phosphor-icons/react";
import { useStore } from "../store.js";
import type { AgentRun } from "@traceforge/shared";
import { runAgent, resolveApproval, approveScope, rejectScope, steerAgentRun, interruptAgentRun } from "../api.js";
import { AgentEventRow } from "./agent/AgentEventRow.js";
import { buildAgentConversationItems } from "./agent/agent-conversation.js";
import {
  ApprovalInterventionCard,
  RunContinuationCard,
  ScopeInterventionCard,
  type InterventionAction,
} from "./agent/AgentInterventionCard.js";

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

export function runContinuationGoal(run: Pick<AgentRun, "goal">): string {
  return `Continue the previous run toward the same objective: ${run.goal}\nResume from the existing conversation, evidence, tasks, and prior tool results. Do not restart work that is already complete.`;
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
    pendingScope, clearPendingScope, clearPendingApproval, resetAgent, addAgentEvent,
    activeRun, setActiveRun, continuationRun, setContinuationRun, tokenUsage,
  } = useStore();
  const [goal, setGoal] = useState("");
  const [interventionAction, setInterventionAction] = useState<InterventionAction>(null);
  const [interventionError, setInterventionError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const messagesRef = useRef<HTMLElement | null>(null);
  const shouldAutoScrollRef = useRef(true);
  const conversationItems = buildAgentConversationItems({ events: agentEvents, pendingApproval, pendingScope, agentBusy });
  const latestAgentText = agentEvents.at(-1)?.text;

  useEffect(() => {
    setInterventionAction(null);
    setInterventionError(null);
  }, [pendingApproval?.approvalId, pendingScope?.host]);

  useEffect(() => {
    const el = messagesRef.current;
    if (el && shouldAutoScrollRef.current) el.scrollTop = el.scrollHeight;
  }, [conversationItems.length, latestAgentText]);

  if (!caseId) return null;

  const decide = async (decision: "approved" | "rejected") => {
    if (!pendingApproval) return;
    const approval = pendingApproval;
    setInterventionAction(decision === "approved" ? "approval-approved" : "approval-rejected");
    setInterventionError(null);
    try {
      await resolveApproval(approval.approvalId, decision);
      const text = `Approval ${decision}: ${approval.tool}`;
      if (useStore.getState().agentEvents.at(-1)?.text !== text) addAgentEvent({ kind: "done", text });
      clearPendingApproval(approval.approvalId);
    } catch (e) {
      const message = (e as Error).message;
      setInterventionError(message);
      showToast(message);
    } finally {
      setInterventionAction(null);
    }
  };

  const approveScopeNow = async () => {
    if (!pendingScope) return;
    const scope = pendingScope;
    const host = scope.host;
    const continuation = scopeApprovalContinuationGoal(host);
    setInterventionAction("scope-approved");
    setInterventionError(null);
    try {
      await approveScope(caseId, host);
      const text = `Scope approved: ${host}`;
      if (useStore.getState().agentEvents.at(-1)?.text !== text) addAgentEvent({ kind: "done", text });
      clearPendingScope(host);
    } catch (e) {
      const message = (e as Error).message;
      setInterventionError(message);
      showToast(message);
      setInterventionAction(null);
      return;
    }

    try {
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
      setContinuationRun(null);
    }
    catch (e) {
      const message = (e as Error).message;
      addAgentEvent({ kind: "error", text: `Scope was approved, but the Agent could not continue: ${message}` });
      showToast(message);
      if (!activeRun) setAgentBusy(false);
    } finally {
      setInterventionAction(null);
    }
  };

  const rejectScopeNow = async () => {
    if (!pendingScope) return;
    const scope = pendingScope;
    setInterventionAction("scope-rejected");
    setInterventionError(null);
    try {
      await rejectScope(caseId, scope.host);
      const text = `Scope kept blocked: ${scope.host}`;
      if (useStore.getState().agentEvents.at(-1)?.text !== text) addAgentEvent({ kind: "done", text });
      clearPendingScope(scope.host);
    } catch (e) {
      const message = (e as Error).message;
      setInterventionError(message);
      showToast(message);
    } finally {
      setInterventionAction(null);
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
      setContinuationRun(null);
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

  const continueRun = async () => {
    if (!continuationRun || activeRun || agentBusy || continuing) return;
    const previousRun = continuationRun;
    const continuation = runContinuationGoal(previousRun);
    setContinuing(true);
    setAgentBusy(true);
    shouldAutoScrollRef.current = true;
    addAgentEvent({ kind: "user", text: `[continue] ${previousRun.goal}` });
    try {
      const run = await runAgent(caseId, continuation);
      setActiveRun(run);
      setContinuationRun(null);
    } catch (e) {
      const message = (e as Error).message;
      addAgentEvent({ kind: "error", text: `Could not continue the run: ${message}` });
      showToast(message);
      setAgentBusy(false);
    } finally {
      setContinuing(false);
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
            Tokens {tokenUsage.totalTokens.toLocaleString()}
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
              <ApprovalInterventionCard
                key={item.key}
                tool={pendingApproval.tool}
                input={pendingApproval.input}
                action={interventionAction}
                error={interventionError}
                onApprove={() => decide("approved")}
                onReject={() => decide("rejected")}
              />
            );
          }
          if (item.type === "scope" && pendingScope) {
            return (
              <ScopeInterventionCard
                key={item.key}
                host={pendingScope.host}
                reason={pendingScope.reason}
                action={interventionAction}
                error={interventionError}
                onApprove={approveScopeNow}
                onReject={rejectScopeNow}
              />
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
        {continuationRun && !activeRun && (
          <RunContinuationCard
            goal={continuationRun.goal}
            busy={continuing || agentBusy}
            onContinue={continueRun}
          />
        )}
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
