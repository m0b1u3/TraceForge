import React, { useEffect, useRef, useState } from "react";
import { ArrowUp, ChatCircle, CheckSquare, FolderSimple, GearSix, SidebarSimple, ClockCounterClockwise } from "@phosphor-icons/react";
import { ConversationClient } from "./conversation-client";
import type { SavedConversation, SavedMessage } from "./conversation-client";
import { desktopConversationTransport } from "./desktop-conversation-transport";
import type { DesktopConversations } from "./desktop-conversation-transport";
import { HostConversationController } from "./host-conversation-controller";
import type { PendingCommand } from "./host-conversation-controller";
import { shouldSendOnEnter } from "./preview-state";
import { ModelSettings } from "./model-settings";
import type { ModelSettingsBridge } from "./model-settings-client";
import { ExecutionPanel } from "./execution-panel";
import { ConversationExecution } from "./conversation-execution";
import "./host-workbench.css";

export function HostWorkbench({ bridge, modelBridge }: { bridge: DesktopConversations; modelBridge?: ModelSettingsBridge }) {
  const [setup] = useState(() => {
    try { return { controller: new HostConversationController(new ConversationClient(desktopConversationTransport(bridge)), window.localStorage), error: "" }; }
    catch { return { controller: null, error: "无法读取本地待确认命令。未发出请求，请保留记录后检查本地存储。" }; }
  });
  const controller = setup.controller;
  const [sessions, setSessions] = useState<SavedConversation[]>([]);
  const [current, setCurrent] = useState<SavedConversation | null>(null);
  const [messages, setMessages] = useState<SavedMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(setup.error);
  const [notice, setNotice] = useState("");
  const [panel, setPanel] = useState("sessions");
  const generation = useRef(0);
  const input = useRef<HTMLTextAreaElement>(null);

  async function load() {
    if (!controller) return;
    setBusy(true); setError("");
    try { setSessions(await controller.list()); }
    catch { setError("无法读取宿主会话，请检查本机连接后重试。不会回退为演示数据。"); }
    finally { setBusy(false); }
  }
  useEffect(() => { void load(); }, [controller]);
  async function select(id: string) {
    if (!controller || busy || controller.pending) return;
    const ticket = ++generation.current;
    setBusy(true); setError("");
    try {
      const restored = await controller.restore(id);
      if (ticket !== generation.current) return;
      setCurrent(restored.conversation); setMessages(restored.messages); setDraft(""); setPanel("");
    } catch { setError("恢复未完成。旧内容未覆盖，请重试；不会把不完整分页显示为完整记录。"); }
    finally { if (ticket === generation.current) setBusy(false); }
  }
  async function execute(command?: PendingCommand) {
    if (!controller || busy) return;
    setBusy(true); setError("");
    try {
      const result = await controller.execute(command);
      if ("caseId" in result) { setCurrent(result); setMessages([]); setSessions(await controller.list()); }
      else {
        const restored = await controller.restore(result.conversationId);
        setCurrent(restored.conversation); setMessages(restored.messages); setDraft("");
      }
      setPanel(""); setNotice("说明已保存。请在对话中确认范围后启动调查。");
    } catch { setError(controller.pending ? "请求尚未核对成功。原命令已保留，请点击“核对原请求”；不要重新创建或重复发送。" : "请求回执已保存，但视图刷新失败。请重新读取会话。"); }
    finally { setBusy(false); }
  }
  const disabled = busy || !controller || !!controller.pending;
  const send = () => { if (current && draft.trim() && !disabled) void execute({ kind: "send", commandId: crypto.randomUUID(), conversationId: current.id, text: draft }); };
  return <div className="workbench host-workbench">
    <a className="skip-link" href="#dialogue">跳到对话</a>
    <header className="topbar"><span className="brand">TraceForge</span><h1 className="host-title">{current?.title ?? "新会话"}</h1>
      <div className="host-header-actions">{busy && <span role="status">正在核对…</span>}
        <button className="icon-button" aria-label="任务与证据" title="任务与证据" aria-pressed={panel === "tasks"} onClick={() => setPanel(panel === "tasks" ? "" : "tasks")}><SidebarSimple aria-hidden="true" /></button>
        <button className="icon-button" aria-label="会话记录" title="会话记录" aria-pressed={panel === "sessions"} onClick={() => setPanel(panel === "sessions" ? "" : "sessions")}><ClockCounterClockwise aria-hidden="true" /></button>
      </div></header>
    <nav className="rail" aria-label="工作台导航">
      <button className={`nav-button${!panel ? " selected" : ""}`} aria-label="对话" title="对话" aria-current={!panel ? "page" : undefined} onClick={() => { setPanel(""); input.current?.focus(); }}><ChatCircle aria-hidden="true" /></button>
      <button className={`nav-button${panel === "tasks" ? " selected" : ""}`} aria-label="任务" title="任务" aria-current={panel === "tasks" ? "page" : undefined} onClick={() => setPanel("tasks")}><CheckSquare aria-hidden="true" /></button>
      <button className={`nav-button${panel === "evidence" ? " selected" : ""}`} aria-label="证据" title="证据" aria-current={panel === "evidence" ? "page" : undefined} onClick={() => setPanel("evidence")}><FolderSimple aria-hidden="true" /></button>
      <button className={`nav-button${panel === "settings" ? " selected" : ""}`} aria-label="设置" title="设置" aria-current={panel === "settings" ? "page" : undefined} onClick={() => setPanel("settings")}><GearSix aria-hidden="true" /></button>
    </nav>
    <main className="workspace"><section className="dialogue" id="dialogue" tabIndex={-1} aria-label="宿主会话">
      <div className="conversation-scroll"><div className="transcript">
        {panel ? <section className="host-panel">{(!(panel === "tasks" || panel === "evidence") || !current) && <h2>{({ sessions: "会话记录", tasks: "任务", evidence: "证据", settings: "设置" } as Record<string, string>)[panel]}</h2>}
          {panel === "sessions" ? <><p>这里只显示宿主保存的记录，不包含演示消息。</p><div className="host-session-actions"><button disabled={disabled || !!draft} onClick={() => void execute({ kind: "create", commandId: crypto.randomUUID(), title: "新调查会话" })}>新建会话</button><button disabled={busy || !controller} onClick={() => void load()}>重新读取</button></div>{!sessions.length && <p>尚无已保存会话。</p>}<ul className="host-session-list">{sessions.map(session => <li key={session.id}><button disabled={disabled || !!draft} onClick={() => void select(session.id)}>{session.title}<span>{session.createdAt.slice(0, 10)}</span></button></li>)}</ul>{draft && <p>请先发送或清空当前草稿，再切换会话。</p>}</> : panel === "settings" ? <ModelSettings bridge={modelBridge} /> : !current ? <p>请先创建或打开会话。</p> : null}
          {(panel === "tasks" || panel === "evidence") && current && <ExecutionPanel key={current.id} bridge={bridge} conversationId={current.id} messages={messages} evidenceOnly={panel === "evidence"} />}
          <button onClick={() => setPanel("")}>返回对话</button>
        </section> : <>{!messages.length && <div className="host-empty"><h2>{current ? "记录你的调查意图" : "先创建或打开会话"}</h2><p>保存说明并确认授权后启动任务。进展和已保存输出会回到对话中，任务与依据按需展开。</p><button onClick={() => setPanel("sessions")}>打开会话记录</button></div>}{current && <ConversationExecution key={current.id} bridge={bridge} conversationId={current.id} messages={messages} />}</>}
      </div></div>
      <div className="composer-area"><div role="status" className="live-notice">{notice}</div>{error && <p role="alert" className="inline-warning">{error}</p>}{controller?.pending && <button disabled={busy} onClick={() => void execute()}>核对原请求</button>}
        <form className="composer host-composer" onSubmit={event => { event.preventDefault(); send(); }}><textarea ref={input} aria-label="保存调查说明" placeholder={current ? "继续对话…" : "请先创建或打开会话"} disabled={!current || disabled} value={draft} onChange={event => setDraft(event.target.value)} maxLength={16000} rows={1} onKeyDown={event => { if (shouldSendOnEnter({ key: event.key, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing, keyCode: event.keyCode })) { event.preventDefault(); send(); } }} /><button className="send primary icon-button" aria-label="保存到宿主" disabled={!current || disabled || !draft.trim()}><ArrowUp aria-hidden="true" /></button><div className="composer-footnote"><button type="button" onClick={() => setPanel("settings")}><GearSix aria-hidden="true" />模型设置</button><span>{draft.length ? `${draft.length} / 16000` : "保存说明后，明确授权才执行"}</span></div></form>
      </div>
    </section></main>
  </div>;
}
