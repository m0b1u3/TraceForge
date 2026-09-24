import React, { useState } from "react";
import { CaretRight, TerminalWindow, Brain } from "@phosphor-icons/react";
import type { DesktopConversations } from "./desktop-conversation-transport";
import { useArtifactPreview } from "./artifact-preview";
import { EvidenceReference } from "./evidence-reference";
import type { ScenarioAgentEvent } from "@traceforge/shared/scenario-agent-events";

/** Operate / existing paper-and-ink conversation. Public model text and actual
 * tool telemetry remain separate, streamed in place, inspectable and inert. */
export function mergeTrace(previous: ScenarioAgentEvent[], incoming: ScenarioAgentEvent[]): ScenarioAgentEvent[] {
  const rows = new Map(previous.map(event => [key(event), event]));
  for (const event of incoming) {
    if (event.method === "turn/completed") {
      for (const [id, row] of rows) if (row.turnId === event.turnId && row.sequence < event.sequence && "item" in row.params && row.params.item.status === "inProgress") {
        const item = row.params.item;
        if (item.type === "modelCall" || item.type === "toolCall") rows.set(id, { ...row, sequence:event.sequence, params: { item: { ...item, status: "cancelled" } } } as ScenarioAgentEvent);
      }
    }
    if (!("item" in event.params) || !["modelCall", "toolCall"].includes(event.params.item.type)) continue;
    const before = rows.get(key(event));
    if(before && before.sequence >= event.sequence) continue;
    rows.set(key(event), before && "item" in before.params ? {
      ...event, params: { item: { ...before.params.item, ...event.params.item } },
    } as ScenarioAgentEvent : event);
  }
  return [...rows.values()].slice(-100);
}
const key = (event: ScenarioAgentEvent) => `${event.turnId}:${"item" in event.params ? `${event.params.item.type}:${event.params.item.id}` : event.id}`;
const state = (value: string) => ({ inProgress: "进行中", completed: "已完成", failed: "失败", timedOut: "已超时", cancelled: "已停止", interrupted: "已中断", waitingApproval: "等待确认" } as Record<string,string>)[value] ?? value;

export function ReasoningText({ text, active = false, truncated = false }: { text: string; active?: boolean; truncated?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  return <details className="reasoning-trace" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary><CaretRight className="disclosure-caret" aria-hidden="true" /><Brain aria-hidden="true" />{active ? "正在思考" : "思考内容"}<span>模型提供</span></summary>
    <div className="reasoning-text" dir="auto" tabIndex={0}>{text}</div>
    {truncated && <p className="local-receipt">思考展示达到长度上限，以下回复和工具执行不受此展示截断影响。</p>}
  </details>;
}

type TraceScope={bridge?:DesktopConversations;conversationId?:string};
function TraceEntry({ event,bridge,conversationId }: { event: ScenarioAgentEvent }&TraceScope) {
  const preview=useArtifactPreview();
  const [expanded, setExpanded] = useState(false);
  if (!("item" in event.params)) return null;
  const item = event.params.item;
  if (item.type !== "modelCall" && item.type !== "toolCall") return null;
  const active = item.status === "inProgress";
  return <details className="execution-trace-entry" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary><CaretRight className="disclosure-caret" aria-hidden="true" />{item.type === "modelCall" ? <Brain aria-hidden="true" /> : <TerminalWindow aria-hidden="true" />}
      <span className="trace-title">{item.type === "modelCall" ? active ? "正在思考" : "模型思考" : item.tool}</span>
      <span className="trace-status">{item.type === "toolCall" && active && item.dispatchState === "requested" ? "准备调用" : state(item.status)}</span>
    </summary>
    <div className="trace-content">
      {item.type === "modelCall" ? <>
        {item.reasoning ? <div className="reasoning-text" dir="auto" tabIndex={0}>{item.reasoning}</div> : <p className="local-receipt">{active ? "等待模型返回可展示的思考内容…" : "本次模型未提供可展示的思考内容。"}</p>}
        <small>模型公开返回的内容，不代表已执行操作或已验证结论。</small>
        {item.reasoningTruncated && <p className="local-receipt">思考展示已截短。</p>}
      </> : <>
        {item.rationale && <p className="trace-rationale">{item.rationale}</p>}
        {item.commandPreview ? <><small>执行命令 · 受控进程</small><pre tabIndex={0}>{item.commandPreview}</pre></> : item.inputPreview && <><small>调用参数</small><pre tabIndex={0}>{item.inputPreview}</pre></>}
        {item.outputPreview ? <><small>{active ? "输出持续更新" : "返回内容"}</small><pre tabIndex={0}>{item.outputPreview}</pre></> : <p className="local-receipt">{active ? item.dispatchState === "requested" ? "正在核对授权，尚未确认派发。" : "正在执行，等待输出…" : item.summary || "没有可展示的返回内容。"}</p>}
        {preview&&conversationId&&item.outputPreview&&<button onClick={()=>preview.open({kind:"text",conversationId,title:`${item.tool} · 输出`,sourceId:`${event.runId}:${event.turnId}:${item.id}:${event.sequence}`,text:item.outputPreview!})}>在侧栏查看输出</button>}
        {item.previewTruncated && <p className="local-receipt">此处为有界输出预览，完整结果以原始回执为准。</p>}
        {bridge&&conversationId&&item.refs.map(reference=><EvidenceReference key={reference} bridge={bridge} conversationId={conversationId} runId={event.runId} reference={reference}/>)}
        {item.dispatchState === "replayed" && <p className="local-receipt">恢复已保存结果，没有重新执行。</p>}
      </>}
    </div>
  </details>;
}
export function ExecutionTrace({ events, ...scope }: { events: ScenarioAgentEvent[] }&TraceScope) {
  const groups=new Map<string,ScenarioAgentEvent[]>();
  for(const event of events)groups.set(event.turnId,[...(groups.get(event.turnId)??[]),event]);
  const all=[...groups],older=all.slice(0,-3),recent=all.slice(-3);
  const group=([id,rows]:[string,ScenarioAgentEvent[]])=><section className="trace-group" key={id} aria-label="执行回合"><p className="local-receipt">{{worker:"执行",planner:"规划",observer:"检查",replay:"恢复",system:"系统"}[rows[0].role]} · {rows.filter(e=>"item" in e.params&&e.params.item.type==="toolCall").length} 次工具调用</p>{rows.length>8&&<details><summary>较早调用 · {rows.length-8} 项</summary>{rows.slice(0,-8).map(event=><TraceEntry key={key(event)} event={event} {...scope}/>)}</details>}{rows.slice(-8).map(event=><TraceEntry key={key(event)} event={event} {...scope}/>)}</section>;
  return <div className="execution-trace" aria-label="思考与工具过程">
    {older.length > 0 && <details><summary>查看较早的过程 · {older.length} 项</summary>{older.map(group)}</details>}
    {recent.map(group)}
  </div>;
}
