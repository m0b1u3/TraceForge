import React, { useEffect, useRef, useState } from "react";
import { ApprovalPreferenceSchema } from "@traceforge/shared/desktop-approval-preference";
import type { DesktopConversations } from "./desktop-conversation-transport";

export function ApprovalPreference({ bridge }: { bridge: DesktopConversations }) {
  const [saved, setSaved] = useState<{ revision: number; routineApprovalRequired: boolean } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const locked = useRef(false), mounted = useRef(false);
  async function request(change = false) {
    if (locked.current || change && !saved) return;
    locked.current = true; setBusy(true); setError("");
    try {
      const result = await bridge.request({ path: "/api/desktop/approval-preference", method: change ? "POST" : "GET",
        ...(change ? { body: JSON.stringify({ expectedRevision: saved!.revision, routineApprovalRequired: !saved!.routineApprovalRequired }) } : {}) });
      if (result.status !== 200) throw new Error();
      const snapshot = ApprovalPreferenceSchema.parse(result.body);
      if (change && (snapshot.revision !== saved!.revision + 1 || snapshot.routineApprovalRequired === saved!.routineApprovalRequired)) throw new Error();
      if (mounted.current) setSaved(snapshot);
    } catch {
      if (mounted.current) { setSaved(null); setError("未确认询问设置，请重新读取。不会自动重试切换。"); }
    } finally { locked.current = false; if (mounted.current) setBusy(false); }
  }
  useEffect(() => {
    mounted.current = true; void request();
    const refresh = () => { void request(); }; window.addEventListener("focus", refresh);
    return () => { mounted.current = false; window.removeEventListener("focus", refresh); };
  }, [bridge]);
  return <div className="approval-preference">
    <button type="button" role="switch" aria-checked={saved?.routineApprovalRequired ?? true}
      aria-label="常规修改前询问" disabled={busy || !saved} onClick={() => void request(true)}
      title="关闭后，任务隔离工作区内的读写和脚本执行自动进行；涉及宿主资源或其他高风险工具仍需确认。既有审批仍需处理，沙箱不变。">
      常规修改前询问 · {busy ? "同步中…" : saved ? saved.routineApprovalRequired ? "开" : "关" : "未读取"}
    </button>
    {saved && <span role="status">全局 · {saved.routineApprovalRequired ? "修改前确认" : "常规修改自动允许"} · 高风险仍询问</span>}
    {error && <><span role="alert">{error}</span><button disabled={busy} onClick={() => void request()}>重新读取</button></>}
  </div>;
}
