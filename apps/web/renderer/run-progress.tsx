import React, { useEffect, useState } from "react";
import { CaretRight } from "@phosphor-icons/react";
import { decodeScenarioAgentEvent, type ScenarioAgentEvent } from "@traceforge/shared/scenario-agent-events";
import type { DesktopConversations } from "./desktop-conversation-transport";
import { EvidenceReference } from "./evidence-reference";
import { RunActivity } from "./run-activity";
import { ExecutionTrace, mergeTrace } from "./execution-trace";
import type { ConversationRun } from "./conversation-execution";

/** Validate whole pages before advancing: a bad tail must not lose earlier events. */
export function readProgressPage(body: unknown, runId: string, after: number, caseId?: string) {
  const page = body as { caseId?: unknown; runId?: unknown; events?: unknown; nextCursor?: unknown; hasMore?: unknown } | null;
  if (!page || page.runId !== runId || typeof page.caseId !== "string" || !page.caseId || (caseId && page.caseId !== caseId)
    || !Array.isArray(page.events) || page.events.length > 100 || typeof page.hasMore !== "boolean") throw new Error("Invalid progress page");
  const ids = new Set<string>();
  const events = page.events.map((value, index) => {
    const event = decodeScenarioAgentEvent(value);
    if (event.runId !== runId || event.caseId !== page.caseId || event.sequence !== after + index + 1 || ids.has(event.id)) throw new Error("Invalid progress sequence");
    ids.add(event.id); return event;
  });
  if (page.nextCursor !== after + events.length || (page.hasMore && !events.length)) throw new Error("Invalid progress cursor");
  return { events, nextCursor: after + events.length, hasMore: page.hasMore, caseId: page.caseId };
}
const statusLabel = (value: string) => ({ inProgress: "执行中", completed: "已完成", failed: "失败", pending: "等待确认", waitingApproval: "等待确认", approved: "已批准", rejected: "已拒绝", cancelled: "已取消", interrupted: "已中断", timedOut: "已超时", queued: "排队中", admitted: "已获配额", released: "配额已释放" } as Record<string,string>)[value] ?? value;
function description(event: ScenarioAgentEvent) {
  if (event.method === "turn/progress") return event.params.summary;
  if (event.method === "turn/started") return "开始处理任务";
  if (event.method === "turn/completed") return `本轮处理${statusLabel(event.params.status)}`;
  const item = event.params.item;
  if (item.type === "toolCall") return `${item.tool} · ${statusLabel(item.status)}${item.summary ? `：${item.summary}` : ""}`;
  if (item.type === "approval") return `${item.tool} · ${statusLabel(item.status)}${item.reason ? `：${item.reason}` : ""}`;
  if (item.type === "modelCall") return `模型调用 · ${statusLabel(item.status)}`;
  if (item.type === "modelAdmission") return `模型资源 · ${statusLabel(item.status)}`;
  return item.summary;
}
export function RunProgress({ bridge, conversationId, runId, terminal = false, run }: { bridge: DesktopConversations; conversationId: string; runId: string; terminal?: boolean; run?: ConversationRun }) {
  const [events, setEvents] = useState<ScenarioAgentEvent[]>([]), [error, setError] = useState(false), [retry, setRetry] = useState(0);
  const [older, setOlder] = useState(false);
  const [trace, setTrace] = useState<ScenarioAgentEvent[]>([]);
  const [activity, setActivity] = useState(() => new RunActivity()), [syncing, setSyncing] = useState(true);
  useEffect(() => {
    let active = true, cursor = 0, caseId: string | undefined, timer: ReturnType<typeof setTimeout>;
    let collected: ScenarioAgentEvent[] = [];
    let traceRows: ScenarioAgentEvent[] = [];
    // Reconnect replays persisted pages without blanking already visible text.
    setTrace(previous => previous.filter(event => event.runId === runId));
    setEvents(previous => previous.filter(event => event.runId === runId));
    const nextActivity = new RunActivity();
    setSyncing(true);
    const poll = async () => {
      let more = false;
      try {
        const result = await bridge.request({ path: `/api/desktop/conversations/${conversationId}/execution/${runId}/events?after=${cursor}`, method: "GET" });
        if (!active) return;
        if (result.status !== 200) throw new Error("Progress unavailable");
        const page = readProgressPage(result.body, runId, cursor, caseId);
        nextActivity.apply(page.events);
        traceRows = mergeTrace(traceRows, page.events);
        if (!page.hasMore) setTrace(traceRows);
        cursor = page.nextCursor; caseId = page.caseId; more = page.hasMore;
        collected = [...collected, ...page.events].slice(-100);
        setEvents(collected); setOlder(cursor > 100); setError(false);
        setActivity(nextActivity); setSyncing(more);
      } catch { if (active) setError(true); }
      // Drain every retained page before stopping terminal polling. A slow final
      // audit event can still be picked up by a low-frequency reconciliation.
      if (active) timer = setTimeout(poll, more ? 0 : terminal ? 60000 : document.hidden ? 5000 : 250);
    };
    void poll(); return () => { active = false; clearTimeout(timer); };
  }, [bridge, conversationId, runId, retry, terminal]);
  return <section className="run-progress" aria-label="执行进展">
    <p className="local-receipt" role="status">{error ? "状态连接中断，当前显示上次保存的记录" : syncing ? "正在同步任务进度…" : activity.label(run)}</p>
    {error && <p role="alert">进展读取中断，已显示记录保留；不会重跑操作。<button onClick={() => setRetry(value => value + 1)}>重新读取进展</button></p>}
    <ExecutionTrace events={trace} bridge={bridge} conversationId={conversationId}/>
    {events.length > 0 && <details><summary><CaretRight className="disclosure-caret" aria-hidden="true" />执行记录 · {older ? "最近 " : ""}{events.length} 条</summary>
      <ol>{events.map(event => {
        const refs = event.method === "turn/progress" ? event.params.refs : "item" in event.params && "refs" in event.params.item ? event.params.item.refs : [];
        return <li key={event.id}><span>{description(event)}</span><small className="local-receipt">{new Date(event.createdAt).toLocaleTimeString()} · {event.role}</small>
          {refs.length > 0 && <details><summary><CaretRight className="disclosure-caret" aria-hidden="true" />查看操作依据 · {refs.length}</summary>{refs.map((ref, index) => <EvidenceReference key={`${index}:${ref}`} bridge={bridge} conversationId={conversationId} runId={runId} reference={ref} />)}</details>}
        </li>;
      })}</ol>
      <p className="local-receipt">这是已记录的执行事实，不是模型内部推理；工具完成不代表安全结论已验证。审批以当前待处理卡片为准，历史事件不会触发批准。</p>
    </details>}
  </section>;
}
