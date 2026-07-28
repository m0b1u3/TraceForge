import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, Broom, CircleNotch, PaperPlaneTilt, Play, Sparkle, Stop } from "@phosphor-icons/react";
import { useStore } from "../store.js";
import type { AgentEvent, AgentRun } from "@traceforge/shared";
import { runAgent, resolveApproval, approveScope, rejectScope, steerAgentRun, interruptAgentRun, listAgentEvents } from "../api.js";
import { AgentEventRow } from "./agent/AgentEventRow.js";
import { ValidationEventGroup } from "./agent/ValidationEventGroup.js";
import { buildAgentConversationItems, findAgentEventIndexByRef } from "./agent/agent-conversation.js";
import {
  ApprovalInterventionCard,
  RunContinuationCard,
  ScopeInterventionCard,
  type InterventionAction,
} from "./agent/AgentInterventionCard.js";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog.js";
import { RunTimelineRuler } from "./agent/RunTimelineRuler.js";
import { useShallow } from "zustand/react/shallow";
import { TokenUsageDialog } from "./agent/TokenUsageDialog.js";
import { useOlderHistory } from "../hooks/use-older-history.js";
import { AnimatePresence, m } from "motion/react";

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

export const AGENT_EVENT_PAGE_SIZE = 300;
const AGENT_HISTORY_PAGE_SIZE = 500;

export function getAgentEventPage(total: number, requestedEnd: number | null, size = AGENT_EVENT_PAGE_SIZE) {
  const end = requestedEnd === null ? total : Math.min(total, Math.max(0, requestedEnd));
  return {
    start: Math.max(0, end - size),
    end,
    latest: requestedEnd === null || end === total,
  };
}

