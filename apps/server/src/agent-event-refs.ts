import type { AgentEventRefs, TimelineEntry } from "@traceforge/shared";

const FACT_ENTRY = /^fact_(created|updated)$/;
const TASK_ENTRY = /^task_(created|updated|reopened|reverted)$/;

// 汇总一次工具执行窗口内产生的 timeline 条目,提取出实体引用。
// 只统计有直接因果的条目(工具同步写入),下游异步反应(如假设调度)不在窗口内。
export function collectToolRefs(entries: TimelineEntry[]): AgentEventRefs | null {
  if (entries.length === 0) return null;
  const factIds: string[] = [];
  const taskIds: string[] = [];
  const timelineEntryIds: string[] = [];
  for (const entry of entries) {
    timelineEntryIds.push(entry.id);
    if (!entry.refId) continue;
    if (FACT_ENTRY.test(entry.eventType)) {
      if (!factIds.includes(entry.refId)) factIds.push(entry.refId);
    } else if (TASK_ENTRY.test(entry.eventType)) {
      if (!taskIds.includes(entry.refId)) taskIds.push(entry.refId);
    }
  }
  return { factIds, taskIds, timelineEntryIds };
}
