import React, { useEffect, useRef, useState } from "react";
import { ChatCircle, CheckSquare, FolderSimple, GearSix, SidebarSimple, ClockCounterClockwise } from "@phosphor-icons/react";
import { ConversationClient } from "./conversation-client";
import type { SavedConversation, SavedMessage } from "./conversation-client";
import { desktopConversationTransport } from "./desktop-conversation-transport";
import type { DesktopConversations } from "./desktop-conversation-transport";
import { HostConversationController } from "./host-conversation-controller";
import { ConversationDrafts } from "./conversation-drafts";
import { ConversationViewport } from "./conversation-viewport";
import type { PendingCommand } from "./host-conversation-controller";
import { ConversationComposer } from "./conversation-composer";
import { WorkbenchSettings } from "./workbench-settings";
import type { ModelSettingsBridge } from "./model-settings-client";
import { ExecutionPanel } from "./execution-panel";
import { ConversationExecution, type ConversationRun } from "./conversation-execution";
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
  const [runs,setRuns]=useState<ConversationRun[]|null>(null),[composerBusy,setComposerBusy]=useState(false);
  const [draftStore] = useState(() => { try { return new ConversationDrafts(window.sessionStorage); } catch { return null; } });
  const [draft, setDraft] = useState(() => draftStore?.read("new") ?? "");
  const [draftError, setDraftError] = useState(draftStore ? "" : "无法恢复窗口草稿。请勿关闭窗口；发送功能不受影响。");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(setup.error);
  const [notice, setNotice] = useState("");
  const [recoveryId,setRecoveryId]=useState<string|null>(null);
  const [panel, updatePanel] = useState("");
  const [configurationDirty, setConfigurationDirty] = useState(false);
  function setPanel(next: string) {
    if(composerBusy){setNotice("正在核对发送结果，请稍候再切换。");return;}
    if (configurationDirty && next !== "settings") {
      setNotice("模型、场景或 MCP 设置尚未保存或正在处理。请先保存，或在对应设置中重新读取并确认丢弃草稿。"); return;
    }
    updatePanel(next); setNotice("");
  }
  const generation = useRef(0);
  const input = useRef<HTMLTextAreaElement>(null);
  function retainDraft() {
    try { if(!draftStore)throw new Error();draftStore.write(current?.id ?? "new",draft);setDraftError("");return true; }
    catch { setDraftError("草稿暂时无法保留。请先发送，或复制并清空输入后再切换；关闭窗口会丢失未保存内容。");return !draft; }
  }
  function editDraft(value:string){setDraft(value);try{if(!draftStore)throw new Error();draftStore.write(current?.id??"new",value);setDraftError("");}catch{setDraftError("草稿未能保留到窗口存储，请勿关闭或刷新窗口。");}}
  function newConversation(){if(busy||composerBusy||controller?.pending||configurationDirty||!retainDraft())return;setCurrent(null);setRuns(null);setMessages([]);setDraft(draftStore?.read("new")??"");setPanel("");requestAnimationFrame(()=>input.current?.focus());}
  useEffect(()=>{const field=input.current;if(field){field.style.height="auto";field.style.height=`${Math.min(field.scrollHeight,180)}px`;}},[draft,panel]);
  useEffect(()=>{
    const handler=(event:KeyboardEvent)=>{
      if(!(event.metaKey||event.ctrlKey)||event.altKey||event.isComposing)return;
      if(event.key.toLowerCase()==="n"&&event.shiftKey){event.preventDefault();newConversation();}
      else if(event.key===","){event.preventDefault();setPanel("settings");}
      else if(event.key.toLowerCase()==="k"){event.preventDefault();setPanel("sessions");}
    };
    window.addEventListener("keydown",handler);return()=>window.removeEventListener("keydown",handler);
  });
  useEffect(()=>{if(!draft)return;const warn=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue="";};window.addEventListener("beforeunload",warn);return()=>window.removeEventListener("beforeunload",warn);},[draft]);

  async function load() {
    if (!controller) return;
    setBusy(true); setError("");
    try { setSessions(await controller.list()); }
    catch { setError("无法读取宿主会话，请检查本机连接后重试。不会回退为演示数据。"); }
    finally { setBusy(false); }
  }
  useEffect(() => { void load(); }, [controller]);
  async function select(id: string) {
    if (!controller || busy || composerBusy || controller.pending || !retainDraft()) return;
    const ticket = ++generation.current;
    setBusy(true); setError("");
    try {
      const restored = await controller.restore(id);
      if (ticket !== generation.current) return;
      setRuns(null);setCurrent(restored.conversation); setMessages(restored.messages); setDraft(draftStore?.read(id)??""); setRecoveryId(null);setPanel("");
    } catch { setError("恢复未完成。旧内容未覆盖，请重试；不会把不完整分页显示为完整记录。"); }
    finally { if (ticket === generation.current) setBusy(false); }
  }
  async function execute(command?: PendingCommand) {
    if (!controller || busy) return;
    setBusy(true); setError("");
    const original = command ?? controller.pending;
    try {
      const result = await controller.execute(command);
      if ("caseId" in result) { setCurrent(result); setMessages([]); setSessions(await controller.list()); }
      else {
        // A confirmed save must clear the sent draft even if the following read
        // fails; otherwise the enabled composer invites a duplicate submission.
        setRecoveryId(result.conversationId);setDraft("");
        try { draftStore?.write(original?.kind === "start" ? "new" : result.conversationId, ""); } catch { setDraftError("消息已保存，但窗口草稿清理失败。重新打开时请核对记录，不要重复发送。"); }
        const restored = await controller.restore(result.conversationId);
        setCurrent(restored.conversation); setMessages(restored.messages); setRecoveryId(null);
        setSessions(await controller.list());
      }
      setPanel(""); setNotice(controller.replyNotice??(original&&original.kind!=="create"&&original.reply?"消息已保存。助手回复在对话中呈现；执行工具仍需另行授权。":"说明已保存。请在对话中确认范围后启动调查。"));
    } catch { setError(controller.pending ? "请求尚未核对成功。原命令已保留，请点击“核对原请求”；不要重新创建或重复发送。" : "请求回执已保存，但视图刷新失败。请重新读取会话。"); }
    finally { setBusy(false); }
  }
  const disabled = busy || composerBusy || !controller || !!controller.pending;
  const send = (reply=false) => { if (draft.trim() && !disabled) void execute(current ? { kind: "send", commandId: crypto.randomUUID(), conversationId: current.id, text: draft,reply } : {kind:"start",commandId:crypto.randomUUID(),messageCommandId:crypto.randomUUID(),title:Array.from(draft.trim().split("\n")[0]!).slice(0,60).join(""),text:draft,reply}); };
  return <div className="workbench host-workbench">
    <a className="skip-link" href="#dialogue">跳到对话</a>
    <header className="topbar"><span className="brand">TraceForge</span><h1 className="host-title">{current?.title ?? "新会话"}</h1>
      <div className="host-header-actions">{busy && <span role="status">正在核对…</span>}
        <button className="icon-button" aria-label="新建对话" title="新建对话 · ⌘⇧N" disabled={disabled||configurationDirty} onClick={newConversation}><ChatCircle aria-hidden="true" /></button>
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
      <ConversationViewport identity={`${current?.id??"new"}:${panel}`} follow={!panel}>
        {panel ? <section className="host-panel">{(!(panel === "tasks" || panel === "evidence") || !current) && <h2>{({ sessions: "会话记录", tasks: "任务", evidence: "证据", settings: "设置" } as Record<string, string>)[panel]}</h2>}
          {panel === "sessions" ? <><div className="host-session-actions"><button disabled={disabled} onClick={newConversation}>新建会话</button><button disabled={busy || !controller} onClick={() => void load()}>重新读取</button></div><label className="host-session-search">查找会话<input type="search" autoFocus value={search} onChange={event=>setSearch(event.target.value)} placeholder="搜索会话标题" /></label>{!sessions.length && !busy && <p>还没有会话。直接写下你的调查目标即可开始。</p>}<ul className="host-session-list">{sessions.filter(session=>session.title.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map(session => <li key={session.id}><button disabled={disabled} onClick={() => void select(session.id)}><span>{session.title}</span><small>{session.createdAt.slice(0, 10)}</small></button></li>)}</ul>{sessions.length>0&&!sessions.some(session=>session.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()))&&<p>没有匹配的会话。试试其他关键词。</p>}</> : panel === "settings" ? <WorkbenchSettings bridge={bridge} modelBridge={modelBridge} onDirty={setConfigurationDirty} /> : !current ? <p>发送调查目标后，这里会展示对应任务和证据。</p> : null}
          {(panel === "tasks" || panel === "evidence") && current && <ExecutionPanel key={current.id} bridge={bridge} conversationId={current.id} messages={messages} evidenceOnly={panel === "evidence"} />}
          <button onClick={() => setPanel("")}>返回对话</button>
        </section> : <>{!messages.length && <div className="host-empty"><h2>{current ? "记录你的调查意图" : "这次想调查什么？"}</h2><p>写下目标，我们会先确认授权范围，再开始调查。工具活动和证据会随进展呈现。</p><div className="host-welcome-actions"><button onClick={()=>{setPanel("settings");}}>配置模型与工具</button>{sessions.length>0&&<button onClick={() => setPanel("sessions")}>继续已有会话</button>}</div></div>}{current && <ConversationExecution key={current.id} bridge={bridge} conversationId={current.id} messages={messages} onRuns={setRuns}/>}</>}
      </ConversationViewport>
      <div className="composer-area"><div role="status" className="live-notice">{notice}</div>{error && <p role="alert" className="inline-warning">{error}</p>}{controller?.pending && <button disabled={busy} onClick={() => void execute()}>核对原请求</button>}
        {draftError&&<p role="alert" className="inline-warning">{draftError}</p>}
        {error&&!controller?.pending&&<button disabled={busy} onClick={()=>recoveryId||current?void select(recoveryId??current!.id):void load()}>重新连接并读取</button>}
        {panel !== "settings" && <ConversationComposer key={current?.id??"new"} bridge={bridge} conversationId={current?.id} runs={panel?null:runs} draft={draft} onChange={editDraft} onNewMessage={send} onSettings={()=>setPanel("settings")} disabled={busy||!controller||!!controller.pending} onBusy={setComposerBusy} inputRef={input}/>}
      </div>
    </section></main>
  </div>;
}
