import { useState } from "react";
import { ListPlus, Play, X } from "@phosphor-icons/react";
import type { AgentRun, ObserverWarning } from "@traceforge/shared";
import { acceptObserverWarning, convertObserverWarningToTask, dismissObserverWarning, runAgent } from "../../api.js";
import { useStore } from "../../store.js";

const LEVEL_COLOR: Record<string, string> = { critical: "var(--red)", warning: "var(--amber)", info: "var(--muted)" };
const STATUS_LABEL: Record<ObserverWarning["status"], string> = {
  open: "待处理",
  accepted: "已继续",
  converted_to_task: "已转 Task",
  dismissed: "已忽略",
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
  if (warnings.length === 0) return <div className="tf-guide"><div className="tf-guide-title">暂无监督提示</div><div className="tf-guide-hint">每轮 Agent 运行结束，Observer 会旁路审视它有无无依据猜测、忽略已有信息、过早结束等问题，并在此提示。</div></div>;

  const continueRun = async (w: ObserverWarning) => {
    if (!caseId) return;
    if (observerWarningContinueDisabled(activeRun, agentBusy, busy)) {
      showToast("已有 Agent run 正在运行，请等待结束后再继续 Observer 提示");
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
    <div className="tf-row" key={w.id} style={{ borderLeft: `2px solid ${LEVEL_COLOR[w.level]}`, paddingLeft: 8 }}>
      <span style={{ color: LEVEL_COLOR[w.level] }}>[{w.level}]</span>
      <span className="tf-tag">{observerWarningStatusLabel(w.status)}</span>
      {w.title}
      <div style={{ color: "var(--muted)", marginTop: 2 }}>{w.description}</div>
      <div style={{ color: "var(--faint)", marginTop: 2 }}>建议：{w.suggestedAction}</div>
      {w.status === "open" && (
        <div className="tf-row-actions">
          <button className="tf-btn tf-btn-ghost tf-btn-icon" disabled={continueDisabled} onClick={() => continueRun(w)} title="按 Observer 建议启动一个新的 Agent run">
            <Play size={13} weight="fill" /> 继续运行
          </button>
          <button className="tf-btn tf-btn-ghost tf-btn-icon" disabled={busy !== null} onClick={() => convertToTask(w)} title="把该提示转成 Tasks 面板中的待办">
            <ListPlus size={13} weight="bold" /> 创建 Task
          </button>
          <button className="tf-btn tf-btn-ghost tf-btn-icon" disabled={busy !== null} onClick={() => dismiss(w)} title="关闭该提示">
            <X size={13} weight="bold" /> 忽略
          </button>
        </div>
      )}
    </div>
      );
    })()
  ))}</>;
}
