import { ShieldCheck } from "@phosphor-icons/react";
import { useStore } from "../store.js";
import { CaseLauncher } from "./CaseLauncher.js";

export function TopBar() {
  const { caseId, browserController, browserUrl } = useStore();
  const controlLabel = browserController === "human" ? "human" : browserController === "llm" ? "llm" : "idle";
  const controlPillClass = browserController === "human" ? "tf-pill-amber" : browserController === "llm" ? "tf-pill-accent" : "";

  return (
    <header className="topbar">
      <div className="brand">
        <span><ShieldCheck size={16} /></span>
        <div><strong>TraceForge</strong><small>red-team workbench</small></div>
      </div>
      <nav><CaseLauncher variant="bar" /></nav>
      <div className="run-id">
        {caseId && (
          <span className={`tf-pill ${controlPillClass}`}>
            <ShieldCheck size={13} weight="fill" />
            {controlLabel}
            {browserUrl && <span style={{ color: "var(--text-tertiary)" }}>· {browserUrl}</span>}
          </span>
        )}
      </div>
    </header>
  );
}
