import React, { useEffect, useState } from "react";
import { DesktopReplyPageSchema, DesktopReplySchema, type DesktopReply } from "@traceforge/shared/desktop-replies";
import type { DesktopConversations } from "./desktop-conversation-transport";

/** Cursor reads merge durable snapshots. Mounting, reconnecting and history reads never POST. */
export function useConversationReplies(bridge: DesktopConversations, conversationId: string) {
  const [replies, setReplies] = useState<Map<string, DesktopReply>>(new Map());
  const [error, setError] = useState(false), [ready, setReady] = useState(false), [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let alive = true, after = 0, timer: ReturnType<typeof setTimeout> | undefined;
    const snapshot = new Map<string, DesktopReply>();
    setReady(false);
    async function poll() {
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
        for (const item of page.replies) snapshot.set(item.messageCommandId, item);
        if (snapshot.size > 2000) throw new Error();
        after = cursor;
        setReplies(new Map(snapshot)); setReady(!page.hasMore); setError(false);
        timer = setTimeout(poll, page.hasMore ? 0 : document.hidden ? 5000 : [...snapshot.values()].some(item => item.state === "streaming") ? 250 : 2000);
      } catch { if (alive) { setError(true); timer = setTimeout(poll, 5000); } }
    }
    void poll();
    return () => { alive = false; clearTimeout(timer); };
  }, [bridge, conversationId, refresh]);
  return { replies, error, ready, refresh: () => setRefresh(value => value + 1) };
}

const states: Record<DesktopReply["state"], string> = { streaming: "正在回复", completed: "回复完成", cancelled: "已停止", interrupted: "回复中断", failed: "回复未完成" };
export function ConversationReply({ bridge, conversationId, messageId, reply, ready, otherActive, refresh }: {
  bridge: DesktopConversations; conversationId: string; messageId: string; reply?: DesktopReply; ready: boolean; otherActive: boolean; refresh(): void;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
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
    <button disabled={!ready || busy || otherActive} onClick={() => void command()}>{busy ? "正在核对回复…" : "请求助手回复"}</button>
    <small className="local-receipt">使用已配置模型，不执行工具</small>
    {error && <p role="alert">{error}</p>}
  </div>;
  return <article className="message message-assistant conversation-reply" aria-label="助手回复">
    <div className="message-body"><div className="sender">TraceForge <span className="run-state" role="status">{states[reply.state]}</span></div>
      {reply.text ? <div className="reply-text" dir="auto">{reply.text}</div> : <p className="local-receipt">{reply.state === "streaming" ? "正在等待模型输出…" : "没有收到可保留的正文。"}</p>}
      {reply.state !== "streaming" && reply.state !== "completed" && <p className="reply-explanation">{reply.error === "output_limit" ? "回复达到长度上限。" : reply.error === "timeout" ? "模型响应超时。" : reply.state === "cancelled" ? "你已停止这次回复。" : "这次回复没有正常完成。"}已收到的文字仍保留；不会自动续写或重试。需要继续时，请发送一条新消息。</p>}
      {reply.contextTruncated && <p className="local-receipt">本次仅使用最近一段对话，较早消息未发送给模型。</p>}
      <div className="reply-actions">
        {reply.state === "streaming" && <button disabled={busy} onClick={() => void command(true)}>{busy ? "正在核对停止…" : "停止回复"}</button>}
        {reply.text && <button onClick={() => void navigator.clipboard.writeText(reply.text).then(() => setNotice("回复已复制。"), () => setError("复制未成功，请选择正文手动复制。"))}>复制回复</button>}
        <small className="local-receipt">{reply.state === "completed" ? "已保存到本机 · 不代表已验证的调查结论" : "已接收文字保存在本机"}</small>
      </div>
      {error && <p role="alert">{error}</p>}{notice && <p role="status" className="local-receipt">{notice}</p>}
    </div>
  </article>;
}
