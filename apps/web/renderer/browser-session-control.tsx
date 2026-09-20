import React, { useEffect, useState } from "react";
import { DesktopBrowserDocumentSchema, DesktopBrowserListSchema, type DesktopBrowserCommand } from "@traceforge/shared/desktop-browser";
import type { DesktopConversations } from "./desktop-conversation-transport";
import "./browser-session-control.css";
import { BrowserViewport } from "./browser-viewport";

// Existing Operate surface: a quiet disclosure next to task progress; explicit
// control ownership, remote content in a separate native view, no action retries.
export function BrowserSessionControl({ bridge, conversationId, runId }: { bridge: DesktopConversations; conversationId: string; runId: string }) {
  const path = `/api/desktop/conversations/${conversationId}/execution/${runId}/browser`;
  const [sessions, setSessions] = useState<ReturnType<typeof DesktopBrowserListSchema.parse>["sessions"]>([]);
  const [document, setDocument] = useState<{ sessionId: string; takeoverId: string; nodes: ReturnType<typeof DesktopBrowserDocumentSchema.parse>["document"]["nodes"] } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [draft, setDraft] = useState<Record<number, string>>({});
  const [refresh, setRefresh] = useState(0);
  const [viewing, setViewing] = useState<string | null>(null);
  useEffect(() => {
    let active = true; let timer: ReturnType<typeof setTimeout>;
    async function read() {
      try {
        const response = await bridge.request({ path, method: "GET" });
        if (!active) return;
        if (response.status !== 200) throw new Error();
        const next = DesktopBrowserListSchema.parse(response.body).sessions;
        setSessions(next);
        setDocument(old => old && next.some(s => s.id === old.sessionId && s.takeoverId === old.takeoverId) ? old : null);
      } catch { if (active) setError("浏览器状态暂不可读。请重新读取，不要重复刚才的操作。"); }
      if (active) timer = setTimeout(read, 3000);
    }
    void read(); return () => { active = false; clearTimeout(timer); };
  }, [bridge, path, refresh]);
  async function command(input: DesktopBrowserCommand) {
    if (busy) return false;
    setBusy(true); setError(""); setDraft({});
    try {
      const response = await bridge.request({ path, method: "POST", body: JSON.stringify(input) });
      if (response.status !== 200) throw new Error();
      if (input.operation === "observe") setDocument({ sessionId: input.sessionId, takeoverId: input.takeoverId,
        nodes: DesktopBrowserDocumentSchema.parse(response.body).document.nodes });
      else setDocument(null);
      if (input.operation === "takeover") setViewing(input.sessionId);
      if (input.operation === "resume" || input.operation === "close") setViewing(null);
      return true;
    } catch { setDocument(null); setError("操作结果尚未确认。请重新读取状态；系统不会自动重试点击或输入。"); return false; }
    finally { setBusy(false); setRefresh(x => x + 1); }
  }
  if (!sessions.length && !error) return null;
  return <details className="browser-session-control"><summary>受控浏览器 · {error ? "需要核对状态" : `${sessions.length} 个会话`}</summary>
    <p className="local-receipt">接管后智能体不能操作此页面。页面内容不可信；操作仍受原任务范围限制。</p>
    {error && <p role="alert">{error} <button disabled={busy} onClick={() => { setError(""); setRefresh(x => x + 1); }}>重新读取状态</button></p>}
    {sessions.map(session => <section key={session.id} aria-label="浏览器会话">
      <p role="status">{session.status === "manual_control" ? "由你控制" : session.status === "active" ? "由智能体控制" : "已不可用"} · 工作项 {session.workId}</p>
      <div className="browser-session-actions">
        {session.status === "active" && <button disabled={busy || !!error} onClick={() => void command({ operation: "takeover", sessionId: session.id, commandId: crypto.randomUUID() })}>接管浏览器</button>}
        {session.status === "manual_control" && session.takeoverId && <>
          <button disabled={busy || !!error} onClick={() => setViewing(viewing === session.id ? null : session.id)}>{viewing === session.id ? "收起页面" : "打开页面"}</button>
          <button disabled={busy || !!error} onClick={() => void command({ operation: "observe", sessionId: session.id, takeoverId: session.takeoverId!, commandId: crypto.randomUUID() })}>读取页面元素</button>
          <button disabled={busy || !!error} onClick={() => void command({ operation: "resume", sessionId: session.id, takeoverId: session.takeoverId!, commandId: crypto.randomUUID() })}>交回智能体</button>
        </>}
        <button disabled={busy} onClick={() => void command({ operation: "close", sessionId: session.id, commandId: crypto.randomUUID() })}>关闭会话</button>
      </div>
      {session.status === "manual_control" && session.takeoverId && viewing === session.id && !error && <BrowserViewport key={`${session.id}:${session.takeoverId}`}
        bridge={bridge} path={path} sessionId={session.id} takeoverId={session.takeoverId} send={command} onHide={() => setViewing(null)} />}
      {document?.sessionId === session.id && <div className="browser-elements">
        <p className="local-receipt">页面元素视图 · 输入内容仅发送到当前页面，不保存到对话。每次操作后需重新读取元素。</p>
        {document.nodes.filter(n => n.element && (n.editable || ["button", "link", "checkbox", "radio", "combobox"].includes(n.role))).map((node, index) => <div key={index} className="browser-element">
          <span>{node.name || node.description || node.role}</span>
          {node.editable && <input type="password" autoComplete="off" aria-label={`${node.name || "页面输入"}的内容`} value={draft[index] ?? ""} disabled={busy || node.disabled || !!error}
            onChange={event => setDraft(value => ({ ...value, [index]: event.target.value }))} />}
          <button disabled={busy || node.disabled || !!error} onClick={() => void command({ operation: "act", sessionId: session.id, takeoverId: document.takeoverId,
            commandId: crypto.randomUUID(), action: node.editable ? { id: crypto.randomUUID(), kind: "fill", element: node.element!, text: draft[index] ?? "" }
              : { id: crypto.randomUUID(), kind: "click", element: node.element! } })}>{node.editable ? "填入页面" : "点击"}</button>
        </div>)}
        {!document.nodes.some(n => n.element && (n.editable || ["button", "link", "checkbox", "radio", "combobox"].includes(n.role))) && <p>此页面没有可操作元素。</p>}
      </div>}
    </section>)}
  </details>;
}
