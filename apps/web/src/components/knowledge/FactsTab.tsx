import { useState } from "react";
import type { Fact } from "@traceforge/shared";
import { useStore } from "../../store.js";

function FactRow({ f }: { f: Fact }) {
  const [open, setOpen] = useState(false);
  const valueStr = typeof f.value === "string" ? f.value : JSON.stringify(f.value, null, 2);
  return (
    <div className={`tf-row tf-row-expandable ${f.validity === "superseded" ? "tf-row-stale" : ""}`}>
      <div className="tf-row-head" onClick={() => setOpen((v) => !v)}>
        <span className="tf-tag">{f.type}</span>
        <span className="tf-row-title">{f.title}</span>
        {f.updateCount > 0 && <span className="tf-row-badge">{f.updateCount} 次更新</span>}
        {f.validity === "superseded" && <span className="tf-row-badge tf-row-badge-stale">已失效</span>}
      </div>
      {open && (
        <div className="tf-row-detail">
          <div className="kv"><span>置信度</span>{f.confidence}</div>
          <div className="kv"><span>来源</span>{f.source.type} · {f.source.ref}</div>
          {f.tags.length > 0 && <div className="kv"><span>标签</span>{f.tags.join(", ")}</div>}
          {valueStr && valueStr !== "{}" && valueStr !== '""' && (
            <div className="tf-row-detail-block"><div className="request-detail-label">内容</div><pre>{valueStr}</pre></div>
          )}
        </div>
      )}
    </div>
  );
}

export function FactsTab() {
  const facts = useStore((s) => s.facts);
  if (facts.length === 0) return <div className="tf-guide"><div className="tf-guide-title">暂无 Fact</div><div className="tf-guide-hint">Agent 探索时把可靠发现（接口、凭据、漏洞线索）记为 Fact，会出现在这里。点开可看详情。</div></div>;
  return <>{facts.map((f) => <FactRow f={f} key={f.id} />)}</>;
}
