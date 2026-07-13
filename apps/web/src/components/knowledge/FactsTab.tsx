import { useState } from "react";
import { CaretDown } from "@phosphor-icons/react";
import type { Fact } from "@traceforge/shared";
import { useStore } from "../../store.js";

function FactRow({ f }: { f: Fact }) {
  const [open, setOpen] = useState(false);
  const valueStr = typeof f.value === "string" ? f.value : JSON.stringify(f.value, null, 2);
  const detailId = `fact-detail-${f.id}`;
  return (
    <article className={`tf-row tf-row-expandable knowledge-row ${f.validity === "superseded" ? "tf-row-stale" : ""}`}>
      <button className="tf-row-head" type="button" aria-expanded={open} aria-controls={detailId} onClick={() => setOpen((v) => !v)}>
        <span className="tf-tag">{f.type}</span>
        <span className="tf-row-title">{f.title}</span>
        {f.updateCount > 0 && <span className="tf-row-badge">{f.updateCount} updates</span>}
        {f.validity === "superseded" && <span className="tf-row-badge tf-row-badge-stale">Stale</span>}
        <CaretDown className={`knowledge-caret ${open ? "is-open" : ""}`} size={14} aria-hidden="true" />
      </button>
      {open && (
        <div className="tf-row-detail" id={detailId}>
          <div className="kv"><span>Confidence</span>{f.confidence}</div>
          <div className="kv"><span>Source</span>{f.source.type} · {f.source.ref}</div>
          {f.tags.length > 0 && <div className="kv"><span>Tags</span>{f.tags.join(", ")}</div>}
          {valueStr && valueStr !== "{}" && valueStr !== '""' && (
            <div className="tf-row-detail-block"><div className="request-detail-label">Content</div><pre>{valueStr}</pre></div>
          )}
        </div>
      )}
    </article>
  );
}

export function FactsTab() {
  const facts = useStore((s) => s.facts);
  if (facts.length === 0) return <div className="tf-guide"><div className="tf-guide-title">No facts recorded yet.</div><div className="tf-guide-hint">Agent discoveries (interfaces, credentials, vulnerability clues) appear here as Facts. Click to expand details.</div></div>;
  return <>{facts.map((f) => <FactRow f={f} key={f.id} />)}</>;
}
