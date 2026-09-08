import React, { useMemo, useState } from "react";
import { ExecutionController } from "./execution-controller";
import type { DesktopConversations } from "./desktop-conversation-transport";

/** Uses the same durable command controller as the task panel. */
export function RunControl({ bridge, conversationId, runId, revision, status }: {
  bridge: DesktopConversations; conversationId: string; runId: string; revision: number; status: string;
}) {
  const controller = useMemo(() => new ExecutionController(bridge, localStorage, conversationId), [bridge, conversationId]);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  let pending = false, invalid = false;
  try { pending = !!controller.pending; } catch { invalid = true; }
  const terminal = ["completed", "cancelled", "failed"].includes(status);
  async function stop(reconcile: boolean) {
    setBusy(true); setNotice("");
    try {
      const result = await controller.execute(reconcile ? undefined : { path: `/api/desktop/conversations/${conversationId}/execution/cancel`,
        body: { commandId: crypto.randomUUID(), runId, expectedRevision: revision } });
      setNotice(result.operation === "cancel" && result.resourceId === runId ? "宿主已确认停止。等待状态刷新；不代表外部副作用已撤销。" : "原请求已核对，请查看最新任务状态。");
    } catch (error) { setNotice(error instanceof Error ? error.message : "请求未核对成功，请保留原请求。"); }
    finally { setBusy(false); }
  }
  return <div className="run-control">
    {!terminal && <button disabled={busy || pending || invalid} onClick={() => void stop(false)}>{busy ? "正在核对…" : "停止调查"}</button>}
    {pending && <button disabled={busy || invalid} onClick={() => void stop(true)}>核对原请求</button>}
    {invalid && <p role="alert">本地待确认记录无法读取，操作已暂停。请保留记录并核对宿主状态。</p>}
    {notice && <p role="status" className="local-receipt">{notice}</p>}
  </div>;
}
