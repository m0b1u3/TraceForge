import React, { useMemo, useState } from "react";
import { ExecutionController } from "./execution-controller";
import type { DesktopConversations } from "./desktop-conversation-transport";
import { PermissionChange } from "./permission-change";

/** Uses the same durable command controller as the task panel. */
export function RunControl({ bridge, conversationId, runId, revision, status }: {
  bridge: DesktopConversations; conversationId: string; runId: string; revision: number; status: string;
}) {
  const controller = useMemo(() => new ExecutionController(bridge, localStorage, conversationId), [bridge, conversationId]);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(""), [confirmResume,setConfirmResume]=useState(false);
  const [permissionPending,setPermissionPending]=useState(false);
  let pending = false, invalid = false;
  try { pending = !!controller.pending; } catch { invalid = true; }
  const terminal = ["completed", "cancelled", "failed"].includes(status);
  async function stop(reconcile: boolean, operation:"cancel"|"pause"|"resume"="cancel") {
    if(operation==="resume"&&permissionPending)return;
    setBusy(true); setNotice("");
    try {
      const result = await controller.execute(reconcile ? undefined : { path: `/api/desktop/conversations/${conversationId}/execution/${operation}`,
        body: { commandId: crypto.randomUUID(), runId, expectedRevision: revision,...(operation==="resume"?{confirmed:true}:{}) } });
      setNotice(result.resourceId===runId && result.operation === "cancel" ? "宿主已确认停止。等待状态刷新；不代表外部副作用已撤销。" : result.operation==="pause"?"已暂停。补充信息不会自动恢复调查。":result.operation==="resume"?"已确认恢复，继续受原授权和执行安全检查约束。":"原请求已核对，请查看最新任务状态。");
    } catch (error) { setNotice(error instanceof Error ? error.message : "请求未核对成功，请保留原请求。"); }
    finally { setBusy(false);setConfirmResume(false); }
  }
  return <div className="run-control">
    <PermissionChange key={runId} bridge={bridge} conversationId={conversationId} runId={runId} canChange={status==="paused"} inspectRevision={revision} onPending={setPermissionPending}/>
    {status==="running"&&<button disabled={busy||pending||invalid} onClick={()=>void stop(false,"pause")}>暂停调查</button>}
    {status==="paused"&&!confirmResume&&<button disabled={busy||pending||invalid||permissionPending} onClick={()=>setConfirmResume(true)}>恢复调查</button>}
    {status==="paused"&&confirmResume&&<div role="group" aria-label="恢复调查确认"><p>恢复后可能继续执行已授权的工作。不会扩大授权，也不会绕过待审批或未知执行结果。</p><button disabled={busy||pending||invalid} onClick={()=>void stop(false,"resume")}>确认恢复</button><button disabled={busy} onClick={()=>setConfirmResume(false)}>保持暂停</button></div>}
    {!terminal && <button disabled={busy || pending || invalid} onClick={() => void stop(false)}>{busy ? "正在核对…" : "停止调查"}</button>}
    {pending && <button disabled={busy || invalid} onClick={() => void stop(true)}>核对原请求</button>}
    {invalid && <p role="alert">本地待确认记录无法读取，操作已暂停。请保留记录并核对宿主状态。</p>}
    {notice && <p role="status" className="local-receipt">{notice}</p>}
  </div>;
}
