import { useEffect, useMemo, useState } from "react";
import { ArrowsClockwise, CheckCircle, Flask, ShieldCheck, WarningCircle } from "@phosphor-icons/react";
import { useShallow } from "zustand/react/shallow";
import { getValidationWorkflow, type ValidationWorkflowItem, type ValidationWorkflowSnapshot } from "../../api.js";
import { useStore } from "../../store.js";

export function validationWorkflowTone(snapshot: ValidationWorkflowSnapshot): "danger" | "warning" | "active" | "quiet" {
  if (snapshot.auditIssues.length > 0) return "danger";
  if (snapshot.items.some((item) => item.missingEvidence.length > 0)) return "warning";
  if (snapshot.runningLease) return "active";
  return "quiet";
}

function ValidationItem({ item, leaderId }: { item: ValidationWorkflowItem; leaderId?: string }) {
  const isLeader = Boolean(item.taskId && item.taskId === leaderId);
  return (
    <li className={`validation-item${isLeader ? " is-leader" : ""}`}>
      <div className="validation-item-main">
        <span className={`validation-state-dot${item.completionReady ? " is-ready" : ""}`} aria-hidden="true" />
        <div>
          <strong>{item.findingTitle || item.findingId}</strong>
          <span>{item.consensusStatus.replaceAll("_", " ")} · {Math.round(item.confidence * 100)}% confidence</span>
        </div>
      </div>
      <div className="validation-item-score" aria-label={item.priorityScore === null ? "No priority score" : `Priority score ${item.priorityScore}`}>
        {isLeader && <span>Lead</span>}{item.priorityScore ?? "—"}
      </div>
      {item.missingEvidence.length > 0 ? (
        <div className="validation-evidence-gap"><WarningCircle size={13} weight="fill" />{item.missingEvidence.join(" · ")}</div>
      ) : (
        <div className="validation-evidence-ready"><CheckCircle size={13} weight="fill" />Evidence gate satisfied</div>
      )}
    </li>
  );
}

export function ValidationWorkflow() {
  const { caseId, runId, tasksVersion, timelineVersion } = useStore(useShallow((state) => ({
    caseId: state.caseId,
    runId: state.activeRun?.id,
    tasksVersion: state.tasks.map((task) => `${task.id}:${task.status}:${task.updatedAt}`).join("|"),
    timelineVersion: state.timeline.at(-1)?.id ?? "",
  })));
  const [snapshot, setSnapshot] = useState<ValidationWorkflowSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = async () => {
    if (!caseId) return;
    setLoading(true);
    setError("");
    try {
      setSnapshot(await getValidationWorkflow(caseId, runId));
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [caseId, runId, tasksVersion, timelineVersion]);
  const tone = useMemo(() => snapshot ? validationWorkflowTone(snapshot) : "quiet", [snapshot]);
  if (!caseId) return null;

  return (
    <section className={`validation-workflow tone-${tone}`} aria-label="Validation workflow status" aria-busy={loading}>
      <div className="validation-workflow-head">
        <div className="validation-workflow-title">
          <ShieldCheck size={15} weight="duotone" />
          <div><span>Validation control</span><strong>{snapshot?.runningLease ? "Evidence work in progress" : snapshot?.items.length ? "Verification queue" : "No findings awaiting validation"}</strong></div>
        </div>
        <button type="button" className="tf-btn tf-btn-ghost tf-btn-icon" onClick={() => void load()} disabled={loading} aria-label="Refresh validation workflow" title="Refresh validation workflow">
          <ArrowsClockwise size={14} className={loading ? "tf-spin" : ""} />
        </button>
      </div>
      {error && <div className="validation-workflow-error"><WarningCircle size={14} />{error}</div>}
      {snapshot && snapshot.items.length > 0 && (
        <>
          <div className="validation-metrics">
            <span><i className="validation-pulse" />{snapshot.runningLease ? "Lease active" : "Queue idle"}</span>
            <span><Flask size={13} />{snapshot.exploration.explorationBoundariesRemaining > 0 ? `${snapshot.exploration.explorationBoundariesRemaining} exploration steps` : "Evidence priority"}</span>
            <span className={snapshot.auditIssues.length ? "is-danger" : ""}>{snapshot.auditIssues.length ? `${snapshot.auditIssues.length} audit issue${snapshot.auditIssues.length === 1 ? "" : "s"}` : "Consistent"}</span>
          </div>
          <ol className="validation-list">
            {snapshot.items.map((item) => <ValidationItem key={item.findingId} item={item} leaderId={snapshot.leader?.taskId} />)}
          </ol>
        </>
      )}
    </section>
  );
}
