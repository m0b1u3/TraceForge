import { useState } from "react";
import { CaretDown, Check, Copy, Eye, EyeSlash } from "@phosphor-icons/react";
import type { Fact } from "@traceforge/shared";
import { Button } from "@/components/ui/button";
import { useStore } from "../../store.js";
import { FindingField } from "../design-system/FindingField.js";
import { SeverityBadge, type Severity } from "../design-system/SeverityBadge.js";

function factSeverity(fact: Fact): Severity {
  const text = [fact.type, fact.title, ...fact.tags].join(" ").toLowerCase();
  if (/critical|rce|remote code execution/.test(text)) return "critical";
  if (/high|credential|password|secret|injection|ssrf|xxe|auth bypass|file.read/.test(text)) return "high";
  if (/medium|xss|csrf|misconfig/.test(text)) return "medium";
  if (/low/.test(text)) return "low";
  return "info";
}

function isSensitiveField(key: string): boolean {
  return /password|secret|token|cookie|authorization|private.?key/i.test(key);
}

function FactRow({ fact, defaultOpen = false }: { fact: Fact; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [showSensitive, setShowSensitive] = useState(false);
  const [copied, setCopied] = useState(false);
  const valueString = typeof fact.value === "string" ? fact.value : JSON.stringify(fact.value, null, 2);
  const entries = typeof fact.value === "object" && fact.value !== null && !Array.isArray(fact.value)
    ? Object.entries(fact.value as Record<string, unknown>)
    : [];
  const visibleTags = fact.tags.filter((tag) => tag.trim().length > 0 && tag.length <= 48).slice(0, 5);
  const detailId = `fact-detail-${fact.id}`;
  const hasSensitive = entries.some(([key]) => isSensitiveField(key));

  const copyEvidence = async () => {
    await navigator.clipboard.writeText(valueString);
    setCopied(true);
    globalThis.setTimeout(() => setCopied(false), 1200);
  };

  return (
    <article className={`tf-row tf-row-expandable knowledge-row finding-card ${fact.validity === "superseded" ? "tf-row-stale" : ""}`}>
      <button className="tf-row-head" type="button" aria-expanded={open} aria-controls={detailId} onClick={() => setOpen((value) => !value)}>
        <span className="finding-heading">
          <span className="finding-heading-meta"><span className="tf-tag">{fact.type}</span><SeverityBadge severity={factSeverity(fact)} /></span>
          <span className="tf-row-title">{fact.title}</span>
        </span>
        {fact.updateCount > 0 && <span className="tf-row-badge">{fact.updateCount} updates</span>}
        {fact.validity === "superseded" && <span className="tf-row-badge tf-row-badge-stale">Stale</span>}
        <CaretDown className={`knowledge-caret ${open ? "is-open" : ""}`} size={14} aria-hidden="true" />
      </button>
      {open && (
        <div className="tf-row-detail" id={detailId}>
          <div className="finding-detail-toolbar">
            <span>Evidence detail</span>
            <div>
              {hasSensitive && (
                <Button type="button" variant="ghost" size="icon-xs" aria-label={showSensitive ? "Hide sensitive values" : "Show sensitive values"} title={showSensitive ? "Hide sensitive values" : "Show sensitive values"} onClick={() => setShowSensitive((value) => !value)}>
                  {showSensitive ? <EyeSlash size={14} /> : <Eye size={14} />}
                </Button>
              )}
              <Button type="button" variant="ghost" size="icon-xs" aria-label="Copy finding evidence" title="Copy evidence" onClick={() => void copyEvidence()}>
                {copied ? <Check size={14} /> : <Copy size={14} />}
              </Button>
            </div>
          </div>
          {entries.length > 0 ? (
            <div className="fact-value-grid">
              {entries.map(([key, value]) => (
                <FindingField label={key} code key={key}>{isSensitiveField(key) && !showSensitive ? "••••••••" : String(value ?? "—")}</FindingField>
              ))}
            </div>
          ) : valueString && valueString !== "{}" && valueString !== '""' && (
            <div className="tf-row-detail-block"><div className="request-detail-label">Evidence</div><pre>{valueString}</pre></div>
          )}
          <div className="fact-meta-grid">
            <div className="kv"><span>Confidence</span>{Math.round(fact.confidence * 100)}%</div>
            <div className="kv"><span>Source</span>{fact.source.type} · {fact.source.ref}</div>
            <div className="kv"><span>Fact ID</span><code>{fact.id}</code></div>
            <div className="kv"><span>Observed</span><time dateTime={fact.createdAt}>{new Date(fact.createdAt).toLocaleString()}</time></div>
            {fact.tags.length > 0 && <div className="kv"><span>Tags</span>{visibleTags.length > 0 ? visibleTags.join(", ") : `${fact.tags.length} source tags`}</div>}
          </div>
        </div>
      )}
    </article>
  );
}

export function FactsTab() {
  const facts = useStore((state) => state.facts);
  if (facts.length === 0) {
    return (
      <div className="inspector-empty">
        <div className="inspector-empty-eyebrow"><span />Evidence pipeline</div>
        <h3>Awaiting verified evidence</h3>
        <p>Facts appear only after the Agent can connect an observation to its source.</p>
        <ol>
          <li><span>01</span>Capture traffic or tool output</li>
          <li><span>02</span>Correlate the observation</li>
          <li><span>03</span>Record a sourced fact</li>
        </ol>
      </div>
    );
  }
  return <>{facts.map((fact, index) => <FactRow fact={fact} defaultOpen={index === 0} key={fact.id} />)}</>;
}
