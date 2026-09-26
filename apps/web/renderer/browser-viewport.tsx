import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { DesktopBrowserCommand } from "@traceforge/shared/desktop-browser";
import type { DesktopConversations } from "./desktop-conversation-transport";
import { usePanelFocus } from "./panel-focus";

export function BrowserViewport({ bridge, path, sessionId, takeoverId, send, onHide }: {
  bridge: DesktopConversations; path: string; sessionId: string; takeoverId: string | null;
  send(command: DesktopBrowserCommand): Promise<boolean>; onHide?: () => void;
}) {
  const slot = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null), handingBack = useRef(false);
  usePanelFocus(panel, sessionId, () => { if (!handingBack.current) onHide?.(); });
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState(""), [address, setAddress] = useState("正在连接页面…");
  const [busy, setBusy] = useState(false), [revision, setRevision] = useState(0);
  useEffect(() => {
    const previous = document.activeElement;
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    let alive = true, pending = false;
    document.body.classList.add("native-browser-open");
    const hide = () => { void bridge.presentBrowser?.({ hide: true }).catch(() => undefined); };
    async function present() {
      if (!alive || pending || error) return;
      if (!bridge.presentBrowser) { setError("原生网页视图仅在桌面客户端可用。"); return; }
      if (document.visibilityState === "hidden" || document.querySelector('[role="dialog"],dialog[open]')) { hide(); return; }
      const rect = slot.current?.getBoundingClientRect(); if (!rect) return;
      pending = true;
      try {
        const result = await bridge.presentBrowser({ path, sessionId, takeoverId,
          bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } });
        if (alive) { setAddress(result.url || "空白页面"); setConnected(true); } else hide();
      } catch { hide(); if (alive) setError("页面连接已中断。重新连接只恢复显示，不重复网页操作。"); }
      finally { pending = false; }
    }
    void present(); const timer = setInterval(() => void present(), 600);
    const overlays = new MutationObserver(() => { if (document.querySelector('[role="dialog"],dialog[open]')) hide(); });
    overlays.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["open", "role"] });
    window.addEventListener("resize", present);
    return () => { alive = false; clearInterval(timer); overlays.disconnect(); window.removeEventListener("resize", present); hide(); document.body.classList.remove("native-browser-open"); };
  }, [bridge, path, sessionId, takeoverId, revision, error]);
  async function focusPage() {
    const rect = slot.current?.getBoundingClientRect(); if (!rect || !bridge.presentBrowser) return;
    try { await bridge.presentBrowser({ path, sessionId, takeoverId, focus: true,
      bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }); }
    catch { setError("页面连接已中断，请重新连接。"); }
  }
  async function handback() {
    if (!takeoverId || handingBack.current) return;
    handingBack.current = true;
    setBusy(true);
    try {
      await bridge.presentBrowser?.({ hide: true });
      const ok = await send({ operation: "resume", sessionId, takeoverId, commandId: crypto.randomUUID() });
      if (!ok) setError("交回结果尚未确认，请在任务中重新读取状态。");
    } catch { setError("交回结果尚未确认，请在任务中重新读取状态。"); }
    finally { handingBack.current = false; setBusy(false); }
  }
  return createPortal(<aside ref={panel} tabIndex={-1} className="native-browser-panel" data-control={takeoverId ? "manual" : "agent"} aria-label="任务浏览器">
    <header className="native-browser-toolbar">
      <div className="native-browser-identity">
        <span className="native-browser-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.5 3.8 5.5 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.5-3.8-9S9.5 5.5 12 3Z" /></svg></span>
        <div className="native-browser-heading"><strong>任务浏览器</strong><span className="native-browser-control-state"><span className="native-browser-state-dot" />{takeoverId ? "由你控制" : "智能体正在操作"}</span></div>
      </div>
      <div className="native-browser-actions">
        {takeoverId ? <button className="native-browser-primary" disabled={busy} onClick={() => void handback()}>交回智能体</button>
          : <button className="native-browser-primary" disabled={busy} onClick={() => void send({ operation: "takeover", sessionId, commandId: crypto.randomUUID() })}>接管网页</button>}
        <button className="native-browser-secondary" disabled={busy} onClick={onHide}>收起</button>
      </div>
    </header>
    <div className="native-browser-address" title={address}><span className="native-browser-address-label">当前页面</span><span className="native-browser-url">{address}</span></div>
    <div className="native-browser-slot" ref={slot}>
      {error ? <div className="native-browser-message"><p role="alert">{error}</p><button onClick={() => { setConnected(false); setError(""); setRevision(n => n + 1); }}>重新连接</button></div>
        : !connected && <p role="status">正在显示网页…</p>}
    </div>
    <footer>{takeoverId ? <><button disabled={!connected || !!error || busy} onClick={() => void focusPage()}>进入网页</button><span>F6 返回应用 · 收起后仍由你控制</span></> : <span>实时页面 · 接管后可直接操作</span>}</footer>
  </aside>, document.body);
}
