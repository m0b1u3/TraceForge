import { useState } from "react";
import { ArrowBendDownRight, CaretRight, CheckCircle, Clock, Eye, ListPlus, Play, Pulse, Warning, X } from "@phosphor-icons/react";
import { parseObserverCorrectionAudit, type AgentRun, type ObserverWarning } from "@traceforge/shared";
import { acceptObserverWarning, convertObserverWarningToTask, dismissObserverWarning, runAgent } from "../../api.js";
import { useStore } from "../../store.js";
import { useShallow } from "zustand/react/shallow";
import { FeedbackState } from "../ui/feedback-state.js";
import { KnowledgeWindowFooter, useKnowledgeWindow } from "./knowledge-window.js";

const LEVEL_CLASS: Record<string, string> = { critical: "critical", warning: "warning", info: "info" };
const STATUS_LABEL: Record<ObserverWarning["status"], string> = {
  open: "Pending",
  accepted: "Resumed",
  converted_to_task: "Tasked",
  dismissed: "Ignored",
  detected: "Detected",
  correcting: "Correcting",
  resolved: "Resolved",
  escalated: "Escalated",
};
const OUTCOME_LABEL: Record<ObserverWarning["correctionOutcome"], string> = {
  none: "Not issued",
  pending: "Awaiting verification",
  resolved: "Recovered",
  unattributed: "Ended · not attributed",
  persisted: "Still present",
  stalled: "Awaiting new strategy",
  escalated: "Escalated",
};

export function observerWarningStatusLabel(status: ObserverWarning["status"]): string {
  return STATUS_LABEL[status];
}

export function observerWarningRunGoal(warning: Pick<ObserverWarning, "suggestedGoal" | "suggestedAction">): string {
  return warning.suggestedGoal.trim() || warning.suggestedAction;
}

export function observerWarningContinueDisabled(activeRun: Pick<AgentRun, "status"> | null, agentBusy: boolean, busy: string | null): boolean {
  return busy !== null || agentBusy || activeRun !== null;
}

export function observerRecoveryRequiresDirection(
  warning: Pick<ObserverWarning, "correctionOutcome">,
): boolean {
  return warning.correctionOutcome === "stalled";
}

function CorrectionAudit({ warning }: { warning: ObserverWarning }) {
  const audit = parseObserverCorrectionAudit(warning.correctionEvidence);
  if (!audit) return null;
  return (
    <details className="observer-correction-audit">
      <summary>
        <CaretRight size={12} weight="bold" />
        <span>Attribution trail</span>
        <small>{audit.attributed ? "Evidence linked" : "Not credited"}</small>
      </summary>
      <div className="observer-correction-audit-body">
        {audit.instruction && (
          <div>
            <span>Correction{audit.trigger ? ` · ${audit.trigger}` : ""}</span>
            <p>{audit.instruction}</p>
          </div>
        )}
        {audit.actions.length > 0 && (
          <div>
            <span>Observed after correction</span>
            <ol>
              {audit.actions.map((action, index) => (
                <li key={`${action.tool}-${index}`}>
                  <code>{action.tool}</code>
                  <em className={`is-${action.outcome}`}>{action.outcome}</em>
                  {action.evidenceRefs.length > 0 && <small>{action.evidenceRefs.join(" · ")}</small>}
                </li>
              ))}
            </ol>
          </div>
        )}
        <div>
          <span>Decision</span>
          <p>{audit.summary}</p>
        </div>
      </div>
    </details>
  );
}

type ObserverGroup = "action" | "monitoring" | "history";

export function observerWarningGroup(status: ObserverWarning["status"]): ObserverGroup {
  if (status === "open" || status === "escalated") return "action";
  if (status === "detected" || status === "correcting") return "monitoring";
  return "history";
}

