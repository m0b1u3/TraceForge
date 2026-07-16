import { memo, useState, type ReactNode } from "react";
import { Brain, CaretDown, Check, CheckCircle, Copy, MagnifyingGlass, Robot, TerminalWindow, User, Warning } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { AgentConversationEventItem } from "./agent-conversation.js";
import { useStore } from "../../store.js";

export const AgentEventRow = memo(function AgentEventRow({ item }: { item: AgentConversationEventItem }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const selectAgentEvent = useStore((state) => state.selectAgentEvent);
  const isReasoning = item.kind === "reasoning";
  const isTool = item.kind === "tool_call" || item.kind === "tool_result";
  const canExpand = isReasoning || (isTool && item.summary !== item.text);
  const inspect = isTool ? () => selectAgentEvent({ kind: item.kind, label: item.label, text: item.text }) : undefined;

  if (canExpand) {
    return (
      <Collapsible
        open={expanded}
        onOpenChange={setExpanded}
        className={`agent-event ${eventClassName(item.kind)} ${expanded ? "is-expanded" : ""}`}
      >
        <EventHeader item={item}>
          <EventActions text={item.text} copied={copied} onCopiedChange={setCopied} onInspect={inspect}>
            <CollapsibleTrigger asChild>
              <Button type="button" variant="ghost" size="icon-xs" aria-label={expanded ? "Collapse event" : "Expand event"} title={expanded ? "Collapse" : "Expand"}>
                <CaretDown className={`agent-event-chevron ${expanded ? "is-open" : ""}`} size={14} />
              </Button>
            </CollapsibleTrigger>
          </EventActions>
        </EventHeader>
        {!expanded && <p className="agent-event-content">{item.summary}</p>}
        <CollapsibleContent>
          <p className="agent-event-content">{item.text}</p>
        </CollapsibleContent>
      </Collapsible>
    );
  }

  return (
    <article className={`agent-event ${eventClassName(item.kind)}`}>
      <EventHeader item={item}><EventActions text={item.text} copied={copied} onCopiedChange={setCopied} onInspect={inspect} /></EventHeader>
      <p className="agent-event-content">{item.text}</p>
    </article>
  );
}, (previous, next) => previous.item.key === next.item.key && previous.item.kind === next.item.kind && previous.item.label === next.item.label && previous.item.text === next.item.text && previous.item.summary === next.item.summary);

function EventActions({
  text,
  copied,
  onCopiedChange,
  children,
  onInspect,
}: {
  text: string;
  copied: boolean;
  onCopiedChange: (copied: boolean) => void;
  children?: ReactNode;
  onInspect?: () => void;
}) {
  const copy = async () => {
    await navigator.clipboard.writeText(text);
    onCopiedChange(true);
    globalThis.setTimeout(() => onCopiedChange(false), 1200);
  };
  return (
    <span className="agent-event-actions">
      {onInspect && <Button type="button" variant="ghost" size="icon-xs" aria-label="Inspect event" title="Inspect" onClick={onInspect}><MagnifyingGlass size={13} /></Button>}
      <Button type="button" variant="ghost" size="icon-xs" aria-label="Copy event" title="Copy" onClick={() => void copy()}>
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </Button>
      {children}
    </span>
  );
}

function EventHeader({ item, children }: { item: AgentConversationEventItem; children?: ReactNode }) {
  return (
    <div className="agent-event-header">
      <span className="agent-event-icon" aria-hidden="true">{eventIcon(item.kind)}</span>
      <span className="agent-event-label">{item.label}</span>
      {children}
    </div>
  );
}

function eventClassName(kind: AgentConversationEventItem["kind"]): string {
  if (kind === "user") return "is-operator";
  if (kind === "error") return "is-error";
  if (kind === "reasoning") return "is-reasoning";
  if (kind === "tool_call" || kind === "tool_result") return "is-tool";
  if (kind === "done") return "is-complete";
  return "is-agent";
}

function eventIcon(kind: AgentConversationEventItem["kind"]) {
  if (kind === "user") return <User size={14} />;
  if (kind === "error") return <Warning size={17} weight="fill" />;
  if (kind === "reasoning") return <Brain size={17} weight="duotone" />;
  if (kind === "tool_call") return <TerminalWindow size={17} weight="duotone" />;
  if (kind === "tool_result") return <CheckCircle size={17} weight="duotone" />;
  if (kind === "done") return <CheckCircle size={17} weight="fill" />;
  return <Robot size={17} weight="duotone" />;
}
