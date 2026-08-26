import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import type { ScenarioAgentItem } from "@traceforge/shared";
import { orderedAgentProtocolTurns } from "../../agent-runtime-projection.js";
import { useStore } from "../../store.js";

const ROLE_LABELS = {
  planner: "Planner",
  observer: "Observer",
  worker: "Worker",
  replay: "Replay",
  system: "System",
} as const;

export function agentProtocolItemLabel(item: ScenarioAgentItem): string {
  if (item.type === "modelAdmission") return `模型资源 · ${item.status}`;
  if (item.type === "modelCall") return `模型调用 · ${item.routeId} · ${item.status}`;
  if (item.type === "toolCall") return `${item.tool} · ${item.status}`;
  if (item.type === "approval") return `${item.tool} · 审批 ${item.status}`;
  return `${item.eventType} · ${item.summary}`;
}

function itemDetail(item: ScenarioAgentItem): string | null {
  if (item.type === "modelCall" && item.usage) return `${item.usage.totalTokens} tokens`;
  if (item.type === "toolCall") return item.summary;
  if (item.type === "approval") return item.reason;
  if (item.type === "modelAdmission") return item.reason;
  if (item.type === "controlChange") return item.refs.length ? item.refs.join(" · ") : null;
  return item.error;
}

export function AgentRuntimeTimeline() {
  const { projection, syncStatus } = useStore(useShallow((state) => ({
    projection: state.agentProtocol,
    syncStatus: state.agentProtocolSyncStatus,
  })));
  const turns = useMemo(() => orderedAgentProtocolTurns(projection).slice(-24), [projection]);
  if (!projection && syncStatus !== "recovering") return null;

  return (
    <section className="agent-runtime-timeline" aria-label="Agent protocol timeline">
      <header>
        <div><strong>底座运行轨迹</strong><span>{projection?.runId ?? "正在发现 Run"}</span></div>
        <span className={`agent-runtime-sync is-${syncStatus}`}>{syncStatus === "live" ? `已同步 · #${projection?.cursor ?? 0}` : syncStatus === "recovering" ? "同步中" : "已断开"}</span>
      </header>
      {projection && projection.turnOrder.length > turns.length && <p className="agent-runtime-omitted">较早的 {projection.turnOrder.length - turns.length} 个 Turn 已折叠</p>}
      <div className="agent-runtime-turns">
        {turns.map((turn) => (
          <details className={`agent-runtime-turn is-${turn.status}`} key={turn.id} open={turn.status === "running"}>
            <summary>
              <span className="agent-runtime-role">{ROLE_LABELS[turn.role]}</span>
              <span>{turn.workId ? `Work ${turn.workId}` : "Run 控制"}</span>
              <span className="agent-runtime-turn-status">{turn.status}</span>
            </summary>
            <div className="agent-runtime-items">
              {turn.itemOrder.length === 0 && <p>该 Turn 尚未产生动作。</p>}
              {turn.itemOrder.map((itemId) => {
                const item = turn.items[itemId].value;
                const detail = itemDetail(item);
                return <article key={itemId}><span>{agentProtocolItemLabel(item)}</span>{detail && <small>{detail}</small>}</article>;
              })}
              {turn.error && <p className="agent-runtime-error">{turn.error}</p>}
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}
