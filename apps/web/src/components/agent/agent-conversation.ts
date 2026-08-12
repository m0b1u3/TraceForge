import type { AgentUiEvent } from "../../store.js";
import { validationTimelineConsoleEvent, type AgentEventRefs } from "@traceforge/shared";
import { rulerToolName } from "./RunTimelineRuler.js";

type PendingApproval = { approvalId: string; tool: string; input: string };
type PendingScope = { host: string; reason: string };

export type AgentConversationEventItem = {
  type: "event";
  key: string;
  kind: AgentUiEvent["kind"];
  label: string;
  text: string;
  summary: string;
  refs?: AgentEventRefs | null;
  target?: { kind: "task" | "finding"; id: string };
  eventType?: string;
  createdAt?: string;
  executionId?: string | null;
  outcome?: AgentUiEvent["outcome"];
  recoveredByExecutionId?: string | null;
  failureDiagnostic?: AgentUiEvent["failureDiagnostic"];
};

export type AgentToolActivity = {
  key: string;
  tool: string;
  call: AgentConversationEventItem | null;
  result: AgentConversationEventItem | null;
  outcome: "running" | "succeeded" | "failed" | "recovered";
  recoveredByKey?: string;
};

export type AgentConversationItem =
  | AgentConversationEventItem
  | { type: "tool_group"; key: string; tool: string; activities: AgentToolActivity[] }
  | { type: "validation_group"; key: string; target: NonNullable<AgentConversationEventItem["target"]>; events: AgentConversationEventItem[] }
  | { type: "approval"; key: string }
  | { type: "scope"; key: string }
  | { type: "busy"; key: string };

export function buildAgentConversationItems({
  events,
  pendingApproval,
  pendingScope,
  agentBusy,
}: {
  events: AgentUiEvent[];
  pendingApproval: PendingApproval | null;
  pendingScope: PendingScope | null;
  agentBusy: boolean;
}): AgentConversationItem[] {
  const items: AgentConversationItem[] = [];
  let lastVisible: { kind: AgentUiEvent["kind"]; text: string } | null = null;

  events.forEach((event, index) => {
    if (isNoisyAgentEvent(event)) return;
    const display = formatAgentEvent(event);
    if (!display) return;
    if (lastVisible?.kind === display.kind && lastVisible.text === display.text) return;
    if (display.kind === "done" && lastVisible?.kind === "text" && lastVisible.text === display.text) return;
    const nextItem: AgentConversationEventItem = { type: "event", key: `event-${index}`, ...display };
    const previous = items.at(-1);
    if (nextItem.kind === "tool_call" || nextItem.kind === "tool_result") {
      appendToolActivity(items, nextItem);
    } else if (nextItem.kind === "validation" && nextItem.target && previous?.type === "event" && previous.kind === "validation" && sameTarget(previous.target, nextItem.target)) {
      items[items.length - 1] = { type: "validation_group", key: `validation-group-${previous.key}`, target: nextItem.target, events: [previous, nextItem] };
    } else if (nextItem.kind === "validation" && nextItem.target && previous?.type === "validation_group" && sameTarget(previous.target, nextItem.target)) {
      previous.events.push(nextItem);
    } else {
      items.push(nextItem);
    }
    lastVisible = { kind: display.kind, text: display.text };
  });

  reconcileRecoveredExecutions(items);
  if (pendingApproval) items.push({ type: "approval", key: `approval-${pendingApproval.approvalId}` });
  if (pendingScope) items.push({ type: "scope", key: `scope-${pendingScope.host}` });
  if (agentBusy) items.push({ type: "busy", key: "agent-busy" });
  return items;
}

function appendToolActivity(items: AgentConversationItem[], event: AgentConversationEventItem): void {
  const tool = rulerToolName(event.text);
  if (event.kind === "tool_result" && event.executionId) {
    const matched = findActivityByExecutionId(items, event.executionId);
    if (matched) {
      matched.result = event;
      matched.outcome = event.outcome ?? (toolResultFailed(event.text) ? "failed" : "succeeded");
      matched.recoveredByKey = event.recoveredByExecutionId ?? undefined;
      return;
    }
  }
  const previous = items.at(-1);
  const group = previous?.type === "tool_group" && previous.tool === tool ? previous : null;

  if (event.kind === "tool_result" && group) {
    const latest = group.activities.at(-1);
    if (latest && latest.result === null) {
      latest.result = event;
      latest.outcome = event.outcome ?? (toolResultFailed(event.text) ? "failed" : "succeeded");
      latest.recoveredByKey = event.recoveredByExecutionId ?? undefined;
      markRecoveredActivities(group.activities, latest);
      return;
    }
  }

  const activity: AgentToolActivity = {
    key: `tool-activity-${event.key}`,
    tool,
    call: event.kind === "tool_call" ? event : null,
    result: event.kind === "tool_result" ? event : null,
    outcome: event.outcome ?? (event.kind === "tool_result"
      ? toolResultFailed(event.text) ? "failed" : "succeeded"
      : "running"),
    recoveredByKey: event.recoveredByExecutionId ?? undefined,
  };
  if (group) {
    group.activities.push(activity);
    markRecoveredActivities(group.activities, activity);
    return;
  }
  items.push({ type: "tool_group", key: `tool-group-${event.key}`, tool, activities: [activity] });
}

