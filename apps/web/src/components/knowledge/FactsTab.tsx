import { useStore } from "../../store.js";
export function FactsTab() {
  const facts = useStore((s) => s.facts);
  if (facts.length === 0) return <div className="tf-guide"><div className="tf-guide-title">暂无 Fact</div><div className="tf-guide-hint">Agent 探索时把可靠发现（接口、凭据、漏洞线索）记为 Fact，会出现在这里。</div></div>;
  return <>{facts.map((f) => <div className="tf-row" key={f.id}><span className="tf-tag">{f.type}</span>{f.title}</div>)}</>;
}
