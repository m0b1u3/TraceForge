import { memo, useState, type ReactNode } from "react";
import { ArrowSquareOut, Brain, CaretDown, Check, CheckCircle, Copy, MagnifyingGlass, Robot, ShieldCheck, TerminalWindow, User, Warning } from "@phosphor-icons/react";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { AgentConversationEventItem } from "./agent-conversation.js";
import { rulerToolName } from "./RunTimelineRuler.js";
import { useStore } from "../../store.js";
import type { AgentEventRefs, Fact, Task, ValidationWorkflowSnapshot } from "@traceforge/shared";

type ValidationState = { label: "Active" | "Current" | "Blocked" | "Resolved" | "Satisfied" | "Released" | "Deferred" | "Recorded" | "Superseded" | "Unavailable"; tone: "active" | "warning" | "muted" };

export function validationEventState(eventType: string | undefined, target: AgentConversationEventItem["target"], workflow: ValidationWorkflowSnapshot | null, task: Task | null, fact: Fact | null): ValidationState {
  if (!target || (!task && !fact)) return { label: "Unavailable", tone: "muted" };
  const item = workflow?.items.find((entry) => entry.taskId === target.id || entry.findingId === target.id);
  if (eventType === "validation_task_claimed") return workflow?.runningLease === target.id ? { label: "Active", tone: "active" } : { label: "Superseded", tone: "muted" };
  if (eventType === "validation_task_released" || eventType === "validation_task_lease_released") return { label: "Released", tone: "muted" };
  if (eventType === "validation_priority_shifted") return workflow?.leader?.taskId === target.id ? { label: "Current", tone: "active" } : { label: "Superseded", tone: "muted" };
  if (eventType === "validation_task_completion_blocked") return item && !item.completionReady ? { label: "Blocked", tone: "warning" } : { label: "Resolved", tone: "active" };
  if (eventType === "validation_task_completed") return item?.completionReady || fact?.findingStatus === "verified" ? { label: "Satisfied", tone: "active" } : { label: "Recorded", tone: "muted" };
  if (eventType === "validation_priority_deferred") return (workflow?.exploration.explorationBoundariesRemaining ?? 0) > 0 ? { label: "Deferred", tone: "warning" } : { label: "Recorded", tone: "muted" };
  return { label: "Recorded", tone: "muted" };
}

export const AgentEventRow = memo(function AgentEventRow({ item }: { item: AgentConversationEventItem }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const selectAgentEvent = useStore((state) => state.selectAgentEvent);
  const navigateToKnowledge = useStore((state) => state.navigateToKnowledge);
  const workflow = useStore((state) => state.validationWorkflow);
  const targetTask = useStore((state) => item.target?.kind === "task" ? state.tasks.find((task) => task.id === item.target?.id) ?? null : null);
  const targetFact = useStore((state) => item.target?.kind === "finding" ? state.facts.find((fact) => fact.id === item.target?.id) ?? null : null);
  const isReasoning = item.kind === "reasoning";
  const isTool = item.kind === "tool_call" || item.kind === "tool_result";
  const canExpand = isReasoning || (isTool && item.summary !== item.text);
  const inspect = isTool ? () => selectAgentEvent({ kind: item.kind, label: item.label, text: item.text }) : undefined;
  const validationState = item.kind === "validation" ? validationEventState(item.eventType, item.target, workflow, targetTask, targetFact) : null;
  const targetTitle = targetTask?.title ?? targetFact?.title;
  const refChips = item.refs && (item.refs.factIds.length > 0 || item.refs.taskIds.length > 0 || (item.refs.trafficIds?.length ?? 0) > 0) ? <RefChips refs={item.refs} /> : null;

  if (canExpand) {
    return (
      <Collapsible
        open={expanded}
        onOpenChange={setExpanded}
        className={`agent-event ${eventClassName(item.kind)} ${expanded ? "is-expanded" : ""}`}
        data-conversation-key={item.key}
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
        {refChips}
      </Collapsible>
    );
  }

  return (
    <article className={`agent-event ${eventClassName(item.kind)}`} data-conversation-key={item.key}>
      <EventHeader item={item} validationState={validationState} targetTitle={targetTitle}><EventActions text={item.text} copied={copied} onCopiedChange={setCopied} onInspect={inspect} onLocate={item.target ? () => navigateToKnowledge(item.target) : undefined} /></EventHeader>
      <p className="agent-event-content">{item.text}</p>
      {refChips}
    </article>
  );
}, (previous, next) => previous.item.key === next.item.key && previous.item.kind === next.item.kind && previous.item.label === next.item.label && previous.item.text === next.item.text && previous.item.summary === next.item.summary && previous.item.target?.kind === next.item.target?.kind && previous.item.target?.id === next.item.target?.id && previous.item.eventType === next.item.eventType && previous.item.createdAt === next.item.createdAt && JSON.stringify(previous.item.refs ?? null) === JSON.stringify(next.item.refs ?? null));

const REF_CHIP_LIMIT = 3;

