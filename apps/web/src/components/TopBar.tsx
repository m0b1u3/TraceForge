import { Warning, ShieldCheck } from "@phosphor-icons/react";
import type { ObserverWarning } from "@traceforge/shared";
import { useStore } from "../store.js";
import { CaseLauncher } from "./CaseLauncher.js";

export function observerWarningTopBarState(warnings: Pick<ObserverWarning, "level" | "status">[]): { count: number; className: string } {
  const open = warnings.filter((w) => w.status === "open");
  const hasCritical = open.some((w) => w.level === "critical");
  return { count: open.length, className: hasCritical ? "is-crit" : open.length > 0 ? "is-alert" : "" };
}

export function TopBar() {
  const { caseId, browserController, browserUrl, facts, tasks, warnings } = useStore();
  const warningState = observerWarningTopBarState(warnings);
  const controlLabel = browserController === "human" ? "人" : browserController === "llm" ? "LLM" : "未启动";
  const controlClass = browserController === "human" ? "is-human" : browserController === "llm" ? "is-llm" : "";

  return (
    <header className="topbar">
      <div className="brand"><span><ShieldCheck size={16} /></span><div><strong>TraceForge</strong><small>授权红队工作台</small></div></div>
      <nav><CaseLauncher variant="bar" /></nav>
      <div className="run-id">
        {caseId && (
          <>
            <span className="tf-stat">Facts <b>{facts.length}</b></span>
            <span className="tf-stat">Tasks <b>{tasks.length}</b></span>
            <span className={`tf-stat ${warningState.className}`} title="待处理 Observer 提示"><Warning size={13} weight="fill" /> <b>{warningState.count}</b></span>
            <span className={`tf-pill ${controlClass}`}><ShieldCheck size={13} weight="fill" />{controlLabel}{browserUrl && <span style={{ color: "var(--faint)" }}>· {browserUrl}</span>}</span>
          </>
        )}
      </div>
    </header>
  );
}
