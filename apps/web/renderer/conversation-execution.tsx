import React, { useEffect, useState, useRef } from "react";
import { CaretRight, Robot, User } from "@phosphor-icons/react";
import type { SavedMessage } from "./conversation-client";
import type { DesktopConversations } from "./desktop-conversation-transport";
import { ExecutionPanel } from "./execution-panel";
import { EvidenceReference } from "./evidence-reference";
import { RunProgress } from "./run-progress";
import { RunControl } from "./run-control";
import { DesktopPendingApprovalSchema, type DesktopPendingApproval } from "@traceforge/shared/desktop-execution";
import { RunInteraction } from "./run-interaction";
import { BrowserSessionControl } from "./browser-session-control";
import { ConversationReply, useConversationReplies } from "./conversation-replies";

import { useArtifactPreview } from "./artifact-preview";
import { ReplyQueue } from "./reply-queue";
import { conversationRuntimeView, mergeRunSnapshots } from "./conversation-runtime-view";

export interface ConversationRun {
  runId: string; messageCommandId: string | null; goal: string; status: string; revision: number;
  workItems: Array<{ id: string; title: string; status: string; pendingApproval?: DesktopPendingApproval | null; error?: string | null;
    continuation?: { state: "review" | "budget_exhausted" | "unavailable"; checkpointRef: string | null } }>;
  outputs: Array<{ id: string; summary: string; refs: string[] }>;
  directives?: Array<{ id: string; targetWorkId: string; instruction: string; issuedBy: "operator" | "observer" }>;
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length <= 65536;
/** Validate host observations before attaching them to a saved conversation. */
export function parseConversationRuns(body: unknown): { runs: ConversationRun[]; truncated: boolean } {
  if (!record(body) || !Array.isArray(body.runs) || body.runs.length > 20 || typeof body.truncated !== "boolean") throw new Error("Invalid run catalog");
  const ids = new Set<string>();
  for (const run of body.runs) {
    if (!record(run) || !text(run.runId) || !run.runId || ids.has(run.runId) || !text(run.goal) || !text(run.status)
      || !(run.messageCommandId === null || text(run.messageCommandId)) || !Number.isSafeInteger(run.revision)
      || (run.revision as number) < 0 || !Array.isArray(run.workItems) || run.workItems.length > 1000
      || !Array.isArray(run.outputs) || run.outputs.length > 1000) throw new Error("Invalid run");
    ids.add(run.runId);
    if (run.directives !== undefined && (!Array.isArray(run.directives) || run.directives.length > 1000 || run.directives.some(value =>
      !record(value) || !text(value.id) || !text(value.targetWorkId) || !text(value.instruction) || !["operator", "observer"].includes(String(value.issuedBy))))) throw new Error("Invalid directives");
    const works = new Set<string>(), outputs = new Set<string>();
    for (const work of run.workItems) {
      if (!record(work) || !text(work.id) || works.has(work.id) || !text(work.title) || !text(work.status)) throw new Error("Invalid work");
      works.add(work.id);
      if (work.pendingApproval != null) {
        const approval = DesktopPendingApprovalSchema.parse(work.pendingApproval);
        if (approval.workId !== work.id || work.status !== "waiting_approval") throw new Error("Invalid pending approval");
      }
      if (work.error != null && !text(work.error)) throw new Error("Invalid work error");
      if (work.continuation !== undefined && (!record(work.continuation) || !["review", "budget_exhausted", "unavailable"].includes(String(work.continuation.state))
        || !(work.continuation.checkpointRef === null || typeof work.continuation.checkpointRef === "string" && /^checkpoint:\/\/sha256-[a-f0-9]{64}\.json$/.test(work.continuation.checkpointRef)))) throw new Error("Invalid continuation state");
    }
    for (const output of run.outputs) {
      if (!record(output) || !text(output.id) || outputs.has(output.id) || !text(output.summary) || !Array.isArray(output.refs)
        || output.refs.length > 1000 || !output.refs.every(text)) throw new Error("Invalid output");
      outputs.add(output.id);
    }
  }
  return { runs: body.runs as ConversationRun[], truncated: body.truncated };
}
export function executionStatus(status: string): string {
  return ({ created: "已创建", running: "执行中", pending: "等待执行", queued: "排队中", ready: "准备就绪",
    paused: "已暂停", blocked: "需要处理", waiting_approval: "等待审批", completed: "已完成", cancelled: "已停止", failed: "执行失败" } as Record<string, string>)[status] ?? `状态：${status}`;
}

function RunReply({ run, bridge, conversationId, unified=false }: { run: ConversationRun; bridge: DesktopConversations; conversationId: string; unified?:boolean }) {
  return <article className="message message-assistant run-reply" aria-label="智能体任务进展">
    <div className="avatar" aria-hidden="true"><Robot /></div>
    <div className="message-body"><div className="sender">TraceForge <span className="run-state">{executionStatus(run.status)}</span></div>
      <RunProgress key={`${conversationId}:${run.runId}`} bridge={bridge} conversationId={conversationId} runId={run.runId} run={run} terminal={["completed","cancelled","failed"].includes(run.status)} />
      <RunInteraction bridge={bridge} conversationId={conversationId} run={run} hideInput={unified}/>
      {!['completed', 'cancelled', 'failed'].includes(run.status) && <BrowserSessionControl key={`browser:${conversationId}:${run.runId}`} bridge={bridge} conversationId={conversationId} runId={run.runId} />}
      {!run.outputs.length && ["completed", "cancelled", "failed"].includes(run.status) && <p className="run-waiting">本次运行已结束，尚无已保存的任务输出。</p>}
      {run.status==="completed"&&run.outputs.length>0&&<p className="run-result-preview" aria-label="结果摘录，完整内容在任务材料中">{Array.from(run.outputs.at(-1)!.summary).slice(0,240).join("")}{Array.from(run.outputs.at(-1)!.summary).length>240?"…":""}</p>}
      {run.outputs.length>0&&<details className="run-saved-materials"><summary><CaretRight className="disclosure-caret" aria-hidden="true" />任务材料 · {run.outputs.length} 项</summary>
      {run.outputs.map(output => <section key={output.id} className="run-output"><p>{output.summary}</p>
        {output.refs.length > 0 && <details><summary><CaretRight className="disclosure-caret" aria-hidden="true" />查看依据 · {output.refs.length} 条引用</summary><p className="local-receipt">引用用于追溯来源，不代表结论已经验证。</p><ul>{output.refs.map((ref, index) => <li key={`${index}:${ref}`}><EvidenceReference bridge={bridge} conversationId={conversationId} runId={run.runId} reference={ref} /></li>)}</ul></details>}
      </section>)}</details>}
      <details className="run-details"><summary><CaretRight className="disclosure-caret" aria-hidden="true" />任务步骤 · {run.workItems.length} 项</summary><p className="local-receipt">{run.goal}</p>
        {!run.workItems.length ? <p>尚无已保存的工作项。</p> : <ul>{run.workItems.map(work => <li key={work.id}>{work.title}<span>{executionStatus(work.status)}</span></li>)}</ul>}
        <small className="local-receipt">运行 {run.runId} · 版本 {run.revision}</small>
      </details>
      {!unified&&<RunControl bridge={bridge} conversationId={conversationId} runId={run.runId} revision={run.revision} status={run.status} />}
    </div>
  </article>;
}

/** Read-only task projection. Opening the conversation never dispatches a Run. */
export function ConversationExecution({ bridge, conversationId, messages, onRuns, onMessagesChanged, onRuntime }: {
  bridge: DesktopConversations; conversationId: string; messages: SavedMessage[]; onRuns?: (runs:ConversationRun[]|null)=>void; onMessagesChanged?:()=>Promise<void>; onRuntime?:(value:ReturnType<typeof conversationRuntimeView>)=>void;
}) {
  const [snapshot, setSnapshot] = useState<{ runs: ConversationRun[]; truncated: boolean } | null>(null);
  const preview = useArtifactPreview(), latestRuns = useRef<ConversationRun[]>([]);
  const assistant = useConversationReplies(bridge, conversationId);
  const [error, setError] = useState(false), [refresh, setRefresh] = useState(0);
  useEffect(()=>{const changed=(event:Event)=>{if((event as CustomEvent).detail===conversationId)setRefresh(value=>value+1);};window.addEventListener("traceforge:execution-updated",changed);return()=>window.removeEventListener("traceforge:execution-updated",changed);},[conversationId]);
  useEffect(() => {
    let active = true, timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const response = await bridge.request({ path: `/api/desktop/conversations/${conversationId}/execution`, method: "GET" });
        if (!active) return;
        if (response.status !== 200) throw new Error("Unavailable");
        const next = parseConversationRuns(response.body);
        latestRuns.current=mergeRunSnapshots(latestRuns.current,next.runs);setSnapshot({...next,runs:latestRuns.current}); setError(false);onRuns?.(latestRuns.current);
      } catch { if (active) {setError(true);onRuns?.(null);} }
      if (active) timer = setTimeout(poll, document.hidden ? 15000 : 2000);
    };
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [bridge, conversationId, refresh, onRuns]);
  const runs = snapshot?.runs ?? [];
  const commands = new Set(messages.map(message => message.commandId));
  const unbound = runs.filter(run => !run.messageCommandId || !commands.has(run.messageCommandId));
  const runtime=conversationRuntimeView(assistant.replies.values(),snapshot?.runs??null,assistant.ready&&!!snapshot,assistant.error||error);
  useEffect(()=>{onRuntime?.(runtime);},[runtime.label,runtime.ready,runtime.queued,runtime.activeMessageId,onRuntime]);
  return <>
    {runtime.label!=="可以继续对话"&&<p className="conversation-runtime-status" role="status">{runtime.label}{runtime.queued>0?` · ${runtime.queued} 条待处理`:""}</p>}
    {messages.map(message => <React.Fragment key={message.commandId}>
      <article className="message message-user"><div className="avatar user" aria-hidden="true"><User weight="fill" /></div><div className="message-body"><div className="sender">你</div><p className="user-text">{message.text}</p>{message.attachmentNames?.map((name,index)=><button type="button" className="attachment-reference" key={index} onClick={()=>preview?.open({kind:"attachment",conversationId,messageId:message.commandId,index,title:name})}>附件：{name}</button>)}<small className="local-receipt">已保存到本机会话</small></div></article>
      <ConversationReply bridge={bridge} conversationId={conversationId} messageId={message.commandId} reply={assistant.replies.get(message.commandId)} ready={assistant.ready&&!assistant.error}
        otherActive={[...assistant.replies.values()].some(item=>item.state==="streaming"&&item.messageCommandId!==message.commandId)} refresh={assistant.refresh} hideStop={!!onRuns}/>
      {assistant.replies.get(message.commandId)?.taskRequest && !runs.some(run=>run.messageCommandId===message.commandId) && <section className="conversation-authorization" aria-label="任务授权">
        {assistant.replies.get(message.commandId)!.taskRequest?.automatic
          ? <p role="status">{assistant.replies.get(message.commandId)!.taskRequest?.startState==="started"?"任务已开始，正在同步进展…":assistant.replies.get(message.commandId)!.taskRequest?.startState==="stopped"?"任务启动已停止。":"任务启动结果未确认，请查看任务记录和设置；不会自动重复执行。"}</p>
          : <p role="status">这条历史任务尚未执行；如需开始，请重新发送任务要求。</p>}
      </section>}
      {runs.filter(run => run.messageCommandId === message.commandId).map(run => <RunReply key={run.runId} run={run} bridge={bridge} conversationId={conversationId} unified={!!onRuns&&runs.filter(r=>["running","paused"].includes(r.status)).length===1}/>)}
    </React.Fragment>)}
    {assistant.error&&<p role="alert" className="inline-warning">助手回复暂时无法同步。已显示文字仍保留；重连只读取记录，不重新请求模型。<button onClick={assistant.refresh}>重新读取回复</button></p>}
    {unbound.length > 0 && <section aria-label="会话关联运行"><h2 className="related-runs-title">会话关联运行</h2><p className="local-receipt">以下运行没有对应的已加载消息，不按文字相似度匹配。</p>{unbound.map(run => <RunReply key={run.runId} run={run} bridge={bridge} conversationId={conversationId} />)}</section>}
    {error ? <div className="inline-warning" role="alert">任务状态暂时无法更新，下面的操作不会自动重试。已显示内容是上次读取结果。<button onClick={() => setRefresh(value => value + 1)}>重新读取状态</button></div>
      : !snapshot ? <p role="status" className="local-receipt">正在读取任务进展…</p> : null}
    <ReplyQueue key={conversationId} bridge={bridge} conversationId={conversationId} onChanged={()=>{assistant.refresh();void onMessagesChanged?.().catch(()=>setError(true));}}/>
    {snapshot?.truncated && <p className="local-receipt">仅显示最近 20 次运行；没有显示的运行不代表尚未执行。</p>}
  </>;
}
