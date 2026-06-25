import { Pulse } from "@phosphor-icons/react";
import { useStore } from "../store.js";

export function TrafficPanel() {
  const traffic = useStore((s) => s.traffic);
  return (
    <div className="tf-panel">
      <div className="tf-panel-head">流量 <span className="tf-count">{traffic.length}</span></div>
      <div className="tf-panel-body">
        {traffic.length === 0 && (
          <div className="tf-guide">
            <div className="tf-guide-icon"><Pulse size={22} weight="duotone" /></div>
            <div className="tf-guide-title">暂无流量</div>
            <div className="tf-guide-hint">启动共享浏览器后，你和 Agent 的访问都会实时出现在这里。</div>
          </div>
        )}
        {traffic.map((t) => (
          <div className="tf-row" key={t.id}>
            <span className={`tf-status-${String(t.responseStatus).charAt(0)}`}>{t.responseStatus}</span>{" "}
            <span style={{ color: "var(--tf-muted)" }}>{t.method}</span> {t.url}
          </div>
        ))}
      </div>
    </div>
  );
}
