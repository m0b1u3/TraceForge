import { useStore } from "../../store.js";

const LEVEL_COLOR: Record<string, string> = { critical: "var(--tf-err)", warning: "var(--tf-warn)", info: "var(--tf-muted)" };

export function ObserverTab() {
  const warnings = useStore((s) => s.warnings);
  if (warnings.length === 0) return <div className="tf-guide"><div className="tf-guide-title">暂无监督提示</div><div className="tf-guide-hint">每轮 Agent 运行结束，Observer 会旁路审视它有无无依据猜测、忽略已有信息、过早结束等问题，并在此提示。</div></div>;
  return <>{warnings.map((w) => (
    <div className="tf-row" key={w.id} style={{ borderLeft: `2px solid ${LEVEL_COLOR[w.level]}`, paddingLeft: 8 }}>
      <span style={{ color: LEVEL_COLOR[w.level] }}>[{w.level}]</span> {w.title}
      <div style={{ color: "var(--tf-muted)", marginTop: 2 }}>{w.description}</div>
      <div style={{ color: "var(--tf-faint)", marginTop: 2 }}>建议：{w.suggestedAction}</div>
    </div>
  ))}</>;
}
