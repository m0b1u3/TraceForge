import { useEffect, useReducer, useRef, useState } from "react";
import type { ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ArrowUpRight, ArrowUp, ChatCircle, CheckSquare, Clock, Cube, FolderSimple,
  GearSix, Paperclip, ShieldWarning, SidebarSimple, User, X, ArrowCounterClockwise, CaretRight } from "@phosphor-icons/react";
import { initialState, MAX_MESSAGES, MAX_MESSAGE_LENGTH, previewReducer, restorePreview, savePreview, shouldSendOnEnter, STORAGE_KEY } from "./preview-state";
import type { Panel } from "./preview-state";
import { ModelSettings } from "./model-settings";

type Modal = "approval" | "settings" | "reset" | null;
const decisionLabels = { pending: "等待确认", approved: "已模拟确认", declined: "已暂缓" };

function Message({ who, time, children }: { who: "user" | "agent"; time?: string; children: ReactNode }) {
  return <article className={`message message-${who}`}>
    <div className={`avatar ${who}`} aria-hidden="true">{who === "user" ? <User weight="fill" /> : <Cube weight="fill" />}</div>
    <div className="message-body"><div className="sender"><span>{who === "user" ? "你" : "TraceForge"}</span>{time && <span className="message-time">{time}</span>}</div>{children}</div>
  </article>;
}

