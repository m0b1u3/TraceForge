import React, { useEffect, useState } from "react";
import { DesktopReplyPageSchema, DesktopReplySchema, DesktopMemoryViewSchema, type DesktopReply } from "@traceforge/shared/desktop-replies";
import type { DesktopConversations } from "./desktop-conversation-transport";
import { useArtifactPreview } from "./artifact-preview";
import { MessageMarkdown } from "./message-markdown";

/** Cursor reads merge durable snapshots. Mounting, reconnecting and history reads never POST. */
export function useConversationReplies(bridge: DesktopConversations, conversationId: string) {
  const [replies, setReplies] = useState<Map<string, DesktopReply>>(new Map());
  const [error, setError] = useState(false), [ready, setReady] = useState(false), [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let alive = true, after = 0, timer: ReturnType<typeof setTimeout> | undefined;
    let paintTimer: ReturnType<typeof setTimeout> | undefined, frame: number | undefined;
    let inFlight = false, urgent = false, immediateScheduled = false;
    const snapshot = new Map<string, DesktopReply>();
    const pending: Array<{ conversationId: string; messageId: string; kind: "text" | "reasoning"; offset: number; delta: string }> = [];
    const publish = () => {
      clearTimeout(paintTimer); paintTimer = undefined;
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
      setReplies(new Map(snapshot));
    };
    const schedulePaint = () => {
      if (paintTimer !== undefined || frame !== undefined) return;
      paintTimer = setTimeout(() => {
        paintTimer = undefined;
        if (typeof requestAnimationFrame === "function") frame = requestAnimationFrame(() => { frame = undefined; if (alive) publish(); });
        else if (alive) publish();
      }, 32);
    };
    const applyDelta = (event: (typeof pending)[number]) => {
      const current = snapshot.get(event.messageId);
      if (!current || current.state !== "streaming") return false;
      const value = event.kind === "text" ? current.text : current.reasoning ?? "";
      if (event.offset > value.length) return false;
      const overlap = Math.min(value.length - event.offset, event.delta.length);
      if (value.slice(event.offset, event.offset + overlap) !== event.delta.slice(0, overlap)) return false;
      if (overlap === event.delta.length) return true;
      const appended = value + event.delta.slice(overlap);
      snapshot.set(event.messageId, event.kind === "text" ? { ...current, text: appended } : { ...current, reasoning: appended });
      schedulePaint();
      return true;
    };
    const reconcileSoon = () => {
      if (!alive) return;
      if (inFlight) { urgent = true; return; }
      if (immediateScheduled) return;
      clearTimeout(timer);
      immediateScheduled = true;
      timer = setTimeout(poll, 0);
    };
    const onDelta = (event: (typeof pending)[number]) => {
      if (!alive || event.conversationId !== conversationId || !event.delta) return;
      if (document.hidden) return;
      if (applyDelta(event)) return;
      const current = snapshot.get(event.messageId);
      if (current && current.state !== "streaming" && current.state !== "queued") return;
      if (pending.length >= 512) pending.length = 0;
      pending.push(event);
      reconcileSoon();
    };
    const unsubscribe = bridge.subscribeReplyDelta?.(onDelta);
    const onVisible = () => { if (!document.hidden) reconcileSoon(); };
    document.addEventListener("visibilitychange", onVisible);
    setReady(false);
    async function poll() {
      timer = undefined; inFlight = true; immediateScheduled = false;
      try {
        const response = await bridge.request({ path: `/api/desktop/conversations/${conversationId}/replies?after=${after}`, method: "GET" });
        if (!alive) return;
        if (response.status !== 200) throw new Error();
        const page = DesktopReplyPageSchema.parse(response.body);
        if (page.conversationId !== conversationId || page.nextAfter !== (page.replies.at(-1)?.revision ?? after) || page.hasMore && !page.replies.length) throw new Error();
        let cursor = after;
        for (const item of page.replies) {
          if (item.conversationId !== conversationId || item.revision <= cursor) throw new Error();
          cursor = item.revision;
        }
        let changed = false;
        for (const item of page.replies) {
          const live = snapshot.get(item.messageCommandId);
          const useLive = live?.state === "streaming" && item.state === "streaming";
          snapshot.set(item.messageCommandId, useLive ? { ...item,
            text: live.text.length > item.text.length && live.text.startsWith(item.text) ? live.text : item.text,
            reasoning: (live.reasoning ?? "").length > (item.reasoning ?? "").length &&
              (live.reasoning ?? "").startsWith(item.reasoning ?? "") ? live.reasoning : item.reasoning,
          } : item);
          changed = true;
        }
        if (snapshot.size > 2000) throw new Error();
        after = cursor;
        for (let i = 0; i < pending.length;) {
          const event = pending[i]!;
          const state = snapshot.get(event.messageId)?.state;
          if ((state && state !== "streaming" && state !== "queued") || applyDelta(event)) { pending.splice(i, 1); changed = true; }
          else i++;
        }
        if (changed) publish();
        setReady(!page.hasMore); setError(false);
        timer = setTimeout(poll, page.hasMore ? 0 : document.hidden ? 5000 : pending.length ? 100 :
          [...snapshot.values()].some(item => item.state === "streaming") ? bridge.subscribeReplyDelta ? 1000 : 250 : 2000);
      } catch { if (alive) { setError(true); timer = setTimeout(poll, 5000); } }
      finally {
        inFlight = false;
        if (alive && urgent) { urgent = false; clearTimeout(timer); timer = setTimeout(poll, 0); }
      }
    }
    void poll();
    return () => { alive = false; unsubscribe?.(); document.removeEventListener("visibilitychange", onVisible);
      clearTimeout(timer); clearTimeout(paintTimer); if (frame !== undefined) cancelAnimationFrame(frame); };
  }, [bridge, conversationId, refresh]);
  return { replies, error, ready, refresh: () => setRefresh(value => value + 1) };
}

