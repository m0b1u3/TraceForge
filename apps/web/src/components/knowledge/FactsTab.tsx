import { useStore } from "../../store.js";
export function FactsTab() {
  const facts = useStore((s) => s.facts);
  if (facts.length === 0) return <div className="tf-empty">暂无 Fact。</div>;
  return <>{facts.map((f) => <div className="tf-row" key={f.id}><span className="tf-tag">{f.type}</span>{f.title}</div>)}</>;
}
