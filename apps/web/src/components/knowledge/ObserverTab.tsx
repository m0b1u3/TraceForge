import { useStore } from "../../store.js";

const LEVEL_COLOR: Record<string, string> = { critical: "var(--tf-err)", warning: "var(--tf-warn)", info: "var(--tf-muted)" };

export function ObserverTab() {
  const warnings = useStore((s) => s.warnings);
  if (warnings.length === 0) return <div className="tf-empty">暂无监督提示（agent 运行后由 Observer 产出）。</div>;
  return <>{warnings.map((w) => (
    <div className="tf-row" key={w.id} style={{ borderLeft: `2px solid ${LEVEL_COLOR[w.level]}`, paddingLeft: 8 }}>
      <span style={{ color: LEVEL_COLOR[w.level] }}>[{w.level}]</span> {w.title}
      <div style={{ color: "var(--tf-muted)", marginTop: 2 }}>{w.description}</div>
      <div style={{ color: "var(--tf-faint)", marginTop: 2 }}>建议：{w.suggestedAction}</div>
    </div>
  ))}</>;
}
