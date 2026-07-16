import { Check, Copy, Globe, X } from "@phosphor-icons/react";
import type { TrafficEntry } from "@traceforge/shared";
import { useState } from "react";
import { Button } from "../ui/button.js";
import { MethodBadge } from "../design-system/MethodBadge.js";
import { useStore } from "../../store.js";

function DataBlock({ label, value }: { label: string; value: string | null }) {
  return <section className="inspector-data-block"><header><span>{label}</span></header><pre>{value || `No ${label.toLowerCase()} captured`}</pre></section>;
}

export function TrafficInspector({ entry }: { entry: TrafficEntry }) {
  const selectTraffic = useStore((state) => state.selectTraffic);
  const [copied, setCopied] = useState(false);
  const headers = Object.entries(entry.requestHeaders ?? {});
  const copyUrl = async () => {
    await navigator.clipboard.writeText(entry.url);
    setCopied(true);
    globalThis.setTimeout(() => setCopied(false), 1200);
  };

  return <div className="context-inspector">
    <header className="context-inspector-header">
      <div><span className="section-kicker">Selected request</span><h2><Globe size={15} />Request inspector</h2></div>
      <Button variant="ghost" size="icon-xs" aria-label="Close request inspector" title="Close" onClick={() => selectTraffic(null)}><X size={14} /></Button>
    </header>
    <div className="context-inspector-scroll">
      <div className="request-inspector-title"><MethodBadge method={entry.method} /><strong>{entry.responseStatus ?? "Pending"}</strong></div>
      <div className="request-inspector-url"><code>{entry.url}</code><Button variant="ghost" size="icon-xs" aria-label="Copy request URL" title="Copy URL" onClick={() => void copyUrl()}>{copied ? <Check size={14} /> : <Copy size={14} />}</Button></div>
      <dl className="inspector-meta"><div><dt>Observed</dt><dd>{new Date(entry.createdAt).toLocaleString()}</dd></div><div><dt>Request ID</dt><dd><code>{entry.id}</code></dd></div></dl>
      <section className="inspector-data-block"><header><span>Request headers</span><strong>{headers.length}</strong></header>{headers.length ? <dl className="inspector-header-list">{headers.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl> : <p>No request headers captured</p>}</section>
      <DataBlock label="Request body" value={entry.requestBody} />
      <DataBlock label="Response body" value={entry.responseBody} />
    </div>
  </div>;
}
