import { useState } from "react";
import { ChevronDown } from "lucide-react";
import type { Fact } from "@traceforge/shared";
import { useStore } from "../../store.js";
import { FindingField } from "../design-system/FindingField.js";

function FactRow({ f, defaultOpen = false }: { f: Fact; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const valueStr = typeof f.value === "string" ? f.value : JSON.stringify(f.value, null, 2);
  const valueEntries = typeof f.value === "object" && f.value !== null && !Array.isArray(f.value)
    ? Object.entries(f.value as Record<string, unknown>)
    : [];
  const visibleTags = f.tags.filter((tag) => tag.trim().length > 0 && tag.length <= 48).slice(0, 5);
  const detailId = `fact-detail-${f.id}`;
  return (
    <article className={`tf-row tf-row-expandable knowledge-row ${f.validity === "superseded" ? "tf-row-stale" : ""}`}>
      <button className="tf-row-head" type="button" aria-expanded={open} aria-controls={detailId} onClick={() => setOpen((v) => !v)}>
        <span className="tf-tag">{f.type}</span>
        <span className="tf-row-title">{f.title}</span>
        {f.updateCount > 0 && <span className="tf-row-badge">{f.updateCount} updates</span>}
        {f.validity === "superseded" && <span className="tf-row-badge tf-row-badge-stale">Stale</span>}
        <ChevronDown className={`knowledge-caret ${open ? "is-open" : ""}`} size={14} aria-hidden="true" />
      </button>
      {open && (
        <div className="tf-row-detail" id={detailId}>
          {valueEntries.length > 0 ? (
            <div className="fact-value-grid">
              {valueEntries.map(([key, value]) => (
                <FindingField label={key} code key={key}>{String(value ?? "—")}</FindingField>
              ))}
            </div>
          ) : valueStr && valueStr !== "{}" && valueStr !== '""' && (
            <div className="tf-row-detail-block"><div className="request-detail-label">Content</div><pre>{valueStr}</pre></div>
          )}
          <div className="fact-meta-grid">
            <div className="kv"><span>Confidence</span>{f.confidence}</div>
            <div className="kv"><span>Source</span>{f.source.type} · {f.source.ref}</div>
            <div className="kv"><span>Fact ID</span><code>{f.id}</code></div>
            {f.tags.length > 0 && (
              <div className="kv"><span>Tags</span>{visibleTags.length > 0 ? visibleTags.join(", ") : `${f.tags.length} source tag${f.tags.length === 1 ? "" : "s"}`}</div>
            )}
          </div>
        </div>
      )}
    </article>
  );
}

export function FactsTab() {
  const facts = useStore((s) => s.facts);
  if (facts.length === 0) return <div className="tf-guide"><div className="tf-guide-title">No facts recorded yet.</div><div className="tf-guide-hint">Agent discoveries (interfaces, credentials, vulnerability clues) appear here as Facts. Click to expand details.</div></div>;
  return <>{facts.map((f, index) => <FactRow f={f} defaultOpen={index === 0} key={f.id} />)}</>;
}