// 工具产出的知识引用 chips:点击即选中图谱节点/inspector 目标,是 console → 图谱的精确联动入口。
export function RefChips({ refs }: { refs: AgentEventRefs }) {
  const selectFact = useStore((state) => state.selectFact);
  const selectTask = useStore((state) => state.selectTask);
  const inspectTraffic = useStore((state) => state.inspectTraffic);
  const factTitles = useStore(useShallow((state) => refs.factIds.map((id) => state.facts.find((fact) => fact.id === id)?.title ?? null)));
  const taskTitles = useStore(useShallow((state) => refs.taskIds.map((id) => state.tasks.find((task) => task.id === id)?.title ?? null)));
  const trafficItems = useStore(useShallow((state) => (refs.trafficIds ?? []).map((id) => state.traffic.find((entry) => entry.id === id) ?? null)));
  const chips = [
    ...refs.factIds.map((id, index) => ({ kind: "fact" as const, id, label: factTitles[index] ?? id, select: () => selectFact(id) })),
    ...refs.taskIds.map((id, index) => ({ kind: "task" as const, id, label: taskTitles[index] ?? id, select: () => selectTask(id) })),
    ...(refs.trafficIds ?? []).map((id, index) => {
      const entry = trafficItems[index];
      return { kind: "traffic" as const, id, label: entry ? `${entry.method} ${new URL(entry.url).pathname}` : id, select: () => entry && inspectTraffic(entry) };
    }),
  ];
  const visible = chips.slice(0, REF_CHIP_LIMIT);
  return (
    <div className="agent-event-refs">
      <span className="agent-event-refs-label">Produced</span>
      {visible.map((chip) => (
        <button key={`${chip.kind}-${chip.id}`} type="button" className={`agent-event-ref-chip is-${chip.kind}`} data-ref-kind={chip.kind} title={chip.label} onClick={chip.select}>{chip.label}</button>
      ))}
      {chips.length > visible.length && <span className="agent-event-refs-more">+{chips.length - visible.length} more</span>}
    </div>
  );
}

function EventActions({
  text,
  copied,
  onCopiedChange,
  children,
  onInspect,
  onLocate,
}: {
  text: string;
  copied: boolean;
  onCopiedChange: (copied: boolean) => void;
  children?: ReactNode;
  onInspect?: () => void;
  onLocate?: () => void;
}) {
  const copy = async () => {
    await navigator.clipboard.writeText(text);
    onCopiedChange(true);
    globalThis.setTimeout(() => onCopiedChange(false), 1200);
  };
  return (
    <span className="agent-event-actions">
      {onLocate && <Button type="button" variant="ghost" size="icon-xs" aria-label="Locate related knowledge" title="Locate in Knowledge" onClick={onLocate}><ArrowSquareOut size={13} /></Button>}
      {onInspect && <Button type="button" variant="ghost" size="icon-xs" aria-label="Inspect event" title="Inspect" onClick={onInspect}><MagnifyingGlass size={13} /></Button>}
      <Button type="button" variant="ghost" size="icon-xs" aria-label="Copy event" title="Copy" onClick={() => void copy()}>
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </Button>
      {children}
    </span>
  );
}

function EventHeader({ item, children, validationState, targetTitle }: { item: AgentConversationEventItem; children?: ReactNode; validationState?: ValidationState | null; targetTitle?: string }) {
  const isTool = item.kind === "tool_call" || item.kind === "tool_result";
  return (
    <div className="agent-event-header">
      <span className="agent-event-icon" aria-hidden="true">{eventIcon(item.kind)}</span>
      <span className="agent-event-label">{item.label}</span>
      {isTool && <code className="agent-event-tool-chip">{rulerToolName(item.text)}</code>}
      {validationState && <span className={`agent-event-state is-${validationState.tone}`}><span aria-hidden="true" />{validationState.label}</span>}
      {targetTitle && <span className="agent-event-target" title={targetTitle}>{targetTitle}</span>}
      {item.createdAt && <time className="agent-event-time" dateTime={item.createdAt} title={new Date(item.createdAt).toLocaleString()}>{new Date(item.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>}
      {children}
    </div>
  );
}

function eventClassName(kind: AgentConversationEventItem["kind"]): string {
  if (kind === "user") return "is-operator";
  if (kind === "error") return "is-error";
  if (kind === "reasoning") return "is-reasoning";
  if (kind === "tool_call") return "is-tool is-tool-call";
  if (kind === "tool_result") return "is-tool is-tool-result";
  if (kind === "validation") return "is-validation";
  if (kind === "done") return "is-complete";
  return "is-agent";
}

function eventIcon(kind: AgentConversationEventItem["kind"]) {
  if (kind === "user") return <User size={14} />;
  if (kind === "error") return <Warning size={17} weight="fill" />;
  if (kind === "reasoning") return <Brain size={17} weight="duotone" />;
  if (kind === "tool_call") return <TerminalWindow size={17} weight="duotone" />;
  if (kind === "tool_result") return <CheckCircle size={17} weight="duotone" />;
  if (kind === "validation") return <ShieldCheck size={17} weight="duotone" />;
  if (kind === "done") return <CheckCircle size={17} weight="fill" />;
  return <Robot size={17} weight="duotone" />;
}
