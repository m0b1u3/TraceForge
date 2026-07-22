import { ArrowsClockwise, Compass, Crosshair, LockKey, ShieldCheck, WarningCircle } from "@phosphor-icons/react";
import type { CSSProperties, ReactNode } from "react";
import type { Task, ValidationWorkflowSnapshot } from "@traceforge/shared";
import { useShallow } from "zustand/react/shallow";
import { useStore, type ValidationSyncStatus } from "../../store.js";
import { deriveValidationPresentation, type ValidationDiagnostic } from "../../lib/validation-presentation.js";
import { VALIDATION_STATE_RESTORED, validationRefreshFailed } from "../../lib/validation-feedback.js";

export interface ValidationRunSummaryModel {
  lease: { id: string; label: string } | null;
  leader: { id: string; label: string; score: number } | null;
  evidence: { ready: number; total: number; missing: number };
  explorationBoundaries: number;
  syncStatus: ValidationSyncStatus;
  diagnostic: ValidationDiagnostic | null;
}

export function validationRunSummaryModel(snapshot: ValidationWorkflowSnapshot | null, tasks: Task[], syncStatus: ValidationSyncStatus): ValidationRunSummaryModel | null {
  if (!snapshot || (!snapshot.runningLease && !snapshot.leader && snapshot.items.length === 0)) return null;
  const taskTitle = (id: string) => tasks.find((task) => task.id === id)?.title ?? id;
  const leaderItem = snapshot.items.find((item) => item.taskId === snapshot.leader?.taskId);
  const presentation = deriveValidationPresentation(snapshot, tasks, syncStatus);
  return {
    lease: snapshot.runningLease ? { id: snapshot.runningLease, label: taskTitle(snapshot.runningLease) } : null,
    leader: snapshot.leader ? { id: snapshot.leader.taskId, label: leaderItem?.findingTitle ?? taskTitle(snapshot.leader.taskId), score: snapshot.leader.score } : null,
    evidence: presentation.evidence,
    explorationBoundaries: snapshot.exploration.explorationBoundariesRemaining,
    syncStatus,
    diagnostic: presentation.diagnostic,
  };
}

export function ValidationRunSummary() {
  const { snapshot, tasks, syncStatus, navigate, refresh, showToast } = useStore(useShallow((state) => ({
    snapshot: state.validationWorkflow,
    tasks: state.tasks,
    syncStatus: state.validationSyncStatus,
    navigate: state.navigateToKnowledge,
    refresh: state.refreshValidationWorkflow,
    showToast: state.showToast,
  })));
  const model = validationRunSummaryModel(snapshot, tasks, syncStatus);
  if (!model) return null;
  const diagnostic = model.diagnostic;
  const progress = model.evidence.total ? Math.round((model.evidence.ready / model.evidence.total) * 100) : 0;
  return (
    <section className="validation-run-summary" aria-label="Current validation run">
      <span className={`validation-run-sync is-${model.syncStatus}`}><span aria-hidden="true" />Validation</span>
      <SummaryTarget icon={<LockKey size={13} />} label="Lease" value={model.lease?.label ?? "Unclaimed"} onClick={model.lease ? () => navigate({ kind: "task", id: model.lease!.id }) : undefined} />
      <SummaryTarget icon={<Crosshair size={13} />} label="Priority" value={model.leader ? `${model.leader.label} · ${model.leader.score}` : "No leader"} onClick={model.leader ? () => navigate({ kind: "task", id: model.leader!.id }) : undefined} />
      <span className="validation-run-metric" role="progressbar" aria-label="Evidence gates satisfied" aria-valuemin={0} aria-valuemax={model.evidence.total} aria-valuenow={model.evidence.ready}>
        <ShieldCheck size={13} aria-hidden="true" /><span><small>Evidence</small><strong>{model.evidence.ready}/{model.evidence.total}</strong>{model.evidence.missing > 0 && <em>{model.evidence.missing} gaps</em>}</span><i style={{ "--validation-progress": `${progress}%` } as CSSProperties} aria-hidden="true" />
      </span>
      {diagnostic ? (
        <button
          type="button"
          className={`validation-run-metric validation-run-diagnostic is-${diagnostic.kind}`}
          disabled={diagnostic.kind === "recovering"}
          title={diagnostic.detail}
          aria-label={`${diagnostic.label}. ${diagnostic.detail}`}
          onClick={() => {
            if (diagnostic.kind === "stale") void refresh()
              .then(() => showToast(VALIDATION_STATE_RESTORED.message, VALIDATION_STATE_RESTORED.tone))
              .catch((error) => {
                const feedback = validationRefreshFailed(error);
                showToast(feedback.message, feedback.tone);
              });
            else if (diagnostic.taskId) navigate({ kind: "task", id: diagnostic.taskId });
          }}
        >
          {diagnostic.kind === "stale" || diagnostic.kind === "recovering" ? <ArrowsClockwise size={13} className={diagnostic.kind === "recovering" ? "tf-spin" : ""} aria-hidden="true" /> : <WarningCircle size={13} weight="fill" aria-hidden="true" />}
          <span><small>Diagnostic</small><strong>{diagnostic.label}</strong></span>
        </button>
      ) : (
        <span className="validation-run-metric"><Compass size={13} aria-hidden="true" /><span><small>Explore</small><strong>{model.explorationBoundaries > 0 ? `${model.explorationBoundaries} boundaries` : "Closed"}</strong></span></span>
      )}
    </section>
  );
}

function SummaryTarget({ icon, label, value, onClick }: { icon: ReactNode; label: string; value: string; onClick?: () => void }) {
  const content = <>{icon}<span><small>{label}</small><strong title={value}>{value}</strong></span></>;
  return onClick
    ? <button type="button" className="validation-run-metric is-action" onClick={onClick} aria-label={`${label}: ${value}. Locate task`}>{content}</button>
    : <span className="validation-run-metric">{content}</span>;
}