export function AgentPanel() {
  const {
    caseId, agentEvents, agentBusy, setAgentBusy, showToast, pendingApproval,
    pendingScope, clearPendingScope, clearPendingApproval, resetAgent, addAgentEvent,
    activeRun, setActiveRun, continuationRun, setContinuationRun,
    facts,
  } = useStore(useShallow((state) => ({
    caseId: state.caseId, agentEvents: state.agentEvents, agentBusy: state.agentBusy, setAgentBusy: state.setAgentBusy,
    showToast: state.showToast, pendingApproval: state.pendingApproval, pendingScope: state.pendingScope,
    clearPendingScope: state.clearPendingScope, clearPendingApproval: state.clearPendingApproval,
    resetAgent: state.resetAgent, addAgentEvent: state.addAgentEvent, activeRun: state.activeRun,
    setActiveRun: state.setActiveRun, continuationRun: state.continuationRun,
    setContinuationRun: state.setContinuationRun,
    facts: state.facts,
  })));
  const [goal, setGoal] = useState("");
  const [interventionAction, setInterventionAction] = useState<InterventionAction>(null);
  const [interventionError, setInterventionError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const [runLauncherOpen, setRunLauncherOpen] = useState(false);
  const [showLatest, setShowLatest] = useState(false);
  const [eventPageEnd, setEventPageEnd] = useState<number | null>(null);
  const messagesRef = useRef<HTMLElement | null>(null);
  const shouldAutoScrollRef = useRef(true);
  const pendingJumpRef = useRef<number | null>(null);
  const liveHistoryEvents = useMemo(() => agentEvents.map((event, index) => ({ ...event, id: `live-${index}` })), [agentEvents]);
  const history = useOlderHistory<AgentEvent | (typeof liveHistoryEvents)[number]>({
    caseId,
    live: liveHistoryEvents,
    pageSize: AGENT_HISTORY_PAGE_SIZE,
    loadPage: (id, limit, offset) => listAgentEvents(id, { limit, offset }),
  });
  const allAgentEvents = useMemo(() => history.items.map(({ kind, text, tool, refs, createdAt }) => ({ kind, text, tool, refs: refs ?? null, createdAt })), [history.items]);
  const { start: pageStart, end: pageEnd, latest: latestPage } = getAgentEventPage(allAgentEvents.length, eventPageEnd);
  const pageEvents = useMemo(() => allAgentEvents.slice(pageStart, pageEnd), [allAgentEvents, pageEnd, pageStart]);
  const conversationItems = useMemo(() => buildAgentConversationItems({
    events: pageEvents,
    pendingApproval: latestPage ? pendingApproval : null,
    pendingScope: latestPage ? pendingScope : null,
    agentBusy: latestPage && agentBusy,
  }), [agentBusy, latestPage, pageEvents, pendingApproval, pendingScope]);
  const latestAgentText = pageEvents.at(-1)?.text;

  useEffect(() => {
    setInterventionAction(null);
    setInterventionError(null);
  }, [pendingApproval?.approvalId, pendingScope?.host]);

  useEffect(() => {
    const el = messagesRef.current;
    if (el && latestPage && shouldAutoScrollRef.current) el.scrollTop = el.scrollHeight;
  }, [conversationItems.length, latestAgentText, latestPage]);

  useLayoutEffect(() => {
    const el = messagesRef.current;
    if (el && !latestPage) el.scrollTop = 0;
  }, [latestPage, pageEnd]);

  useEffect(() => {
    const openUsage = () => setUsageOpen(true);
    globalThis.addEventListener("traceforge:open-token-usage", openUsage);
    return () => globalThis.removeEventListener("traceforge:open-token-usage", openUsage);
  }, []);

  useEffect(() => {
    const openRunLauncher = () => setRunLauncherOpen(true);
    globalThis.addEventListener("traceforge:new-run", openRunLauncher);
    return () => globalThis.removeEventListener("traceforge:new-run", openRunLauncher);
  }, []);

  // Graph validation nodes ask the console to surface the matching event row.
  useEffect(() => {
    const handler = (raw: Event) => {
      const { eventType, detail } = (raw as CustomEvent<{ eventType: string; detail: string }>).detail;
      const index = allAgentEvents.findIndex((event) => event.kind === "validation" && event.tool === eventType && event.text === detail);
      if (index < 0) return;
      pendingJumpRef.current = index;
      shouldAutoScrollRef.current = false;
      const end = index + 1;
      setEventPageEnd(end >= allAgentEvents.length ? null : end);
    };
    globalThis.addEventListener("traceforge:jump-to-validation", handler);
    return () => globalThis.removeEventListener("traceforge:jump-to-validation", handler);
  }, [allAgentEvents]);

  // Graph entity nodes (fact/task/timeline) ask for the console row whose refs
  // recorded them.
  useEffect(() => {
    const handler = (raw: Event) => {
      const { refId } = (raw as CustomEvent<{ refId: string }>).detail;
      const index = findAgentEventIndexByRef(allAgentEvents, refId);
      if (index < 0) return;
      pendingJumpRef.current = index;
      shouldAutoScrollRef.current = false;
      const end = index + 1;
      setEventPageEnd(end >= allAgentEvents.length ? null : end);
    };
    globalThis.addEventListener("traceforge:jump-to-event-ref", handler);
    return () => globalThis.removeEventListener("traceforge:jump-to-event-ref", handler);
  }, [allAgentEvents]);

  useLayoutEffect(() => {
    if (pendingJumpRef.current === null) return;
    const localIndex = pendingJumpRef.current - pageStart;
    const target = messagesRef.current?.querySelector(`[data-conversation-key="event-${localIndex}"]`);
    if (!(target instanceof HTMLElement)) return;
    pendingJumpRef.current = null;
    target.scrollIntoView({ block: "center" });
    target.classList.add("is-jumped");
    globalThis.setTimeout(() => target.classList.remove("is-jumped"), 1400);
  }, [pageStart, pageEvents]);

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
    setEventPageEnd(null);
    shouldAutoScrollRef.current = true;
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
    setEventPageEnd(null);
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
    setEventPageEnd(null);
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
      <div className="panel-header agent-console-header">
        <h2>Run console</h2>
        <div className="panel-header-actions">
          <span className={`console-status ${agentBusy ? "is-running" : ""}`}><span />{agentBusy ? "Running" : "Idle"}</span>
          {agentEvents.length > 0 && (
            <button
              className="tf-btn tf-btn-ghost"
              disabled={!canClearAgentConversation(agentBusy, Boolean(activeRun))}
              onClick={() => {
                history.clearOlder();
                resetAgent();
              }}
              title={activeRun || agentBusy ? "Stop or finish the active run before clearing" : "Clear conversation"}
            >
              <Broom size={13} />Clear
            </button>
          )}
        </div>
      </div>
      <RunTimelineRuler
        events={pageEvents}
        facts={facts}
        pendingApproval={pendingApproval}
        pendingScope={pendingScope}
        onJump={(eventIndex) => {
          const container = messagesRef.current;
          const target = container?.querySelector(`[data-conversation-key="event-${eventIndex}"]`);
          if (!(target instanceof HTMLElement)) return;
          shouldAutoScrollRef.current = false;
          target.scrollIntoView({ block: "center" });
          target.classList.add("is-jumped");
          globalThis.setTimeout(() => target.classList.remove("is-jumped"), 1400);
        }}
      />
      <section
        className="messages"
        role="log"
        aria-live="polite"
        aria-label="Agent conversation"
        ref={messagesRef}
        onScroll={(event) => {
          shouldAutoScrollRef.current = shouldStickToBottomAfterUpdate(event.currentTarget);
          setShowLatest(!shouldAutoScrollRef.current);
        }}
      >
        {(pageStart > 0 || !latestPage) && (
          <nav className="console-history-nav" aria-label="Agent event history">
            <button
              type="button"
              disabled={history.loading || (pageStart === 0 && history.exhausted)}
              onClick={() => {
                shouldAutoScrollRef.current = false;
                if (pageStart === 0) {
                  void history.loadOlder().then(() => setEventPageEnd(AGENT_EVENT_PAGE_SIZE));
                } else {
                  setEventPageEnd(pageStart);
                }
              }}
            >
              {history.loading ? "Loading…" : pageStart === 0 && history.exhausted ? "Beginning" : "Earlier"}
            </button>
            <span>{history.error ? `History unavailable: ${history.error}` : `${pageStart + 1}–${pageEnd} of ${allAgentEvents.length}`}</span>
            <button
              type="button"
              disabled={latestPage}
              onClick={() => {
                const nextEnd = Math.min(allAgentEvents.length, pageEnd + AGENT_EVENT_PAGE_SIZE);
                setEventPageEnd(nextEnd === allAgentEvents.length ? null : nextEnd);
              }}
            >
              Newer
            </button>
          </nav>
        )}
        {conversationItems.length === 0 && (
          <div className="tf-guide">
            <div className="tf-guide-icon"><Sparkle size={22} weight="duotone" /></div>
            <div className="tf-guide-title">Agent is idle</div>
            <div className="tf-guide-hint">Give it a target, e.g. "test example.com/login for IDOR."</div>
          </div>
        )}
        <AnimatePresence initial={false} mode="popLayout">
        {conversationItems.map((item) => {
          let content = null;
          if (item.type === "approval" && pendingApproval) {
            content = (
              <ApprovalInterventionCard
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
            content = (
              <ScopeInterventionCard
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
            content = <div className="tf-agent-busy" role="status"><CircleNotch size={14} className="tf-spin" /> Agent is running…</div>;
          }
          if (item.type === "event") {
            content = <AgentEventRow item={item} />;
          }
          if (item.type === "validation_group") {
            content = <ValidationEventGroup item={item} />;
          }
          if (!content) return null;
          return (
            <m.div
              className="agent-event-motion"
              data-event-kind={item.type === "event" ? item.kind : item.type}
              key={item.key}
              layout="position"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -3 }}
              transition={{ duration: 0.18, ease: [0.2, 0.8, 0.2, 1] }}
            >
              {content}
            </m.div>
          );
        })}
        </AnimatePresence>
        {continuationRun && !activeRun && (
          <RunContinuationCard
            goal={continuationRun.goal}
            busy={continuing || agentBusy}
            onContinue={continueRun}
          />
        )}
      </section>
      {(showLatest || !latestPage) && (
        <button
          className="console-latest"
          type="button"
          onClick={() => {
            shouldAutoScrollRef.current = true;
            setEventPageEnd(null);
            setShowLatest(false);
            requestAnimationFrame(() => {
              const el = messagesRef.current;
              if (el) el.scrollTop = el.scrollHeight;
            });
          }}
        >
          <ArrowDown size={13} />Latest activity
        </button>
      )}
      <div className="composer">
        <textarea
          rows={1} value={goal} onChange={(e) => setGoal(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
          disabled={agentBusy && !activeRun}
          placeholder={activeRun ? "Add steering instruction…" : agentBusy ? "Agent is running…" : "Add steering instruction…"}
        />
        {activeRun && (
          <button
            className="tf-btn tf-btn-danger"
            type="button"
            disabled={isStopButtonDisabled(stopping, activeRun.status)}
            onClick={stopRun}
          >
            <Stop size={13} weight="fill" /> Stop
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
          {agentBusy ? <CircleNotch size={15} className="tf-spin" /> : <><span>Send</span><PaperPlaneTilt size={14} weight="fill" /></>}
        </button>
      </div>
      <TokenUsageDialog open={usageOpen} onOpenChange={setUsageOpen} />
      <Dialog open={runLauncherOpen} onOpenChange={setRunLauncherOpen}>
        <DialogContent className="run-launcher-dialog">
          <DialogHeader><DialogTitle>Start a new security run</DialogTitle><DialogDescription>Define the authorized target and the outcome the Agent should pursue.</DialogDescription></DialogHeader>
          <label className="run-launcher-field"><span>Target and objective</span><textarea rows={5} value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="Example: Review https://app.example.com/login for authorization flaws within the approved scope." autoFocus /></label>
          <div className="run-launcher-note"><strong>Authorization boundary</strong><span>The Agent will stop and request approval before expanding beyond the case scope.</span></div>
          <div className="run-launcher-actions"><button className="tf-btn tf-btn-ghost" type="button" onClick={() => setRunLauncherOpen(false)}>Cancel</button><button className="tf-btn tf-btn-primary" type="button" disabled={!canSubmitAgentInstruction(goal, agentBusy, Boolean(activeRun))} onClick={() => { void send(); setRunLauncherOpen(false); }}><Play size={14} weight="fill" />Start run</button></div>
        </DialogContent>
      </Dialog>
    </main>
  );
}
