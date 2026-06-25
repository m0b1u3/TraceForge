import { Warning, ShieldCheck } from "@phosphor-icons/react";
import { useStore } from "../store.js";
import { CaseLauncher } from "./CaseLauncher.js";

export function TopBar() {
  const { caseId, browserController, browserUrl, facts, tasks, warnings } = useStore();
  const crit = warnings.filter((w) => w.level === "critical").length;
  const warnCls = crit > 0 ? "is-crit" : warnings.length > 0 ? "is-alert" : "";
  const controlLabel = browserController === "human" ? "人" : browserController === "llm" ? "LLM" : "未启动";
  const controlClass = browserController === "human" ? "is-human" : browserController === "llm" ? "is-llm" : "";

  return (
    <div className="tf-topbar">
      <span className="tf-brand">TraceForge</span>
      <span className="tf-topbar-div" />
      <CaseLauncher variant="bar" />
      <span className="tf-spacer" />
      {caseId && (
        <>
          <span className="tf-stat">Facts <b>{facts.length}</b></span>
          <span className="tf-stat-sep" />
          <span className="tf-stat">Tasks <b>{tasks.length}</b></span>
          <span className="tf-stat-sep" />
          <span className={`tf-stat ${warnCls}`} title="Observer 监督提示"><Warning size={13} weight="fill" /> <b>{warnings.length}</b></span>
          <span className="tf-stat-sep" />
          <span className={`tf-pill ${controlClass}`}>
            <ShieldCheck size={13} weight="fill" style={{ opacity: 0.7 }} />
            {controlLabel}
            {browserUrl && <span style={{ color: "var(--tf-faint)" }}>· {browserUrl}</span>}
          </span>
        </>
      )}
    </div>
  );
}
