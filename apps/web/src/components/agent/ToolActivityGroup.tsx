import { useEffect, useMemo, useState } from "react";
import { ArrowClockwise, CaretDown, Check, Copy, MagnifyingGlass, TerminalWindow, WarningCircle } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useStore } from "../../store.js";
import type { AgentConversationItem, AgentToolActivity } from "./agent-conversation.js";
import { RefChips } from "./AgentEventRow.js";

type ToolGroup = Extract<AgentConversationItem, { type: "tool_group" }>;
type ActivityTone = "running" | "complete" | "evidence" | "issue" | "recovered";

export function toolActivityTone(activity: AgentToolActivity): ActivityTone {
  if (!activity.result) return "running";
  if (activity.outcome === "recovered") return "recovered";
  if (activity.outcome === "failed") return "issue";
  const refs = activity.result.refs;
  if (refs && (refs.factIds.length > 0 || refs.taskIds.length > 0 || refs.timelineEntryIds.length > 0)) return "evidence";
  if (/^\s*[A-Za-z0-9_:-]+\s*(?:(?:→|->)\s*)?(?:error|failed|blocked|denied|timeout|exception)\b/i.test(activity.result.text)) return "issue";
  return "complete";
}

export function ToolActivityGroup({ item }: { item: ToolGroup }) {
  const important = item.activities.some((activity) => {
    const tone = toolActivityTone(activity);
    return tone === "evidence" || tone === "issue";
  });
  const [open, setOpen] = useState(important);
  const latest = item.activities.at(-1)!;
  const tone = useMemo(() => groupTone(item.activities), [item.activities]);
  const label = toneLabel(tone, item.activities.length);
  const latestEvent = latest.result ?? latest.call;
  const selectAgentEvent = useStore((state) => state.selectAgentEvent);

  useEffect(() => {
    if (important) setOpen(true);
  }, [important]);

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={`tool-activity-group is-${tone}${open ? " is-open" : ""}`}
    >
      <div className="tool-activity-summary">
        <CollapsibleTrigger asChild>
          <button type="button" className="tool-activity-trigger" aria-label={open ? `Collapse ${item.tool} activity` : `Expand ${item.tool} activity`}>
            <span className="tool-activity-icon" aria-hidden="true">
              {tone === "issue"
                ? <WarningCircle size={14} weight="fill" />
                : tone === "recovered"
                  ? <ArrowClockwise size={14} weight="bold" />
                  : <TerminalWindow size={14} />}
            </span>
            <code className="tool-activity-name">{item.tool}</code>
            {item.activities.length > 1 && <span className="tool-activity-count">×{item.activities.length}</span>}
            <span className={`tool-activity-state is-${tone}`}><span aria-hidden="true" />{label}</span>
            {latestEvent?.createdAt && (
              <time dateTime={latestEvent.createdAt} title={new Date(latestEvent.createdAt).toLocaleString()}>
                {new Date(latestEvent.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
              </time>
            )}
            <CaretDown className="tool-activity-chevron" size={13} aria-hidden="true" />
          </button>
        </CollapsibleTrigger>
        {latestEvent && (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`Inspect ${item.tool} activity`}
            title="Inspect raw event"
            onClick={() => selectAgentEvent({ kind: latestEvent.kind as "tool_call" | "tool_result", label: latestEvent.label, text: latestEvent.text })}
          >
            <MagnifyingGlass size={13} />
          </Button>
        )}
      </div>
      <CollapsibleContent className="tool-activity-details">
        {item.activities.map((activity, index) => (
          <ToolActivityDetail activity={activity} index={index} count={item.activities.length} key={activity.key} />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

function ToolActivityDetail({ activity, index, count }: { activity: AgentToolActivity; index: number; count: number }) {
  const [copied, setCopied] = useState(false);
  const callText = activity.call?.text ?? "";
  const resultText = activity.result?.text ?? "";
  const raw = [callText, resultText].filter(Boolean).join("\n\n");
  const copy = async () => {
    await navigator.clipboard.writeText(raw);
    setCopied(true);
    globalThis.setTimeout(() => setCopied(false), 1200);
  };

  return (
    <section className="tool-activity-detail" data-conversation-key={activity.call?.key ?? activity.result?.key}>
      <header>
        <span>{count > 1 ? `Execution ${index + 1}` : "Execution detail"}</span>
        <span className={`tool-activity-state is-${toolActivityTone(activity)}`}>{toneLabel(toolActivityTone(activity), 1)}</span>
        <Button type="button" variant="ghost" size="icon-xs" aria-label="Copy tool activity" title="Copy" onClick={() => void copy()}>
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </Button>
      </header>
      {activity.call && <ToolPayload label="Arguments" value={activity.call.text} />}
      {activity.result && <ToolPayload label="Result" value={activity.result.text} />}
      {activity.result?.refs && <RefChips refs={activity.result.refs} />}
    </section>
  );
}

function ToolPayload({ label, value }: { label: string; value: string }) {
  return (
    <div className="tool-activity-payload">
      <span>{label}</span>
      <pre>{value}</pre>
    </div>
  );
}

function groupTone(activities: AgentToolActivity[]): ActivityTone {
  const tones = activities.map(toolActivityTone);
  if (tones.includes("issue")) return "issue";
  if (tones.includes("evidence")) return "evidence";
  if (tones.includes("running")) return "running";
  if (tones.includes("recovered")) return "recovered";
  return "complete";
}

function toneLabel(tone: ActivityTone, count: number): string {
  if (tone === "issue") return "Needs attention";
  if (tone === "recovered") return count > 1 ? "Recovered execution" : "Recovered";
  if (tone === "evidence") return "Produced evidence";
  if (tone === "running") return "Running";
  return count > 1 ? `${count} completed` : "Completed";
}
