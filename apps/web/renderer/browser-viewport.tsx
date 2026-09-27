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
  const [title, setTitle] = useState("新标签页"), [draft, setDraft] = useState("");
  const editing = useRef(false);
  const [tabs, setTabs] = useState<Array<{id:string;title:string;url:string}>>([]);
  const [activePage, setActivePage] = useState("");
  const [history, setHistory] = useState({ back: false, forward: false, loading: false });
  const [navigationError, setNavigationError] = useState("");
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
        if (alive) { setAddress(result.url || "about:blank");
          if (!editing.current) setDraft(result.url || "about:blank");
          setTitle(result.title || "新标签页");
          setTabs(result.tabs ?? []); setActivePage(result.activePageId ?? "");
          setHistory({ back: !!result.canGoBack, forward: !!result.canGoForward, loading: !!result.loading });
          setConnected(true); } else hide();
      } catch { hide(); if (alive) setError("页面连接已中断。重新连接只恢复显示，不重复网页操作。"); }
      finally { pending = false; }
    }
    void present(); const timer = setInterval(() => void present(), 600);
    const overlays = new MutationObserver(() => { if (document.querySelector('[role="dialog"],dialog[open]')) hide(); });
    overlays.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["open", "role"] });
    window.addEventListener("resize", present);
    return () => { alive = false; clearInterval(timer); overlays.disconnect(); window.removeEventListener("resize", present); hide(); document.body.classList.remove("native-browser-open"); };
  }, [bridge, path, sessionId, takeoverId, revision, error]);
  async function navigate(action: "navigate" | "back" | "forward" | "reload" | "new-tab" | "select-tab" | "close-tab", pageId?: string) {
    const rect = slot.current?.getBoundingClientRect();
    if (!rect || !bridge.presentBrowser || !takeoverId || busy) return;
    let url: string | undefined;
    if (action === "navigate") {
      try {
        const value = draft.trim();
        if (!value) throw new Error();
        const target = new URL(/^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`);
        if (!["http:", "https:"].includes(target.protocol) || target.username || target.password) throw new Error();
        url = target.href;
      } catch { setNavigationError("请输入有效的 HTTP 或 HTTPS 网页地址。"); return; }
    }
    setBusy(true); setNavigationError(""); editing.current = false;
    try {
      await bridge.presentBrowser({ path, sessionId, takeoverId, navigation: { action, ...(url ? { url } : {}), ...(pageId ? { pageId } : {}) },
        bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } });
    } catch { setNavigationError("页面未能打开，请检查地址、网络或任务授权范围后重试。"); }
    finally { setBusy(false); }
  }
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
        <div className="native-browser-heading"><strong title={title}>{title}</strong><span className="native-browser-control-state"><span className="native-browser-state-dot" />{takeoverId ? "由你控制" : "智能体正在操作"}</span></div>
      </div>
      <div className="native-browser-actions">
        {takeoverId ? <button className="native-browser-primary" disabled={busy} onClick={() => void handback()}>交回智能体</button>
          : <button className="native-browser-primary" disabled={busy} onClick={() => void send({ operation: "takeover", sessionId, commandId: crypto.randomUUID() })}>接管网页</button>}
        <button className="native-browser-secondary" disabled={busy} onClick={onHide}>收起</button>
      </div>
    </header>
    <div className="native-browser-tabs" role="tablist" aria-label="网页标签">
      {tabs.map(tab => <div className="native-browser-tab" key={tab.id} data-selected={tab.id === activePage}>
        <button role="tab" aria-selected={tab.id === activePage} title={tab.url} disabled={!takeoverId || busy}
          onClick={() => void navigate("select-tab", tab.id)}>{tab.title || "新标签页"}</button>
        <button aria-label={`关闭标签：${tab.title || "新标签页"}`} disabled={!takeoverId || busy}
          onClick={() => void navigate("close-tab", tab.id)}>×</button>
      </div>)}
      <button className="native-browser-new-tab" aria-label="新建标签页" title="新建标签页" disabled={!takeoverId || busy}
        onClick={() => void navigate("new-tab")}>+</button>
    </div>
    <form className="native-browser-navigation" onSubmit={event => { event.preventDefault(); void navigate("navigate"); }}>
      <button type="button" aria-label="后退" title="后退" disabled={!takeoverId || busy || !history.back} onClick={() => void navigate("back")}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 6-6 6 6 6M8 12h12" /></svg></button>
      <button type="button" aria-label="前进" title="前进" disabled={!takeoverId || busy || !history.forward} onClick={() => void navigate("forward")}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m10 6 6 6-6 6M4 12h12" /></svg></button>
      <button type="button" aria-label="刷新" title="刷新" disabled={!takeoverId || busy} onClick={() => void navigate("reload")}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 10a8 8 0 1 0 0 5M20 4v6h-6" /></svg></button>
      <input aria-label="网页地址" title={address} type="text" autoComplete="off" spellCheck={false} readOnly={!takeoverId} value={draft}
        onFocus={() => { editing.current = true; }} onBlur={() => { editing.current = false; }} onChange={event => setDraft(event.target.value)}
        onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); setDraft(address); editing.current = false; event.currentTarget.blur(); } }} />
      <button type="submit" disabled={!takeoverId || busy}>转到</button>
    </form>
    {history.loading && <div className="native-browser-loading" role="status">正在加载页面…</div>}
    {navigationError && <p className="native-browser-navigation-error" role="alert">{navigationError}</p>}
    <div className="native-browser-slot" ref={slot}>
      {error ? <div className="native-browser-message"><p role="alert">{error}</p><button onClick={() => { setConnected(false); setError(""); setRevision(n => n + 1); }}>重新连接</button></div>
        : !connected && <p role="status">正在显示网页…</p>}
    </div>
    <footer>{takeoverId ? <><button disabled={!connected || !!error || busy} onClick={() => void focusPage()}>进入网页</button><span>F6 返回应用 · 收起后仍由你控制</span></> : <span>实时页面 · 接管后可直接操作</span>}</footer>
  </aside>, document.body);
}
