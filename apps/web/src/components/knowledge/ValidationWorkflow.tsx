import { useMemo, useState } from "react";
import { ArrowsClockwise, ArrowSquareOut, CheckCircle, Flask, ShieldCheck, WarningCircle } from "@phosphor-icons/react";
import { useShallow } from "zustand/react/shallow";
import type { ValidationWorkflowItem, ValidationWorkflowSnapshot } from "@traceforge/shared";
import { useStore } from "../../store.js";
import type { ValidationSyncStatus } from "../../store.js";

export function validationWorkflowTone(snapshot: ValidationWorkflowSnapshot): "danger" | "warning" | "active" | "quiet" {
  if (snapshot.auditIssues.length > 0) return "danger";
  if (snapshot.items.some((item) => item.missingEvidence.length > 0)) return "warning";
  if (snapshot.runningLease) return "active";
  return "quiet";
}

export function validationSyncLabel(status: ValidationSyncStatus): "Live" | "Recovering" | "Stale" {
  if (status === "live") return "Live";
  if (status === "recovering") return "Recovering";
  return "Stale";
}

export type ValidationNavigationTarget = { kind: "finding" | "task"; id: string };

export function validationNavigationTarget(item: Pick<ValidationWorkflowItem, "findingId" | "taskId">, kind: "finding" | "task"): ValidationNavigationTarget | null {
  const id = kind === "finding" ? item.findingId : item.taskId;
  return id ? { kind, id } : null;
}

function ValidationItem({ item, leaderId, changed, onNavigate }: { item: ValidationWorkflowItem; leaderId?: string; changed: boolean; onNavigate: (target: ValidationNavigationTarget) => void }) {
  const isLeader = Boolean(item.taskId && item.taskId === leaderId);
  const findingTarget = validationNavigationTarget(item, "finding");
  const taskTarget = validationNavigationTarget(item, "task");
  return (
    <li className={`validation-item${isLeader ? " is-leader" : ""}${changed ? " is-changed" : ""}`}>
      <button type="button" className="validation-item-main" onClick={() => findingTarget && onNavigate(findingTarget)}>
        <span className={`validation-state-dot${item.completionReady ? " is-ready" : ""}`} aria-hidden="true" />
        <div>
          <strong>{item.findingTitle || item.findingId}</strong>
          <span>{item.consensusStatus.replaceAll("_", " ")} · {Math.round(item.confidence * 100)}% confidence</span>
        </div>
        <ArrowSquareOut size={12} aria-hidden="true" />
      </button>
      <button type="button" className="validation-item-score" disabled={!taskTarget} onClick={() => taskTarget && onNavigate(taskTarget)} aria-label={taskTarget ? `Locate task, priority ${item.priorityScore ?? "unscored"}` : "No validation task"}>
        {isLeader && <span>Lead</span>}{item.priorityScore ?? "—"}
      </button>
      {item.missingEvidence.length > 0 ? (
        <div className="validation-evidence-gap"><WarningCircle size={13} weight="fill" />{item.missingEvidence.join(" · ")}</div>
      ) : (
        <div className="validation-evidence-ready"><CheckCircle size={13} weight="fill" />Evidence gate satisfied</div>
      )}
    </li>
  );
}

export function ValidationWorkflow({ onNavigate }: { onNavigate: (target: ValidationNavigationTarget) => void }) {
  const { caseId, snapshot, delta, syncStatus, refreshValidationWorkflow } = useStore(useShallow((state) => ({
    caseId: state.caseId,
    snapshot: state.validationWorkflow,
    delta: state.validationWorkflowDelta,
    syncStatus: state.validationSyncStatus,
    refreshValidationWorkflow: state.refreshValidationWorkflow,
  })));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = async () => {
    if (!caseId) return;
    setLoading(true);
    setError("");
    try {
      await refreshValidationWorkflow();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const tone = useMemo(() => snapshot ? validationWorkflowTone(snapshot) : "quiet", [snapshot]);
  if (!caseId) return null;

  return (
    <section className={`validation-workflow tone-${tone}`} aria-label="Validation workflow status" aria-busy={loading}>
      <div className="validation-workflow-head">
        <div className="validation-workflow-title">
          <ShieldCheck size={15} weight="duotone" />
          <div><span>Validation control</span><strong>{snapshot?.runningLease ? "Evidence work in progress" : snapshot?.items.length ? "Verification queue" : "No findings awaiting validation"}</strong></div>
        </div>
        <div className="validation-workflow-actions">
          <span className={`validation-sync is-${syncStatus}`} role="status" aria-live="polite" title={snapshot ? `Workflow revision ${snapshot.revision}` : "Workflow snapshot unavailable"}>
            <i aria-hidden="true" />{validationSyncLabel(syncStatus)}
          </span>
          <button type="button" className="tf-btn tf-btn-ghost tf-btn-icon" onClick={() => void load()} disabled={loading} aria-label="Refresh validation workflow" title="Refresh validation workflow">
            <ArrowsClockwise size={14} className={loading ? "tf-spin" : ""} />
          </button>
        </div>
      </div>
      {error && <div className="validation-workflow-error"><WarningCircle size={14} />{error}</div>}
      {snapshot && snapshot.items.length > 0 && (
        <>
          <div className="validation-metrics">
            <span><i className="validation-pulse" />{snapshot.runningLease ? "Lease active" : "Queue idle"}</span>
            <span><Flask size={13} />{snapshot.exploration.explorationBoundariesRemaining > 0 ? `${snapshot.exploration.explorationBoundariesRemaining} exploration steps` : "Evidence priority"}</span>
            <span className={snapshot.auditIssues.length ? "is-danger" : ""}>{snapshot.auditIssues.length ? `${snapshot.auditIssues.length} audit issue${snapshot.auditIssues.length === 1 ? "" : "s"}` : "Consistent"}</span>
          </div>
          {delta && delta.revision === snapshot.revision && delta.summary.length > 0 && (
            <div className="validation-change-feed" key={delta.revision} role="status" aria-live="polite">
              <i aria-hidden="true" /><span>{delta.summary.slice(0, 2).join(" · ")}</span>
              {delta.summary.length > 2 && <small>+{delta.summary.length - 2}</small>}
            </div>
          )}
          <ol className="validation-list">
            {snapshot.items.map((item) => {
              const changed = delta?.revision === snapshot.revision && delta.changedFindingIds.includes(item.findingId);
              return <ValidationItem key={`${item.findingId}:${changed ? delta?.revision ?? 0 : 0}`} item={item} leaderId={snapshot.leader?.taskId} changed={Boolean(changed)} onNavigate={onNavigate} />;
            })}
          </ol>
          {snapshot.auditIssues.length > 0 && (
            <div className="validation-audit-list" aria-label="Consistency audit issues">
              {snapshot.auditIssues.map((issue) => (
                <button type="button" key={issue.taskId} onClick={() => onNavigate({ kind: "task", id: issue.taskId })}>
                  <WarningCircle size={13} weight="fill" /><span>{issue.issue.replace("[Consistency audit]", "").trim()}</span><ArrowSquareOut size={12} />
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
