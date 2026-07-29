import { Check, Copy, Eye, EyeSlash, Fingerprint, TerminalWindow, X } from "@phosphor-icons/react";
import type { Fact, ToolFailureDiagnostic } from "@traceforge/shared";
import { confidencePercent } from "../knowledge/knowledge-window.js";
import { Button } from "../ui/button.js";
import { useStore } from "../../store.js";
import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";

const MASK = "••••••••";

function isSensitiveKey(key: string): boolean {
  return /password|secret|token|cookie|authorization|private.?key/i.test(key);
}

function maskSensitiveValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskSensitiveValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, nested]) => [key, isSensitiveKey(key) ? MASK : maskSensitiveValue(nested)]));
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2) ?? String(value ?? "");
}

const TARGET_FEEDBACK_MS = 900;

export function FindingInspector({ fact, targetRequestId = null, onTargetHandled }: { fact: Fact; targetRequestId?: number | null; onTargetHandled?: (requestId: number) => void }) {
  const close = useStore((state) => state.selectFact);
  const [revealed, setRevealed] = useState(false);
  const inspectorRef = useRef<HTMLDivElement>(null);
  const value = stringify(fact.value);
  const maskedValue = stringify(maskSensitiveValue(fact.value));
  const hasSensitiveValue = maskedValue !== value;
  useEffect(() => {
    if (targetRequestId === null) return;
    inspectorRef.current?.focus({ preventScroll: true });
    const timer = globalThis.setTimeout(() => onTargetHandled?.(targetRequestId), TARGET_FEEDBACK_MS);
    return () => globalThis.clearTimeout(timer);
  }, [onTargetHandled, targetRequestId]);
  return <InspectorShell elementRef={inspectorRef} targeted={targetRequestId !== null} kicker="Verified evidence" title={fact.title} icon={<Fingerprint size={15} />} onClose={() => {
    if (targetRequestId !== null) onTargetHandled?.(targetRequestId);
    close(null);
  }}>
    <dl className="inspector-meta"><div><dt>Type</dt><dd>{fact.type}</dd></div><div><dt>Confidence</dt><dd>{confidencePercent(fact.confidence)}%</dd></div><div><dt>Source</dt><dd>{fact.source.type} · {fact.source.ref}</dd></div><div><dt>Fact ID</dt><dd><code>{fact.id}</code></dd></div></dl>
    <InspectorCode label="Evidence" value={revealed ? value : maskedValue} copyValue={value} action={hasSensitiveValue ? <Button variant="ghost" size="icon-xs" aria-label={revealed ? "Hide sensitive evidence" : "Show sensitive evidence"} title={revealed ? "Hide sensitive evidence" : "Show sensitive evidence"} onClick={() => setRevealed((current) => !current)}>{revealed ? <EyeSlash size={13} /> : <Eye size={13} />}</Button> : undefined} />
  </InspectorShell>;
}

export function ToolEventInspector({ event }: { event: { kind: "tool_call" | "tool_result"; label: string; text: string; outcome?: "running" | "succeeded" | "failed" | "recovered" | null; failureDiagnostic?: ToolFailureDiagnostic | null } }) {
  const close = useStore((state) => state.selectAgentEvent);
  const diagnostic = event.failureDiagnostic;
  return <InspectorShell kicker="Agent trace" title={event.label} icon={<TerminalWindow size={15} />} onClose={() => close(null)}>
    {(event.outcome || diagnostic) && <dl className="inspector-meta">
      {event.outcome && <div><dt>Status</dt><dd>{formatDiagnosticLabel(event.outcome)}</dd></div>}
      {diagnostic && <div><dt>Failure type</dt><dd>{formatDiagnosticLabel(diagnostic.category)}</dd></div>}
      {diagnostic && <div><dt>Retry</dt><dd>{diagnostic.retryable ? "Safe to retry with limits" : "Change required before retry"}</dd></div>}
    </dl>}
    {diagnostic && <section className="inspector-diagnostic">
      <strong>{diagnostic.summary}</strong>
      <p>{diagnostic.recommendation}</p>
    </section>}
    <InspectorCode label={event.kind === "tool_call" ? "Arguments" : "Result"} value={event.text} />
  </InspectorShell>;
}

function formatDiagnosticLabel(value: string): string {
  return value.split("_").map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join(" ");
}

export function InspectorShell({ elementRef, targeted = false, kicker, title, icon, onClose, children }: { elementRef?: Ref<HTMLDivElement>; targeted?: boolean; kicker: string; title: string; icon: ReactNode; onClose: () => void; children: ReactNode }) {
  return <div ref={elementRef} tabIndex={-1} aria-current={targeted ? "location" : undefined} className={`context-inspector${targeted ? " is-targeted" : ""}`}><header className="context-inspector-header"><div><span className="section-kicker">{kicker}</span><h2>{icon}{title}</h2></div><Button variant="ghost" size="icon-xs" aria-label="Close inspector" onClick={onClose}><X size={14} /></Button></header><div className="context-inspector-scroll">{children}</div></div>;
}

export function InspectorCode({ label, value, copyValue = value, action }: { label: string; value: string; copyValue?: string; action?: ReactNode }) {
  const showToast = useStore((state) => state.showToast);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(copyValue);
      setCopied(true);
      globalThis.setTimeout(() => setCopied(false), 1200);
    } catch {
      showToast(`Could not copy ${label.toLowerCase()}`);
    }
  };
  return <section className="inspector-data-block"><header><span>{label}</span><div className="inspector-data-actions">{action}<Button variant="ghost" size="icon-xs" aria-label={`Copy ${label}`} title={`Copy ${label}`} onClick={() => void copy()}>{copied ? <Check size={13} /> : <Copy size={13} />}</Button></div></header><pre>{value}</pre></section>;
}
