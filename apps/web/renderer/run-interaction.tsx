import React, { useMemo, useState } from "react";
import { CaretRight, Shield } from "@phosphor-icons/react";
import type { ConversationRun } from "./conversation-execution";
import type { DesktopConversations } from "./desktop-conversation-transport";
import { ExecutionController } from "./execution-controller";
import type { DesktopPendingApproval } from "@traceforge/shared/desktop-execution";

function ApprovalChoice({ approval, workTitle, revision, disabled, submit, bridge, conversationId, runId }: { approval: DesktopPendingApproval; workTitle: string; revision: number; disabled: boolean;
  bridge: DesktopConversations; conversationId: string; runId: string;
  submit(approved: boolean, reason: string): Promise<void> }) {
  const [reason, setReason] = useState(""), [confirmed, setConfirmed] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ inputRef: string; input: string } | null>(null), [loading, setLoading] = useState(false), [previewError, setPreviewError] = useState("");
  const inspected = preview?.inputRef === approval.inputRef;
  const identity = JSON.stringify([approval, revision, reason]);
  const risk = ({ read_only: "只读", bounded_write: "有限写入", privileged: "高权限", destructive: "破坏性" })[approval.risk];
  async function inspect() {
    setLoading(true); setPreviewError(""); setConfirmed(null); setPreview(null);
    try {
      const result = await bridge.request({ path: `/api/desktop/conversations/${conversationId}/execution/approval-input`, method: "POST", body: JSON.stringify({ runId, workId: approval.workId, approvalId: approval.id }) });
      const value = result.body as { runId?: unknown; workId?: unknown; approvalId?: unknown; inputRef?: unknown; input?: unknown };
      if (result.status !== 200 || value?.runId !== runId || value.workId !== approval.workId || value.approvalId !== approval.id || value.inputRef !== approval.inputRef || typeof value.input !== "string" || new TextEncoder().encode(value.input).length > 32768) throw new Error("Invalid preview");
      setPreview({ inputRef: value.inputRef, input: value.input });
    } catch { setPreviewError("无法读取或核对具体参数，暂不能批准。你仍可拒绝这次操作。"); }
    finally { setLoading(false); }
  }
  return <section className="interaction-approval" aria-label="操作审批">
    <h3><Shield aria-hidden="true" />需要你确认</h3><p>{workTitle}</p><p>{approval.toolName} · {risk}</p>
    <p>{approval.rationale}</p><details><summary><CaretRight className="disclosure-caret" aria-hidden="true" />核对操作标识</summary><p>操作：{approval.actionKey}</p><p>输入引用：{approval.inputRef}</p></details>
    <button disabled={disabled || loading} onClick={() => void inspect()}>{loading ? "正在核对参数…" : "查看具体参数"}</button>
    {inspected && <pre className="interaction-parameters" tabIndex={0} aria-label="待执行参数">{preview!.input}</pre>}
    {previewError && <p role="alert">{previewError}</p>}
    <label>处理说明<textarea rows={2} maxLength={4000} disabled={disabled} value={reason} onChange={event => { setReason(event.target.value); setConfirmed(null); }} placeholder="说明允许或拒绝这次操作的原因" /></label>
    <label className="execution-confirm"><input type="checkbox" disabled={disabled || !inspected} checked={confirmed === identity && inspected} onChange={event => setConfirmed(event.target.checked ? identity : null)} />我已核对具体参数；批准不会扩大原授权范围</label>
    <div className="interaction-actions"><button disabled={disabled || !reason.trim()} onClick={() => void submit(false, reason)}>拒绝操作</button>
      <button className="primary" disabled={disabled || !inspected || !reason.trim() || confirmed !== identity} onClick={() => void submit(true, reason)}>批准本次操作</button></div>
  </section>;
}
/** User intent is a durable command, never a side effect of receiving an event. */
export function RunInteraction({ bridge, conversationId, run, hideInput=false }: { bridge: DesktopConversations; conversationId: string; run: ConversationRun; hideInput?:boolean }) {
  const controller = useMemo(() => new ExecutionController(bridge, localStorage, conversationId), [bridge, conversationId]);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(""), [error, setError] = useState("");
  const [workId, setWorkId] = useState(""), [instruction, setInstruction] = useState("");
  const [submitted, setSubmitted] = useState<string[]>([]);
  let pendingCommand: { path: string; body: Record<string, unknown> } | null = null, damaged = false;
  try { pendingCommand = controller.pending; } catch { damaged = true; }
  const pending = !!pendingCommand;
  const active = ["running", "paused"].includes(run.status);
  const available = run.workItems.filter(work => !["completed", "cancelled"].includes(work.status));
  const disabled = busy || pending || damaged || !active;
  async function send(kind?: "approval" | "input", fields?: Record<string, unknown>) {
    setBusy(true); setNotice(""); setError("");
    try {
      const receipt = await controller.execute(kind ? { path: `/api/desktop/conversations/${conversationId}/execution/${kind}`,
        body: { commandId: crypto.randomUUID(), runId: run.runId, expectedRevision: run.revision, ...fields } } : undefined);
      const sent = fields ?? pendingCommand?.body;
      setNotice(receipt.operation === "approval" ? sent?.approved ? "已批准本次操作，后续执行仍受原授权约束。" : "已拒绝本次操作。"
        : receipt.operation === "input" ? "补充信息已保存，后续处理会使用这些内容；不会自动恢复或重试工具。" : "原请求已核对，请查看对应运行状态。");
      if (receipt.operation === "approval") setSubmitted(previous => [...previous, receipt.resourceId]);
      if (receipt.operation === "input" && sent?.workId === workId && typeof sent?.instruction === "string" && sent.instruction.trim() === instruction.trim()) setInstruction("");
    } catch (value) { setError(value instanceof Error ? value.message : "操作未核对成功，请保留原请求。"); }
    finally { setBusy(false); }
  }
  return <div className="run-interaction">
    {!!run.directives?.some(item => item.issuedBy === "operator") && <details open={hideInput}><summary><CaretRight className="disclosure-caret" aria-hidden="true" />已保存的补充信息</summary>
      {run.directives.filter(item => item.issuedBy === "operator").map(item => <p key={item.id}>{item.instruction}<small className="local-receipt"> · {run.workItems.find(work => work.id === item.targetWorkId)?.title ?? item.targetWorkId}</small></p>)}
    </details>}
    {active && run.workItems.map(work => work.pendingApproval && !submitted.includes(work.pendingApproval.id) ? <ApprovalChoice key={work.pendingApproval.id}
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
