import { useState } from "react";
import { ListPlus, Play, X } from "@phosphor-icons/react";
import type { AgentRun, ObserverWarning } from "@traceforge/shared";
import { acceptObserverWarning, convertObserverWarningToTask, dismissObserverWarning, runAgent } from "../../api.js";
import { useStore } from "../../store.js";

const LEVEL_CLASS: Record<string, string> = { critical: "critical", warning: "warning", info: "info" };
const STATUS_LABEL: Record<ObserverWarning["status"], string> = {
  open: "Pending",
  accepted: "Resumed",
  converted_to_task: "Tasked",
  dismissed: "Ignored",
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

export function ObserverTab() {
  const {
    caseId, warnings, showToast, addAgentEvent, setAgentBusy, setActiveRun,
    upsertWarning, upsertTask, activeRun, agentBusy,
  } = useStore();
  const [busy, setBusy] = useState<string | null>(null);
  if (warnings.length === 0) return <div className="tf-guide"><div className="tf-guide-title">No observer warnings yet.</div><div className="tf-guide-hint">After each Agent run, the Observer reviews it for unfounded guesses, ignored prior information, premature exits, and surfaces warnings here.</div></div>;

  const continueRun = async (w: ObserverWarning) => {
    if (!caseId) return;
    if (observerWarningContinueDisabled(activeRun, agentBusy, busy)) {
      showToast("An Agent run is already in progress. Wait for it to finish before resuming an Observer warning.");
      return;
    }
    const goal = observerWarningRunGoal(w);
    setBusy(`${w.id}:continue`);
    try {
      addAgentEvent({ kind: "user", text: goal });
      setAgentBusy(true);
      const run = await runAgent(caseId, goal);
      setActiveRun(run);
      const warning = await acceptObserverWarning(w.id);
      upsertWarning(warning);
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

  return <>{warnings.map((w) => (
    (() => {
      const continueDisabled = observerWarningContinueDisabled(activeRun, agentBusy, busy);
      return (
    <article className={`tf-row observer-row ${LEVEL_CLASS[w.level]}`} key={w.id}>
      <div className="observer-row-head">
        <span className={`tf-tag tf-row-level-${w.level}`}>{w.level}</span>
        <span className="observer-row-status">{observerWarningStatusLabel(w.status)}</span>
      </div>
      <strong className="observer-row-title">{w.title}</strong>
      <p className="observer-row-description">{w.description}</p>
      <div className="observer-row-suggestion"><span>Suggested next step</span>{w.suggestedAction}</div>
      {w.status === "open" && (
        <div className="tf-row-actions">
          <button className="tf-btn tf-btn-ghost tf-btn-icon" disabled={continueDisabled} onClick={() => continueRun(w)} title="Start a new Agent run based on the Observer suggestion">
            <Play size={13} weight="fill" /> Resume
          </button>
          <button className="tf-btn tf-btn-ghost tf-btn-icon" disabled={busy !== null} onClick={() => convertToTask(w)} title="Convert this warning into a Task in the Tasks panel">
            <ListPlus size={13} weight="bold" /> Create task
          </button>
          <button className="tf-btn tf-btn-ghost tf-btn-icon" disabled={busy !== null} onClick={() => dismiss(w)} title="Dismiss this warning">
            <X size={13} weight="bold" /> Ignore
          </button>
        </div>
      )}
    </article>
      );
    })()
  ))}</>;
}
