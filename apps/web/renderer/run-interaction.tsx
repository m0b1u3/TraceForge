import React, { useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import "./task-confirmation.css";
import { desktopJournalStorage } from "./desktop-journal-storage";
import { CaretRight, Shield } from "@phosphor-icons/react";
import type { ConversationRun } from "./conversation-execution";
import type { DesktopConversations } from "./desktop-conversation-transport";
import { ExecutionController } from "./execution-controller";
import type { DesktopPendingApproval } from "@traceforge/shared/desktop-execution";

function ApprovalChoice({ approval, workTitle, revision, disabled, submit, bridge, conversationId, runId }: { approval: DesktopPendingApproval; workTitle: string; revision: number; disabled: boolean;
  bridge: DesktopConversations; conversationId: string; runId: string;
  submit(approved: boolean, reason: string): Promise<void> }) {
  const [open,setOpen]=useState(true);
  const [preview, setPreview] = useState<{ inputRef: string; input: string } | null>(null), [loading, setLoading] = useState(false), [previewError, setPreviewError] = useState("");
  const inspected = preview?.inputRef === approval.inputRef;
  const risk = ({ read_only: "只读", bounded_write: "有限写入", privileged: "高权限", destructive: "破坏性" })[approval.risk];
  async function inspect() {
    setLoading(true); setPreviewError(""); setPreview(null);
    try {
      const result = await bridge.request({ path: `/api/desktop/conversations/${conversationId}/execution/approval-input`, method: "POST", body: JSON.stringify({ runId, workId: approval.workId, approvalId: approval.id }) });
      const value = result.body as { runId?: unknown; workId?: unknown; approvalId?: unknown; inputRef?: unknown; input?: unknown };
      if (result.status !== 200 || value?.runId !== runId || value.workId !== approval.workId || value.approvalId !== approval.id || value.inputRef !== approval.inputRef || typeof value.input !== "string" || new TextEncoder().encode(value.input).length > 32768) throw new Error("Invalid preview");
      setPreview({ inputRef: value.inputRef, input: value.input });
    } catch { setPreviewError("无法读取或核对具体参数，暂不能批准。你仍可拒绝这次操作。"); }
    finally { setLoading(false); }
  }
  useEffect(()=>{void inspect();},[approval.id,approval.inputRef]);
  async function decide(approved:boolean){await submit(approved,approved?"用户允许本次操作":"用户拒绝本次操作");setOpen(false);}
  return <><button onClick={()=>setOpen(true)}>查看待授权操作</button><Dialog.Root open={open} onOpenChange={setOpen}><Dialog.Portal><Dialog.Overlay className="task-confirm-overlay"/><Dialog.Content className="task-confirm-dialog">
    <Dialog.Title>允许这次操作？</Dialog.Title><Dialog.Description>{workTitle} · {approval.toolName} · {risk}</Dialog.Description>
    <p>{approval.rationale}</p>
    {loading&&<p role="status">正在读取操作内容…</p>}
    {inspected && <pre className="interaction-parameters" tabIndex={0} aria-label="待执行参数">{preview!.input}</pre>}
    {previewError && <p role="alert">{previewError}<button disabled={disabled||loading} onClick={()=>void inspect()}>重新读取</button></p>}
    <div className="task-confirm-footer"><button disabled={disabled} onClick={() => void decide(false)}>拒绝</button>
      <button className="primary" disabled={disabled || loading || !inspected} onClick={() => void decide(true)}>允许</button></div>
  </Dialog.Content></Dialog.Portal></Dialog.Root></>;
}
/** User intent is a durable command, never a side effect of receiving an event. */
export function RunInteraction({ bridge, conversationId, run, hideInput=false }: { bridge: DesktopConversations; conversationId: string; run: ConversationRun; hideInput?:boolean }) {
  const controller = useMemo(() => new ExecutionController(bridge, desktopJournalStorage(), conversationId), [bridge, conversationId]);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(""), [error, setError] = useState("");
  const [workId, setWorkId] = useState(""), [instruction, setInstruction] = useState("");
  const [submitted, setSubmitted] = useState<string[]>([]);
  const [resumeWork, setResumeWork] = useState<string | null>(null);
  let pendingCommand: { path: string; body: Record<string, unknown> } | null = null, damaged = false;
  try { pendingCommand = controller.pending; } catch { damaged = true; }
  const pending = !!pendingCommand;
  const active = ["running", "paused"].includes(run.status);
  const available = run.workItems.filter(work => !["completed", "cancelled"].includes(work.status));
  const disabled = busy || pending || damaged || !active;
  async function send(kind?: "approval" | "input" | "continue", fields?: Record<string, unknown>) {
    setBusy(true); setNotice(""); setError("");
    try {
      const receipt = await controller.execute(kind ? { path: `/api/desktop/conversations/${conversationId}/execution/${kind}`,
        body: { commandId: crypto.randomUUID(), runId: run.runId, expectedRevision: run.revision, ...fields } } : undefined);
      const sent = fields ?? pendingCommand?.body;
      setNotice(receipt.operation === "approval" ? sent?.approved ? "已批准本次操作，后续执行仍受原授权约束。" : "已拒绝本次操作。"
        : receipt.operation === "continue" ? "已确认继续原工作，仍受原预算、权限和执行核对约束。"
        : receipt.operation === "input" ? "补充信息已保存，后续处理会使用这些内容；不会自动恢复或重试工具。" : "原请求已核对，请查看对应运行状态。");
      if (receipt.operation === "approval") setSubmitted(previous => [...previous, receipt.resourceId]);
      if (receipt.operation === "input" && sent?.workId === workId && typeof sent?.instruction === "string" && sent.instruction.trim() === instruction.trim()) setInstruction("");
    } catch (value) { setError(value instanceof Error ? value.message : "操作未核对成功，请保留原请求。"); }
    finally { setBusy(false); setResumeWork(null); }
  }
  return <div className="run-interaction">
    {run.workItems.filter(work => ["blocked", "failed"].includes(work.status)).map(work => <div key={work.id} className="work-resumption">
      <p>{work.title} · {work.continuation?.state === "budget_exhausted" ? "执行预算或失败次数已用尽" : "工作已中断，需要处理"}</p>
      {work.error && <details><summary>查看中断原因</summary><p className="reply-text">{work.error}</p></details>}
      {work.continuation?.state === "budget_exhausted" ? <p className="local-receipt">继续或重启不会重置预算。请先核对已保存的进展，再决定后续任务。</p>
        : work.continuation?.state === "review" && run.status === "running" ? <>
          {resumeWork !== JSON.stringify([run.revision, work.id, work.continuation.checkpointRef]) ? <button disabled={disabled} onClick={() => setResumeWork(JSON.stringify([run.revision, work.id, work.continuation!.checkpointRef]))}>检查并继续这项工作</button>
            : <div role="group" aria-label="继续工作确认"><p>将从保存的进度继续。宿主会核对原权限、预算和执行结果；结果未知的操作不会自动重试。</p>
              <button disabled={disabled} onClick={() => void send("continue", { workId: work.id, checkpointRef: work.continuation!.checkpointRef, confirmed: true, reason: "用户确认从保存进度继续" })}>确认继续</button>
              <button disabled={busy} onClick={() => setResumeWork(null)}>暂不继续</button></div>}
        </> : <p className="local-receipt">{run.status === "paused" ? "先恢复调查，再核对这项工作的继续条件。" : "当前无法直接继续，请核对授权、保存的进度及待处理执行结果。"}</p>}
    </div>)}
    {!!run.directives?.some(item => item.issuedBy === "operator") && <details open={hideInput}><summary><CaretRight className="disclosure-caret" aria-hidden="true" />已保存的补充信息</summary>
      {run.directives.filter(item => item.issuedBy === "operator").map(item => <p key={item.id}>{item.instruction}<small className="local-receipt"> · {run.workItems.find(work => work.id === item.targetWorkId)?.title ?? item.targetWorkId}</small></p>)}
    </details>}
    {active && run.workItems.filter(work=>work.pendingApproval&&!submitted.includes(work.pendingApproval.id)).slice(0,1).map(work => work.pendingApproval ? <ApprovalChoice key={work.pendingApproval.id}
      approval={work.pendingApproval} workTitle={work.title} bridge={bridge} conversationId={conversationId} runId={run.runId} revision={run.revision} disabled={disabled || run.status !== "running"}
      submit={(approved, reason) => send("approval", { workId: work.id, approvalId: work.pendingApproval!.id, approved, reason, ...(approved ? { reviewedInputRef: work.pendingApproval!.inputRef } : {}) })} /> : null)}
    {!hideInput&&active && available.length > 0 && <details className="interaction-input"><summary><CaretRight className="disclosure-caret" aria-hidden="true" />补充信息</summary>
      {run.status === "paused" && <p className="local-receipt">调查已暂停，可以保存补充信息；审批需恢复运行后重新核对。</p>}
      <p className="local-receipt">补充内容会进入所选工作项的上下文，不是新增授权，也不会自动恢复或重试工具。不要在这里输入密码或令牌。</p>
      <label>对应工作项<select value={workId} disabled={disabled} onChange={event => setWorkId(event.target.value)}><option value="">选择工作项</option>{available.map(work => <option key={work.id} value={work.id}>{work.title}</option>)}</select></label>
      {available.find(work => work.id === workId)?.error && <p>当前阻塞：{available.find(work => work.id === workId)!.error}</p>}
      <label>补充内容<textarea rows={3} maxLength={8000} disabled={disabled} value={instruction} onChange={event => setInstruction(event.target.value)} /></label>
      <button disabled={disabled || !instruction.trim() || !available.some(work => work.id === workId)} onClick={() => void send("input", { workId, instruction })}>提交补充信息</button>
    </details>}
    {pending && <div><p className="local-receipt">待核对：{pendingCommand!.path.split("/").at(-1)} · 运行 {String(pendingCommand!.body.runId ?? "新运行")}</p><button disabled={busy || damaged} onClick={() => void send()}>核对待处理请求</button></div>}
    {damaged && <p role="alert">待确认记录无法读取，操作已暂停，请保留记录并核对宿主状态。</p>}
    {error && <p role="alert">{error}</p>}{notice && <p role="status" className="local-receipt">{notice}</p>}
  </div>;
}
