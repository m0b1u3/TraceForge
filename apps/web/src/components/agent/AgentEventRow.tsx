import { useState, type ReactNode } from "react";
import { Brain, CaretDown, Check, CheckCircle, Copy, Robot, TerminalWindow, User, Warning } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { AgentConversationEventItem } from "./agent-conversation.js";

export function AgentEventRow({ item }: { item: AgentConversationEventItem }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const isReasoning = item.kind === "reasoning";
  const isTool = item.kind === "tool_call" || item.kind === "tool_result";
  const canExpand = isReasoning || (isTool && item.summary !== item.text);

  if (canExpand) {
    return (
      <Collapsible
        open={expanded}
        onOpenChange={setExpanded}
        className={`agent-event ${eventClassName(item.kind)} ${expanded ? "is-expanded" : ""}`}
      >
        <EventHeader item={item}>
          <EventActions text={item.text} copied={copied} onCopiedChange={setCopied}>
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
      <EventHeader item={item}><EventActions text={item.text} copied={copied} onCopiedChange={setCopied} /></EventHeader>
      <p className="agent-event-content">{item.text}</p>
    </article>
  );
}

function EventActions({
  text,
  copied,
  onCopiedChange,
  children,
}: {
  text: string;
  copied: boolean;
  onCopiedChange: (copied: boolean) => void;
  children?: ReactNode;
}) {
  const copy = async () => {
    await navigator.clipboard.writeText(text);
    onCopiedChange(true);
    globalThis.setTimeout(() => onCopiedChange(false), 1200);
  };
  return (
    <span className="agent-event-actions">
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
