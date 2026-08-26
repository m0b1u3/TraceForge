import { ArrowLeft, Gear } from "@phosphor-icons/react";
import { useShallow } from "zustand/react/shallow";
import { useStore } from "../store.js";
import { AgentPanel } from "./AgentPanel.js";
import { ScenarioOperationsPanel } from "./ScenarioOperationsPanel.js";

export default function Workbench() {
  const { caseId, cases, connection, leaveCase, openSettings } = useStore(useShallow((state) => ({
    caseId: state.caseId,
    cases: state.cases,
    connection: state.connectionStatus,
    leaveCase: state.leaveCase,
    openSettings: () => state.setSettingsModalOpen(true),
  })));
  const current = cases.find((entry) => entry.id === caseId);
  return (
    <div className="foundation-workbench">
      <header className="foundation-topbar">
        <button className="tf-btn tf-btn-ghost" type="button" onClick={leaveCase}><ArrowLeft size={14} />返回</button>
        <div><strong>{current?.name ?? "TraceForge"}</strong><span>{current?.scopeRules.flatMap((rule) => rule.allowHosts).join(", ") || "未配置目标"}</span></div>
        <div className="foundation-topbar-actions"><span className={`console-status is-${connection}`}><i />{connection}</span><button className="tf-btn tf-btn-ghost" type="button" onClick={openSettings}><Gear size={14} />设置</button></div>
      </header>
      <section className="foundation-workspace"><div className="foundation-operations-layout"><ScenarioOperationsPanel /><AgentPanel /></div></section>
    </div>
  );
}
