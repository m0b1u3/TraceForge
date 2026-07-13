import { useState, type ReactNode } from "react";
import {
  Brain,
  CheckCircle,
  Robot,
  TerminalWindow,
  User,
  WarningCircle,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { AgentConversationEventItem } from "./agent-conversation.js";

export function AgentEventRow({ item }: { item: AgentConversationEventItem }) {
  const [expanded, setExpanded] = useState(false);
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
          <CollapsibleTrigger asChild>
            <Button type="button" variant="ghost" size="xs">
              {expanded ? "Collapse" : "Expand"}
            </Button>
          </CollapsibleTrigger>
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
      <EventHeader item={item} />
      <p className="agent-event-content">{item.text}</p>
    </article>
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
  if (kind === "error") return <WarningCircle size={14} weight="fill" />;
  if (kind === "reasoning") return <Brain size={14} />;
  if (kind === "tool_call" || kind === "tool_result") return <TerminalWindow size={14} />;
  if (kind === "done") return <CheckCircle size={14} weight="fill" />;
  return <Robot size={14} />;
}
