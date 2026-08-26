import { ArrowClockwise, Pulse } from "@phosphor-icons/react";
import { useShallow } from "zustand/react/shallow";
import { useStore } from "../store.js";
import { AgentRuntimeTimeline } from "./agent/AgentRuntimeTimeline.js";

export function AgentPanel() {
  const { projection, syncStatus, refresh } = useStore(useShallow((state) => ({
    projection: state.agentProtocol,
    syncStatus: state.agentProtocolSyncStatus,
    refresh: state.refreshAgentProtocol,
  })));
  return (
    <main className="panel chat-panel foundation-console">
      <header className="panel-header agent-console-header">
        <div><h2>智能体运行</h2><p>Scenario Control Plane · protocol v1</p></div>
        <button className="tf-btn tf-btn-ghost" type="button" onClick={() => void refresh()} disabled={syncStatus === "recovering"}>
          <ArrowClockwise size={13} />同步
        </button>
      </header>
      <AgentRuntimeTimeline />
      {!projection && syncStatus !== "recovering" && (
        <section className="foundation-console-empty">
          <Pulse size={26} weight="duotone" />
          <strong>当前 Case 还没有 Scenario Run</strong>
          <p>旧聊天式 Agent 已移除。新的运行入口只接受 Scenario Profile、授权范围和结构化目标。</p>
        </section>
      )}
    </main>
  );
}
