import { useStore } from "../store.js";
import { Archive, CaretDown, CaretRight, CheckCircle, Fingerprint, Gauge, LockKey, Robot, Warning, WarningCircle } from "@phosphor-icons/react";
import type { Fact } from "@traceforge/shared";
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

const OVERVIEW_EVIDENCE_CLUSTER_COUNT = 7;

export type EvidenceCluster = {
  key: string;
  primary: Fact;
  count: number;
};

export function isPresentableEvidence(fact: Fact): boolean {
  return fact.type !== "failed_attempt"
    && !fact.tags.includes("failure-memory")
    && fact.validity !== "superseded"
    && fact.validity !== "stale";
}

function evidenceClusterKey(fact: Fact): string {
  return [
    fact.title.trim().toLocaleLowerCase(),
    fact.type.trim().toLocaleLowerCase(),
    fact.findingStatus ?? fact.validity,
  ].join("\u0000");
}

export function buildEvidenceClusters(facts: Fact[], limit = OVERVIEW_EVIDENCE_CLUSTER_COUNT): EvidenceCluster[] {
  const clusters = new Map<string, EvidenceCluster>();
  for (let index = facts.length - 1; index >= 0; index -= 1) {
    const fact = facts[index];
    if (!isPresentableEvidence(fact)) continue;
    const key = evidenceClusterKey(fact);
    const existing = clusters.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }
    if (clusters.size >= limit) continue;
    clusters.set(key, { key, primary: fact, count: 1 });
  }
  return [...clusters.values()];
}

function evidenceStatus(fact: Fact): string {
  return fact.findingStatus ?? (fact.validity === "valid" ? "observed" : fact.validity);
}

function evidenceStatusLabel(status: string): string {
  if (status === "needs_review") return "Needs review";
  return status.replaceAll("_", " ").replace(/^\w/, (character) => character.toUpperCase());
}

function evidenceTone(status: string): string {
  if (status === "verified") return "verified";
  if (status === "validating") return "active";
  if (status === "needs_review" || status === "conflicted") return "warning";
  if (status === "rejected" || status === "stale" || status === "superseded") return "muted";
  return "observed";
}

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
  const clusters = buildEvidenceClusters(facts);
  const evidenceCount = facts.filter(isPresentableEvidence).length;
  if (clusters.length === 0) return null;
  return (
    <section className="case-overview-section" aria-label="Latest evidence">
      <h3 className="case-overview-evidence-heading">
        <span><Fingerprint size={13} aria-hidden="true" />Evidence</span>
        <small>{evidenceCount} records · {clusters.length} groups</small>
      </h3>
      <div className="case-overview-evidence">
        {clusters.map(({ key, primary, count }) => {
          const status = evidenceStatus(primary);
          return (
            <button
              key={key}
              type="button"
              className="case-overview-evidence-row"
              data-tone={evidenceTone(status)}
              aria-label={`${primary.title}. ${evidenceStatusLabel(status)}. ${confidencePercent(primary.confidence)} percent confidence${count > 1 ? `. ${count} related records` : ""}`}
              onClick={() => selectFact(primary.id)}
            >
              <i aria-hidden="true" />
              <span className="case-overview-evidence-copy">
                <strong>{primary.title}</strong>
                <small>{evidenceStatusLabel(status)} · {primary.source.type} · {confidencePercent(primary.confidence)}%</small>
              </span>
              {count > 1 && <span className="case-overview-evidence-count" title={`${count} related records`}>×{count}</span>}
              <CaretRight size={12} aria-hidden="true" />
            </button>
          );
        })}
      </div>
    </section>
  );
}

function artifactSize(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function ArtifactEvidence() {
  const artifacts = useStore((state) => state.artifacts);
  if (artifacts.length === 0) return null;
  return (
    <section className="case-overview-section artifact-evidence-section" aria-label="Artifacts">
      <h3 className="case-overview-evidence-heading">
        <span><Archive size={13} aria-hidden="true" />Artifacts</span>
        <small>{artifacts.length} recorded</small>
      </h3>
      <div className="artifact-evidence-list">
        {[...artifacts].reverse().slice(0, 5).map((artifact) => {
          const analysis = artifact.analysis;
          const complete = artifact.status === "analyzed" && analysis;
          return (
            <details className="artifact-evidence-item" key={artifact.id}>
              <summary>
                <span className="artifact-state" data-state={artifact.status}>
                  {complete ? <CheckCircle size={13} weight="fill" /> : artifact.status === "failed" || artifact.status === "unsupported" ? <WarningCircle size={13} weight="fill" /> : <Archive size={13} />}
                </span>
                <span className="artifact-summary-copy">
                  <strong>{artifact.filename}</strong>
                  <small>{artifact.detectedFormat} · {artifactSize(artifact.byteSize)} · {artifact.status}</small>
                </span>
                {analysis && <span className="artifact-finding-count">{analysis.findings.length} evidence</span>}
                <CaretDown size={12} className="artifact-caret" aria-hidden="true" />
              </summary>
              <div className="artifact-evidence-detail">
                <dl className="artifact-metadata">
                  <div><dt>SHA256</dt><dd><code>{artifact.sha256}</code></dd></div>
                  <div><dt>Analyzer</dt><dd>{artifact.analyzerId ?? "Not available"}</dd></div>
                  {analysis && <div><dt>Coverage</dt><dd>{[
                    analysis.coverage.metadata && "metadata",
                    analysis.coverage.text && "text",
                    analysis.coverage.objectGraph && "object graph",
                  ].filter(Boolean).join(" · ") || "none"}</dd></div>}
                </dl>
                {analysis?.findings.map((finding, index) => (
                  <div className="artifact-finding" key={`${finding.kind}-${finding.label}-${index}`}>
                    <span>{finding.kind}</span>
                    <strong>{finding.label}</strong>
                    <code>{finding.value}</code>
                    {finding.evidence.map((evidence, evidenceIndex) => (
                      <small key={evidenceIndex}>{evidence.relationship ?? evidence.path ?? evidence.objectId ?? evidence.detail}</small>
                    ))}
                  </div>
                ))}
                {analysis?.findings.length === 0 && <p className="artifact-empty-result">No candidate recovered by this analyzer. This is not proof of absence.</p>}
                {(analysis?.coverage.limitations ?? (artifact.error ? [artifact.error] : [])).map((limitation) => (
                  <p className="artifact-limitation" key={limitation}><WarningCircle size={12} />{limitation}</p>
                ))}
              </div>
            </details>
          );
        })}
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
        <ArtifactEvidence />
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
