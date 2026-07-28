import { useStore } from "../store.js";
import { Fingerprint, Gauge, LockKey, Robot, Warning } from "@phosphor-icons/react";
import { TrafficInspector } from "./inspector/TrafficInspector.js";
import { FindingInspector, ToolEventInspector } from "./inspector/EvidenceInspector.js";
import { TaskInspector, TimelineEventInspector } from "./inspector/GraphInspectors.js";
import { ValidationRunSummary } from "./agent/ValidationRunSummary.js";
import { ValidationWorkflow } from "./knowledge/ValidationWorkflow.js";
import { confidencePercent } from "./knowledge/knowledge-window.js";
import { useShallow } from "zustand/react/shallow";

function KnowledgeInspector() {
  const { selectedTraffic, selectedFact, selectedTask, selectedTimelineEntry, selectedAgentEvent, knowledgeTarget, clearKnowledgeTarget } = useStore(useShallow((state) => ({
    selectedTraffic: state.selectedTrafficId
      ? state.traffic.find((entry) => entry.id === state.selectedTrafficId)
        ?? (state.selectedTrafficSnapshot?.id === state.selectedTrafficId ? state.selectedTrafficSnapshot : null)
      : null,
    selectedFact: state.selectedFactId
      ? state.facts.find((fact) => fact.id === state.selectedFactId) ?? null
      : null,
    selectedTask: state.selectedTaskId
      ? state.tasks.find((task) => task.id === state.selectedTaskId) ?? null
      : null,
    selectedTimelineEntry: state.selectedTimelineNodeId
      ? state.timeline.find((entry) => entry.id === state.selectedTimelineNodeId) ?? null
      : null,
    selectedAgentEvent: state.selectedAgentEvent,
    knowledgeTarget: state.knowledgeTarget,
    clearKnowledgeTarget: state.clearKnowledgeTarget,
  })));
  if (selectedTraffic) return <TrafficInspector entry={selectedTraffic} />;
  if (selectedFact) return <FindingInspector fact={selectedFact} targetRequestId={knowledgeTarget?.kind === "finding" && knowledgeTarget.id === selectedFact.id ? knowledgeTarget.requestId : null} onTargetHandled={clearKnowledgeTarget} />;
  if (selectedTask) return <TaskInspector task={selectedTask} />;
  if (selectedTimelineEntry) return <TimelineEventInspector entry={selectedTimelineEntry} />;
  if (selectedAgentEvent) return <ToolEventInspector event={selectedAgentEvent} />;
  return null;
}

const OVERVIEW_FINDING_COUNT = 8;

function PendingInterventions() {
  const { pendingApproval, pendingScope } = useStore(useShallow((state) => ({
    pendingApproval: state.pendingApproval,
    pendingScope: state.pendingScope,
  })));
  if (!pendingApproval && !pendingScope) return null;
  const focusConsole = () => document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus();
  return (
    <section className="case-overview-section" aria-label="Pending interventions">
      <h3><Warning size={13} weight="fill" aria-hidden="true" />Awaiting review</h3>
      {pendingApproval && (
        <button type="button" className="case-overview-alert" onClick={focusConsole}>
          <LockKey size={13} aria-hidden="true" />
          <span>Approval needed: <strong>{pendingApproval.tool}</strong></span>
        </button>
      )}
      {pendingScope && (
        <button type="button" className="case-overview-alert" onClick={focusConsole}>
          <LockKey size={13} aria-hidden="true" />
          <span>Scope decision: <strong>{pendingScope.host}</strong></span>
        </button>
      )}
    </section>
  );
}

function RunStatusSection() {
  const { activeRun, agentBusy } = useStore(useShallow((state) => ({ activeRun: state.activeRun, agentBusy: state.agentBusy })));
  const status = activeRun?.status ?? (agentBusy ? "running" : "idle");
  return (
    <section className="case-overview-section" aria-label="Run status">
      <h3><Robot size={13} aria-hidden="true" />Run</h3>
      <div className="case-overview-run">
        <span className={`console-status ${agentBusy ? "is-running" : ""}`}><span />{status}</span>
        {activeRun && <p title={activeRun.goal}>{activeRun.goal}</p>}
      </div>
    </section>
  );
}

function LatestFindings() {
  const { facts, selectFact } = useStore(useShallow((state) => ({ facts: state.facts, selectFact: state.selectFact })));
  const latest = facts.slice(-OVERVIEW_FINDING_COUNT).reverse();
  if (latest.length === 0) return null;
  return (
    <section className="case-overview-section" aria-label="Latest evidence">
      <h3><Fingerprint size={13} aria-hidden="true" />Latest evidence</h3>
      <div className="case-overview-findings">
        {latest.map((fact) => (
          <button key={fact.id} type="button" className="case-overview-finding" onClick={() => selectFact(fact.id)}>
            <span className="case-overview-finding-title">{fact.title}</span>
            <span className={`tf-tag tf-row-level-${fact.findingStatus === "verified" ? "critical" : "info"}`}>{fact.findingStatus ?? fact.type} · {confidencePercent(fact.confidence)}%</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function CaseOverview() {
  const navigateToKnowledge = useStore((state) => state.navigateToKnowledge);
  return (
    <>
      <div className="panel-header">
        <div className="panel-heading">
          <Gauge size={16} weight="duotone" aria-hidden="true" />
          <span className="section-kicker">Case</span>
          <h2>Overview</h2>
        </div>
      </div>
      <div className="panel-body case-overview">
        <PendingInterventions />
        <RunStatusSection />
        <ValidationRunSummary />
        <ValidationWorkflow onNavigate={navigateToKnowledge} />
        <LatestFindings />
      </div>
    </>
  );
}

export function KnowledgePanel() {
  const inspectorOpen = useStore((state) => Boolean(state.selectedTrafficId || state.selectedFactId || state.selectedTaskId || state.selectedTimelineNodeId || state.selectedAgentEvent));
  return (
    <aside className="panel knowledge-panel">
      {inspectorOpen ? <KnowledgeInspector /> : <CaseOverview />}
    </aside>
  );
}