export function Workbench() {
  const [restored] = useState(() => {
    try {
      const result = restorePreview(window.sessionStorage);
      if (!window.sessionStorage.getItem(STORAGE_KEY) && window.matchMedia("(max-width: 900px)").matches) result.state.panel = null;
      return result;
    }
    catch { return { state: initialState(), warning: "预览存储不可用；本页输入仅在当前页面保留。" }; }
  });
  const [state, dispatch] = useReducer(previewReducer, restored.state);
  const [storageWarning, setStorageWarning] = useState(restored.warning);
  const [modal, setModal] = useState<Modal>(null);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [compact, setCompact] = useState(() => window.matchMedia("(max-width: 1350px)").matches);
  const [trackOpen, setTrackOpen] = useState(false);
  const timelineVisible = compact ? trackOpen : state.timeline;
  const input = useRef<HTMLTextAreaElement>(null);
  const conversation = useRef<HTMLDivElement>(null);
  const panelTrigger = useRef<HTMLButtonElement>(null);
  const modalTrigger = useRef<HTMLElement | null>(null);
  const source = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 1350px)");
    const change = () => { setCompact(media.matches); setTrackOpen(false); };
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);

  useEffect(() => {
    try { const warning = savePreview(window.sessionStorage, state); if (warning) setStorageWarning(warning); }
    catch { setStorageWarning("预览存储不可用；本页输入仅在当前页面保留。"); }
  }, [state]);
  useEffect(() => {
    if (state.messages.length) conversation.current?.scrollTo({ top: conversation.current.scrollHeight });
  }, [state.messages.length]);
  function openModal(next: Modal) {
    modalTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setModal(next);
  }
  function showPanel(panel: Panel) {
    setTrackOpen(false);
    dispatch({ type: "panel", panel });
    if (panel && window.matchMedia("(max-width: 900px)").matches) requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(".inspector-heading button")?.focus());
  }
  function closePanel() { showPanel(null); panelTrigger.current?.focus(); }
  function showSource() {
    showPanel("evidence"); setSourceOpen(true);
    requestAnimationFrame(() => source.current?.querySelector("summary")?.focus());
  }
  function send() {
    if (!state.draft.trim() || state.messages.length >= MAX_MESSAGES) return;
    dispatch({ type: "send" });
    setNotice("已添加到本页预览，未发送给模型。没有执行调查。 ");
    input.current?.focus();
  }

  return <div className="workbench">
    <a className="skip-link" href="#dialogue">跳到对话</a>
    <header className="topbar">
      <span className="brand">TraceForge</span>
      <span className="preview-badge">设计预览<span> · 演示数据</span> · 未连接模型</span>
      <div className="header-actions">
        <button ref={panelTrigger} aria-label="任务与证据" aria-expanded={state.panel !== null} aria-controls="inspector" onClick={() => state.panel ? closePanel() : showPanel("evidence")}><SidebarSimple /><span>任务与证据</span></button>
        <button className="icon-button" aria-label={timelineVisible ? "收起行动时间线" : "展开行动时间线"} aria-pressed={timelineVisible} onClick={() => {
          if (compact) { dispatch({ type: "panel", panel: null }); setTrackOpen(!trackOpen); }
          else dispatch({ type: "timeline" });
        }}><Clock /></button>
      </div>
    </header>
    <nav className="rail" aria-label="工作台导航">
      <button className="nav-button selected" aria-current="page" onClick={() => { if (compact) showPanel(null); requestAnimationFrame(() => input.current?.focus()); }}><ChatCircle /><span>对话</span></button>
      <button className={`nav-button ${state.panel === "tasks" ? "panel-selected" : ""}`} aria-pressed={state.panel === "tasks"} onClick={() => showPanel("tasks")}><CheckSquare /><span>任务</span></button>
      <button className={`nav-button ${state.panel === "evidence" ? "panel-selected" : ""}`} aria-pressed={state.panel === "evidence"} onClick={() => showPanel("evidence")}><FolderSimple /><span>证据</span></button>
      <button className="nav-button" onClick={() => openModal("settings")}><GearSix /><span>设置</span></button>
    </nav>

    <main className={`workspace ${state.panel ? "with-panel" : ""} ${timelineVisible ? "with-timeline" : ""}`}>
      <section className="dialogue" id="dialogue" aria-label="调查对话" tabIndex={-1}>
        <div className="conversation-heading"><h1>授权调查</h1><span className="subtitle">当前会话</span><span className={`status ${state.decision === "pending" ? "pending" : ""}`}>{decisionLabels[state.decision]}</span></div>
        <div className="conversation-scroll" ref={conversation}>
          <div className="transcript">
            <Message who="user" time="10:12"><p>请整理现有观察，先给出验证计划。</p></Message>
            <Message who="agent" time="10:13">
              <p>已整理现有材料。下面是建议的验证顺序，尚未执行。</p>
              <ol className="plan">
                <li><span className="step-number">1</span><div><strong>核对观察来源</strong><p>确认观察的原始来源与采集上下文。</p></div><button className="reference" onClick={showSource}>观察 01<CaretRight /></button></li>
                <li><span className="step-number">2</span><div><strong>比较候选解释</strong><p>对比替代解释与现有依据。</p></div><button className="reference" onClick={() => showPanel("tasks")}>任务 02<CaretRight /></button></li>
              </ol>
            </Message>
            <Message who="user" time="10:14"><p>先查看第一条观察的依据。</p></Message>
            <Message who="agent" time="10:15">
              <p>可以查看来源记录。它仍是待验证的观察，不代表已确认发现。</p>
              <div className="approval-strip">
                <ShieldWarning className="approval-icon" />
                <div><strong>{state.decision === "pending" ? "需要你确认" : decisionLabels[state.decision]}</strong><p>{state.decision === "pending" ? "预览审批流程，不会执行操作" : "仅改变本页示例，未批准真实执行"}</p></div>
                {state.decision === "pending" && <div className="approval-actions"><button onClick={() => { dispatch({ type: "decide", decision: "declined" }); setNotice("已暂缓示例操作，未向宿主发送请求。"); }}>暂不执行</button><button className="primary" onClick={() => openModal("approval")}>查看并确认</button></div>}
              </div>
            </Message>
            {state.messages.map((message, index) => <Message key={index} who="user"><p className="user-text">{message}</p><small className="local-receipt">仅保存在本页预览 · 未送达模型</small></Message>)}
          </div>
        </div>
        <div className="composer-area">
          {storageWarning && <div className="inline-warning" role="alert">{storageWarning}<button aria-label="关闭存储提示" onClick={() => setStorageWarning(null)}><X /></button></div>}
          <p className="live-notice" role="status">{notice}</p>
          <form className="composer" onSubmit={event => { event.preventDefault(); send(); }}>
            <span className="attachment-unavailable" title="附件读取尚未接通"><Paperclip aria-label="附件读取尚未接通" /></span>
            <textarea ref={input} aria-label="补充调查目标或说明（仅本页预览）" placeholder="补充调查目标或说明…" value={state.draft} maxLength={MAX_MESSAGE_LENGTH} rows={2}
              onChange={event => dispatch({ type: "draft", value: event.target.value })}
              onKeyDown={event => { if (shouldSendOnEnter({ key: event.key, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing, keyCode: event.keyCode })) { event.preventDefault(); send(); } }} />
            <button className="send primary icon-button" aria-label="添加到预览对话" type="submit" disabled={!state.draft.trim() || state.messages.length >= MAX_MESSAGES}><ArrowUp weight="bold" /></button>
            <div className="composer-footnote"><span>{state.messages.length >= MAX_MESSAGES ? "预览已满，请在设置中重置" : state.draft.length ? `${state.draft.length} / ${MAX_MESSAGE_LENGTH}` : "仅本页预览"}</span><span>Enter 发送 · Shift Enter 换行</span></div>
          </form>
        </div>
      </section>

      {state.panel && <aside className="inspector" id="inspector" aria-label="任务与证据" onKeyDown={event => { if (event.key === "Escape") closePanel(); }}>
        <div className="inspector-heading"><h2>任务与证据</h2><button className="icon-button" aria-label="收起任务与证据" onClick={closePanel}><X /></button></div>
        <div className="tabs" aria-label="侧栏内容"><button aria-pressed={state.panel === "evidence"} onClick={() => showPanel("evidence")}>证据</button><button aria-pressed={state.panel === "tasks"} onClick={() => showPanel("tasks")}>任务</button></div>
        <div className="inspector-content">
          {state.panel === "evidence" ? <>
            <div className="evidence-heading"><h3>观察 01</h3><span className="status">待验证</span></div>
            <details ref={source} open={sourceOpen} onToggle={event => setSourceOpen(event.currentTarget.open)}><summary>来源记录<CaretRight /></summary><div className="detail-body"><p>此记录为界面示例，没有关联真实文件、目标或网络请求。</p><dl><dt>来源类型</dt><dd>合成演示材料</dd><dt>采集时间</dt><dd>未提供</dd><dt>证据状态</dt><dd>未验证</dd></dl></div></details>
            <details open><summary>支持与限制<CaretRight /></summary><div className="detail-body"><p>当前材料仅支持继续调查。<br />需要可复现的验证与影响说明。</p><code>ref: observation-01</code><button className="source-button" onClick={showSource}>查看来源<ArrowUpRight /></button></div></details>
          </> : <>
            <div className="evidence-heading"><h3>验证计划</h3><span className="status">未执行</span></div>
            <ol className="task-list"><li><span className="step-number">1</span><div><h3>核对观察来源</h3><p>检查来源、采集上下文及依据是否充分。</p><button className="text-button" onClick={showSource}>查看观察 01<ArrowUpRight /></button></div></li><li><span className="step-number">2</span><div><h3>比较候选解释</h3><p>先完成来源核对，再确定验证方式。一次只推进一个验证任务。</p><span className="status">等待前置步骤</span></div></li></ol>
            <p className="panel-note">这里展示计划，不代表任务正在运行。预览中的确认不会启动执行。</p>
          </>}
        </div>
      </aside>}
      {timelineVisible && <aside className="timeline" aria-label="行动时间线"><h2><Clock />行动时间线</h2><ol>
        {[['00:00', '整理材料'], ['00:12', '引用观察'], ['00:24', '等待确认']].map(([time, title]) => <li key={time}><span className="track-dot" /><time>{time}</time><p>{title}</p><span className="duration-bar" aria-hidden="true" /></li>)}
        {state.decision !== "pending" && <li className="local-event"><span className="track-dot" /><span>本页操作</span><p>{decisionLabels[state.decision]}</p></li>}
      </ol><p className="timeline-note">示例时间 · 非真实耗时</p></aside>}
    </main>

    <Dialog.Root open={modal !== null} onOpenChange={open => { if (!open) setModal(null); }}>
      <Dialog.Portal><Dialog.Overlay className="modal-overlay" /><Dialog.Content className={`modal ${modal === "settings" ? "settings-modal" : ""}`} onCloseAutoFocus={event => { event.preventDefault(); (modalTrigger.current?.isConnected ? modalTrigger.current : input.current)?.focus(); }}>
        <Dialog.Title>{modal === "approval" ? "确认示例操作" : modal === "reset" ? "重置本页预览？" : "工作台设置"}</Dialog.Title>
        <Dialog.Description>{modal === "approval" ? "这是审批交互演示。确认只更新本页状态，不会发送授权或启动任何工具。" : modal === "reset" ? "清除本页添加的对话、草稿与模拟决定，恢复初始示例。真实调查数据不受影响。" : "当前是独立的桌面界面预览，尚未连接宿主和模型。"}</Dialog.Description>
        <Dialog.Close className="icon-button modal-close" aria-label="关闭对话框"><X /></Dialog.Close>
        {modal === "approval" && <><dl className="review-fields"><dt>示例操作</dt><dd>核对观察来源</dd><dt>作用范围</dt><dd>合成示例 observation-01</dd><dt>真实执行</dt><dd>未连接 · 不会执行</dd></dl><div className="modal-actions"><Dialog.Close>返回核查</Dialog.Close><button className="primary" onClick={() => { dispatch({ type: "decide", decision: "approved" }); setModal(null); setNotice("已完成模拟确认。没有提交真实审批，也没有执行工具。"); }}>仅模拟确认</button></div></>}
        {modal === "settings" && <><ModelSettings /><div className="settings-row"><div><h3>预览记录</h3><p>草稿与演示决定只属于当前预览，不是宿主调查存档。</p></div></div><button className="reset-button" onClick={() => setModal("reset")}><ArrowCounterClockwise />重置预览</button></>}
        {modal === "reset" && <div className="modal-actions"><Dialog.Close>保留记录</Dialog.Close><button className="primary" onClick={() => { dispatch({ type: "reset" }); setSourceOpen(false); setNotice("已恢复初始示例。"); setModal(null); conversation.current?.scrollTo({ top: 0 }); }}>重置预览</button></div>}
      </Dialog.Content></Dialog.Portal>
    </Dialog.Root>
  </div>;
}