export function toolResultFailed(text: string): boolean {
  return /\bexit=(?!(?:0)(?:\D|$))(?:-?\d+|timeout|null)\b/i.test(text)
    || /\b(?:spawn failed|command rejected|permission denied|timed?\s*out)\b/i.test(text)
    || /(?:→|->)\s*(?:error|failed|blocked|denied|timeout|exception)\b/i.test(text);
}

function markRecoveredActivities(activities: AgentToolActivity[], recovery: AgentToolActivity): void {
  if (recovery.outcome !== "succeeded") return;
  if (recovery.result?.executionId) return;
  for (let index = activities.length - 2; index >= 0; index -= 1) {
    const candidate = activities[index];
    if (candidate.outcome !== "failed") break;
    candidate.outcome = "recovered";
    candidate.recoveredByKey = recovery.key;
  }
}

function reconcileRecoveredExecutions(items: AgentConversationItem[]): void {
  const unresolvedByTool = new Map<string, AgentToolActivity[]>();
  for (const item of items) {
    if (item.type !== "tool_group") continue;
    for (const activity of item.activities) {
      if (activity.result?.executionId) continue;
      if (activity.outcome === "failed") {
        const unresolved = unresolvedByTool.get(item.tool) ?? [];
        unresolved.push(activity);
        unresolvedByTool.set(item.tool, unresolved);
        continue;
      }
      if (activity.outcome !== "succeeded") continue;
      const unresolved = unresolvedByTool.get(item.tool);
      if (!unresolved) continue;
      for (const failed of unresolved) {
        failed.outcome = "recovered";
        failed.recoveredByKey = activity.key;
      }
      unresolvedByTool.delete(item.tool);
    }
  }
}

function findActivityByExecutionId(items: AgentConversationItem[], executionId: string): AgentToolActivity | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.type !== "tool_group") continue;
    const activity = item.activities.find((candidate) => candidate.call?.executionId === executionId);
    if (activity) return activity;
  }
  return null;
}

function sameTarget(left: AgentConversationEventItem["target"], right: AgentConversationEventItem["target"]): boolean {
  return Boolean(left && right && left.kind === right.kind && left.id === right.id);
}

function isNoisyAgentEvent(event: AgentUiEvent): boolean {
  const text = event.text.trim();
  if (!text) return true;
  if (event.kind === "started") return true;
  if (event.kind === "done") return text === "done" || text === "handled";
  if (event.kind === "tool_call") return /^list_traffic\s*\(\s*\{\s*\}\s*\)$/i.test(text);
  if (event.kind === "tool_result") return /^list_traffic\s*→\s*[（(]暂无流量[）)]$/i.test(text);
  return false;
}

function formatAgentEvent(event: AgentUiEvent): Omit<AgentConversationEventItem, "type" | "key"> | null {
  const text = event.text.trim();
  if (!text || event.kind === "started") return null;
  if (event.kind === "user") return { kind: event.kind, label: "You", text, summary: text };
  if (event.kind === "error") return { kind: event.kind, label: "Error", text, summary: text };
  if (event.kind === "tool_call") {
    return {
      kind: event.kind, label: "Tool call", text, summary: compactToolText(text),
      executionId: event.executionId, outcome: event.outcome,
    };
  }
  if (event.kind === "tool_result") {
    return {
      kind: event.kind, label: "Tool result", text, summary: compactToolText(text), refs: event.refs ?? null,
      executionId: event.executionId, outcome: event.outcome,
      recoveredByExecutionId: event.recoveredByExecutionId,
      failureDiagnostic: event.failureDiagnostic,
    };
  }
  if (event.kind === "validation") {
    const validation = validationTimelineConsoleEvent({ eventType: event.tool ?? "", detail: text });
    if (!validation) return null;
    return { kind: event.kind, label: validation.label, text: validation.text, summary: validation.text, target: validation.target, eventType: event.tool ?? undefined, createdAt: event.createdAt };
  }
  if (event.kind === "done") return { kind: event.kind, label: "Complete", text, summary: text };
  if (event.kind === "reasoning") return { kind: event.kind, label: "Reasoning", text, summary: compactText(text, 140) };
  return { kind: event.kind, label: "Agent", text, summary: text };
}

function compactToolText(text: string): string {
  return compactText(text.replace(/\s+/g, " ").trim(), 180);
}

// 图谱节点 → console 的精确反查:取最后一个 refs 提到该实体的事件(最新的上下文最相关)。
export function findAgentEventIndexByRef(events: Array<{ refs?: AgentEventRefs | null }>, refId: string): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const refs = events[index].refs;
    if (!refs) continue;
    if (refs.factIds.includes(refId) || refs.taskIds.includes(refId) || (refs.trafficIds ?? []).includes(refId) || refs.timelineEntryIds.includes(refId)) return index;
  }
  return -1;
}

function compactText(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}