const states: Record<DesktopReply["state"], string> = { queued: "等待接续", streaming: "正在回复", completed: "回复完成", stopped: "已停止", withdrawn: "消息未送达", cancelled: "旧记录：送达状态不明", interrupted: "回复中断", failed: "回复未完成" };
const phases = { compacting: "正在整理上下文", recalling: "正在查阅对话原文", recovering: "正在调整上下文", generating: "正在回复" };
export function ConversationReply({ bridge, conversationId, messageId, reply, ready, otherActive, refresh, hideStop=false }: {
  bridge: DesktopConversations; conversationId: string; messageId: string; reply?: DesktopReply; ready: boolean; otherActive: boolean; refresh(): void; hideStop?:boolean;
}) {
  const preview=useArtifactPreview();
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [memory, setMemory] = useState<Array<{ id: string; summary: string; user: string; assistant: string | null }> | null>(null);
  const [readingMemory, setReadingMemory] = useState(false);
  async function readMemory() {
    setReadingMemory(true); setError("");
    try {
      const response = await bridge.request({ path: `/api/desktop/conversations/${conversationId}/replies/${messageId}/memory`, method: "GET" });
      if (response.status !== 200) throw new Error();
      const value = DesktopMemoryViewSchema.parse(response.body);
      if (value.conversationId !== conversationId || value.messageId !== messageId) throw new Error();
      setMemory(value.entries);
    } catch { setError("无法读取历史摘要，原对话未被修改。可以重新读取。"); }
    finally { setReadingMemory(false); }
  }
  async function command(cancel = false) {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await bridge.request({ path: `/api/desktop/conversations/${conversationId}/replies/${messageId}${cancel ? "/cancel" : ""}`, method: "POST", body: "{}" });
      if (response.status === 503) { setError("模型尚未就绪或不支持流式回复。请在模型设置中检查连接，之后可再次请求；消息已保留。"); return; }
      if (response.status === 409) { setError("暂时无法开始回复：可能有其他回复仍在生成，或本地回复容量已满。请先核对已有回复；本条消息已保留。"); return; }
      if (![200, 202].includes(response.status)) throw new Error();
      const result = DesktopReplySchema.parse(response.body);
      if (result.conversationId !== conversationId || result.messageCommandId !== messageId || cancel && result.state === "streaming") throw new Error();
    } catch { setError("尚未确认请求结果。先重新读取状态；再次请求只会核对这条消息，不会重复生成。"); }
    finally { setBusy(false); refresh(); }
  }
  if (!reply) return <div className="reply-actions">
    <button disabled={!ready || busy} onClick={() => void command()}>{busy ? "正在核对回复…" : otherActive ? "加入待处理消息" : "请求助手回复"}</button>
    <small className="local-receipt">使用已配置模型 · 执行前核对授权范围</small>
    {error && <p role="alert">{error}</p>}
  </div>;
  if (reply.state === "queued") return <article className="message message-assistant conversation-reply" aria-label="待处理消息">
    <div className="message-body"><span role="status">消息已排队，将在当前回复结束后接着处理。</span>
      <div className="reply-actions"><button disabled={busy} onClick={() => void command(true)}>{busy ? "正在撤回…" : "撤回排队"}</button></div>
      {error && <p role="alert">{error}</p>}
    </div>
  </article>;
  if (reply.state === "withdrawn") return <article className="message message-assistant conversation-reply" aria-label="未送达消息">
    <div className="message-body"><span role="status">{reply.error === "host_stopped" ? "本机关闭时，这条排队消息尚未送达模型。" : reply.error === "provider_failed" ? "这条排队消息未能送达模型。请核对模型设置或缩短消息后重新发送。" : "这条排队消息已撤回，未送达模型。"}</span></div>
  </article>;
  return <article className="message message-assistant conversation-reply" aria-label="助手回复">
    <div className="message-body"><div className="sender">TraceForge <span className="run-state" role="status">{reply.state === "streaming" ? phases[reply.phase ?? "generating"] : states[reply.state]}</span></div>
      {reply.reasoning && <ReasoningText text={reply.reasoning} active={reply.state === "streaming" && !reply.text} truncated={reply.reasoningTruncated} />}
      {!!reply.toolActivity?.length && <details className="reply-tool-activity"><summary>工具活动 · {reply.toolActivity.length} 次调用</summary>{reply.toolActivity.map(tool => <details className="execution-trace-entry" key={tool.ordinal}>
        <summary>{tool.tool} · {tool.outcome === "failed" ? "未成功" : "已返回"}</summary><div className="trace-content">
          <small>调用参数</small><pre tabIndex={0}>{tool.input}</pre>
          <small>返回内容 · 有界预览</small><pre tabIndex={0}>{tool.output}</pre>
          {preview&&<button onClick={()=>preview.open({kind:"text",conversationId,title:`${tool.tool} · 输出`,sourceId:`${messageId}:${tool.ordinal}`,text:tool.output})}>在侧栏查看输出</button>}
        </div>
      </details>)}</details>}
      {reply.toolActivity?.some(tool => tool.outcome === "failed") && <p className="inline-warning">本轮有工具未成功，请展开核对返回内容；助手文字不代表该操作已完成。</p>}
      {reply.text ? <MessageMarkdown text={reply.text} /> : <p className="local-receipt">{reply.state === "streaming" ? reply.phase === "compacting" ? "正在整理较早的对话，原文仍保留。你可以随时停止。" : reply.phase === "recalling" ? "正在从已保存的对话中查找细节，不会执行外部操作。" : reply.phase === "recovering" ? "模型未接受刚才的上下文，正在缩减历史后重试一次。" : "正在等待模型输出…" : "没有收到可保留的正文。"}</p>}
      {reply.state !== "streaming" && reply.state !== "completed" && <p className="reply-explanation">{reply.error === "attachment_input" ? "附件未发送：请在模型设置确认对应输入能力，并检查文件格式；音频仅接通 Chat Completions。" : reply.error === "context_limit" ? "上下文仍超出模型可接受的范围。请检查模型窗口配置，或缩短本条消息后继续。" : reply.error === "recall_limit" ? "本次对话回读已达到上限，请缩小要查找的细节范围后继续。" : reply.error === "storage_limit" ? "本机回复存储空间已达到容量限制，已保留收到的内容；这不是模型输出额度。" : reply.error === "output_limit" ? "供应商报告本次输出达到上限。" : reply.error === "timeout" ? "模型响应超时。" : reply.state === "stopped" ? "你已停止这次回复。" : reply.state === "cancelled" ? "旧记录无法确认用户消息是否已送达模型。" : "这次回复没有正常完成。"}已收到的文字仍保留；不会自动续写或重试。需要继续时，请发送一条新消息。</p>}
      {!!reply.originalReadCount && <small className="local-receipt">本次已查阅历史原文 {reply.originalReadCount} 段</small>}
      {!!reply.recoveryAttempts && reply.state !== "streaming" && <small className="local-receipt">本次曾缩减上下文后重试一次</small>}
      {(reply.contextTruncated || !!reply.recallCount) && <details className="reply-memory-details"><summary>上下文与历史</summary><p>{reply.contextTruncated ? "较早对话未完整放入上下文；可用的历史摘要不替代原文。" : "检索结果与记忆笔记不等于完整读取原文。"}</p>
        <button disabled={readingMemory} onClick={() => void readMemory()}>{readingMemory ? "读取中…" : "查看历史摘要与原文"}</button>
        {memory && (memory.length ? memory.map(entry => <details key={entry.id}><summary>{entry.summary}</summary><div className="reply-text">用户：{entry.user}</div>{entry.assistant && <div className="reply-text">助手：{entry.assistant}</div>}</details>) : <p>本次没有可用的历史摘要，原始消息仍保存在对话中。</p>)}
      </details>}
      <div className="reply-actions">
        {reply.state === "streaming" && !hideStop && <button disabled={busy} onClick={() => void command(true)}>{busy ? "正在核对停止…" : "停止回复"}</button>}
        {reply.text && <button onClick={() => void navigator.clipboard.writeText(reply.text).then(() => setNotice("回复已复制。"), () => setError("复制未成功，请选择正文手动复制。"))}>复制回复</button>}
        <small className="local-receipt">{reply.state === "completed" ? "已保存到本机 · 不代表已验证的调查结论" : reply.state === "streaming" ? "正在接收 · 定期保存到本机" : "已接收文字保存在本机"}</small>
      </div>
      {error && <p role="alert">{error}</p>}{notice && <p role="status" className="local-receipt">{notice}</p>}
    </div>
  </article>;
}
import { ReasoningText } from "./execution-trace";
