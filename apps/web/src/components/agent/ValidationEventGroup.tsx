import { useState } from "react";
import { CaretDown } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { AgentConversationItem } from "./agent-conversation.js";
import { AgentEventRow } from "./AgentEventRow.js";

type ValidationGroup = Extract<AgentConversationItem, { type: "validation_group" }>;

export function ValidationEventGroup({ item }: { item: ValidationGroup }) {
  const [open, setOpen] = useState(false);
  const latest = item.events.at(-1)!;
  const earlier = item.events.slice(0, -1);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className={`validation-event-group${open ? " is-open" : ""}`}>
      <div className="validation-event-group-control">
        <CollapsibleTrigger asChild>
          <Button type="button" variant="ghost" size="sm" aria-label={open ? "Hide earlier validation transitions" : "Show earlier validation transitions"}>
            <CaretDown size={12} className={open ? "is-open" : ""} aria-hidden="true" />
            {earlier.length} earlier {earlier.length === 1 ? "transition" : "transitions"}
          </Button>
        </CollapsibleTrigger>
        <span>{item.target.kind} · {item.target.id}</span>
      </div>
      <CollapsibleContent className="validation-event-group-history">
        {earlier.map((event) => <AgentEventRow item={event} key={event.key} />)}
      </CollapsibleContent>
      <AgentEventRow item={latest} />
    </Collapsible>
  );
}
