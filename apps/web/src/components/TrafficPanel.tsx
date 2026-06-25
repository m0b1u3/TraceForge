import { useStore } from "../store.js";

export function TrafficPanel() {
  const traffic = useStore((s) => s.traffic);
  return (
    <div className="tf-panel">
      <div className="tf-panel-head">流量 <span className="tf-count">{traffic.length}</span></div>
      <div className="tf-panel-body">
        {traffic.length === 0 && <div className="tf-empty">暂无流量（启动浏览器或运行 agent 后出现）</div>}
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