export function ObserverTab() {
  const {
    caseId, warnings, showToast, addAgentEvent, setAgentBusy, setActiveRun,
    upsertWarning, upsertTask, activeRun, agentBusy, observerTelemetry,
  } = useStore(useShallow((state) => ({
    caseId: state.caseId, warnings: state.warnings, showToast: state.showToast,
    addAgentEvent: state.addAgentEvent, setAgentBusy: state.setAgentBusy,
    setActiveRun: state.setActiveRun, upsertWarning: state.upsertWarning,
    upsertTask: state.upsertTask, activeRun: state.activeRun, agentBusy: state.agentBusy,
    observerTelemetry: state.observerTelemetry,
  })));
  const [busy, setBusy] = useState<string | null>(null);
  const [recoveryWarningId, setRecoveryWarningId] = useState<string | null>(null);
  const [recoveryDirection, setRecoveryDirection] = useState("");
  const window = useKnowledgeWindow(warnings.length);
  const visibleWarnings = warnings.slice(0, window.count);
  const groups: Array<{ id: ObserverGroup; label: string; icon: typeof Warning; items: ObserverWarning[] }> = [
    { id: "action", label: "Needs action", icon: Warning, items: visibleWarnings.filter((warning) => observerWarningGroup(warning.status) === "action") },
    { id: "monitoring", label: "Monitoring", icon: Eye, items: visibleWarnings.filter((warning) => observerWarningGroup(warning.status) === "monitoring") },
    { id: "history", label: "History", icon: Clock, items: visibleWarnings.filter((warning) => observerWarningGroup(warning.status) === "history") },
  ];
  const settledCorrections = observerTelemetry.correctionResolvedCount + observerTelemetry.correctionFailedCount;
  const effectiveness = settledCorrections > 0
    ? Math.round((observerTelemetry.correctionResolvedCount / settledCorrections) * 100)
    : null;
  const averageTokens = observerTelemetry.correctionCount > 0
    ? Math.round(observerTelemetry.totalTokens / observerTelemetry.correctionCount)
    : null;
  const telemetry = (
    <div className="observer-telemetry" aria-label="Observer review activity">
      <div className="observer-telemetry-state">
        <span className={observerTelemetry.failureCount > 0 ? "is-degraded" : "is-healthy"}><Pulse size={13} weight="bold" /></span>
        <div>
          <strong>{observerTelemetry.failureCount > 0 ? "Review degraded" : observerTelemetry.reviewCount > 0 ? "Observer active" : "Observer standing by"}</strong>
          <small>{observerTelemetry.lastTrigger ? `Last ${observerTelemetry.lastTrigger} review · ${observerTelemetry.lastDurationMs ?? 0} ms` : "Reviews run at evidence, risk, failure, and periodic checkpoints"}</small>
        </div>
      </div>
      <div className="observer-telemetry-metrics">
        <span><strong>{observerTelemetry.reviewCount}</strong> reviews</span>
        <span><strong>{observerTelemetry.correctionCount}</strong> corrections</span>
        <span><strong>{observerTelemetry.correctionResolvedCount}</strong> recovered</span>
        <span><strong>{effectiveness === null ? "—" : `${effectiveness}%`}</strong> effective</span>
        <span><strong>{observerTelemetry.totalTokens.toLocaleString()}</strong> tokens</span>
        {averageTokens !== null && <span><strong>{averageTokens.toLocaleString()}</strong> tokens/correction</span>}
      </div>
    </div>
  );
  if (warnings.length === 0) return <>{telemetry}{observerTelemetry.failureCount > 0 && <div className="observer-review-failure" role="status"><Warning size={14} /><span><strong>{observerTelemetry.failureCount} review failed</strong>Agent continued normally. Check the LLM connection if this repeats.</span></div>}<FeedbackState title="No intervention required" description="No unsupported conclusions or unresolved critical evidence were detected." /></>;

  const continueRun = async (w: ObserverWarning, direction?: string) => {
    if (!caseId) return;
    if (observerWarningContinueDisabled(activeRun, agentBusy, busy)) {
      showToast("An Agent run is already in progress. Wait for it to finish before resuming an Observer warning.");
      return;
    }
    const humanDirection = direction?.trim();
    if (observerRecoveryRequiresDirection(w) && !humanDirection) {
      setRecoveryWarningId(w.id);
      setRecoveryDirection("");
      return;
    }
    const goal = humanDirection || observerWarningRunGoal(w);
    setBusy(`${w.id}:continue`);
    try {
      addAgentEvent({ kind: "user", text: goal });
      setAgentBusy(true);
      const run = await runAgent(
        caseId,
        goal,
        humanDirection
          ? { observerRecovery: { warningId: w.id, direction: humanDirection } }
          : {},
      );
      setActiveRun(run);
      if (humanDirection) {
        setRecoveryWarningId(null);
        setRecoveryDirection("");
      } else {
        const warning = await acceptObserverWarning(w.id);
        upsertWarning(warning);
      }
    } catch (e) {
      showToast((e as Error).message);
      if (!activeRun) setAgentBusy(false);
    } finally {
      setBusy(null);
    }
  };

  const convertToTask = async (w: ObserverWarning) => {
    setBusy(`${w.id}:task`);
    try {
      const result = await convertObserverWarningToTask(w.id);
      upsertTask(result.task);
      upsertWarning(result.warning);
    } catch (e) {
      showToast((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const dismiss = async (w: ObserverWarning) => {
    setBusy(`${w.id}:dismiss`);
    try {
      const warning = await dismissObserverWarning(w.id);
      upsertWarning(warning);
    } catch (e) {
      showToast((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const warningRow = (w: ObserverWarning) => {
      const continueDisabled = observerWarningContinueDisabled(activeRun, agentBusy, busy);
      return (
    <article className={`tf-row observer-row ${LEVEL_CLASS[w.level]}`} key={w.id}>
      <div className="observer-row-head">
        <span className={`tf-tag tf-row-level-${w.level}`}>{w.level}</span>
        <span className="observer-row-status">{observerWarningStatusLabel(w.status)}</span>
        <span className="observer-row-status">seen {w.occurrenceCount}×</span>
      </div>
      <strong className="observer-row-title">{w.title}</strong>
      <p className="observer-row-description">{w.description}</p>
      {w.status === "correcting" && <div className="observer-correction-track" aria-label="Correction in progress"><span className="is-complete"><CheckCircle size={11} weight="fill" />Detected</span><i /><span className="is-active"><ArrowBendDownRight size={11} />Correcting</span><i /><span>Verify</span></div>}
      {w.correctionCount > 0 && (
        <div className={`observer-correction-outcome is-${w.correctionOutcome}`}>
          <span>{OUTCOME_LABEL[w.correctionOutcome]}</span>
          <span>{w.correctionResolvedCount} recovered · {w.correctionFailedCount} unresolved · {w.correctionCount} issued</span>
        </div>
      )}
      <CorrectionAudit warning={w} />
      <div className="observer-row-suggestion"><span>Suggested next step</span>{w.suggestedAction}</div>
      {recoveryWarningId === w.id && (
        <div className="observer-recovery-editor">
          <label htmlFor={`observer-recovery-${w.id}`}>Human direction</label>
          <textarea
            id={`observer-recovery-${w.id}`}
            value={recoveryDirection}
            onChange={(event) => setRecoveryDirection(event.target.value)}
            placeholder="Describe the new investigation direction or constraint…"
            rows={3}
            autoFocus
          />
          <div>
            <button
              className="tf-btn tf-btn-primary"
              disabled={!recoveryDirection.trim() || continueDisabled}
              onClick={() => void continueRun(w, recoveryDirection)}
            >
              <Play size={13} /> Start recovery
            </button>
            <button
              className="tf-btn tf-btn-ghost"
              disabled={busy !== null}
              onClick={() => { setRecoveryWarningId(null); setRecoveryDirection(""); }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {(w.status === "open" || w.status === "detected" || w.status === "correcting" || w.status === "escalated") && (
        <div className="tf-row-actions">
          <button className="tf-btn tf-btn-ghost tf-btn-icon" disabled={continueDisabled} onClick={() => void continueRun(w)} title={observerRecoveryRequiresDirection(w) ? "Provide a new direction and start a recovery run" : "Start a new Agent run based on the Observer suggestion"}>
            <Play size={13} /> {observerRecoveryRequiresDirection(w) ? "Direct recovery" : "Resume"}
          </button>
          <button className="tf-btn tf-btn-ghost tf-btn-icon" disabled={busy !== null} onClick={() => convertToTask(w)} title="Convert this warning into a Task in the Tasks panel">
            <ListPlus size={13} /> Create task
          </button>
          <button className="tf-btn tf-btn-ghost tf-btn-icon" disabled={busy !== null} onClick={() => dismiss(w)} title="Dismiss this warning">
            <X size={13} /> Ignore
          </button>
        </div>
      )}
    </article>
      );
  };

  return <>{telemetry}{observerTelemetry.failureCount > 0 && <div className="observer-review-failure" role="status"><Warning size={14} /><span><strong>{observerTelemetry.failureCount} review failed</strong>Agent continued normally. Check the LLM connection if this repeats.</span></div>}
    <div className="observer-groups">
      {groups.filter((group) => group.items.length > 0).map((group) => {
        const Icon = group.icon;
        return <section className={`observer-group observer-group-${group.id}`} key={group.id}>
          <header><span><Icon size={12} />{group.label}</span><strong>{group.items.length}</strong></header>
          {group.items.map(warningRow)}
        </section>;
      })}
    </div>
    <KnowledgeWindowFooter visible={window.count} total={warnings.length} onShowMore={window.showMore} />
  </>;
}
