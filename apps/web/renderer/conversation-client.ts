import { DesktopReplySchema } from "@traceforge/shared/desktop-replies";
import type { MessageAttachment } from "@traceforge/shared/message-attachments";

/** Host-only transport injection. No provider calls, tokens, or UI demo fallback. */
export interface SavedConversation { id: string; caseId: string; title: string; createdAt: string }
export interface SavedMessage {
  attachmentNames?:string[];
  conversationId: string; commandId: string; sequence: number; text: string; createdAt: string;
  role: "user"; persistence: "saved"; delivery: "not_dispatched"; reason: "conversation_dispatch_not_connected";
}
export interface HostResponse { ok: boolean; status: number; json(): Promise<unknown> }
export type ConversationTransport = (path: string, init: { method: "GET" | "POST"; body?: string; signal?: AbortSignal }) => Promise<HostResponse>;

export class ConversationRequestError extends Error {
  constructor(public readonly outcome: "rejected" | "unknown" | "invalid_response", public readonly status?: number) {
    super(outcome === "unknown" ? "请求结果未知，请使用原命令重试核对。" : outcome === "invalid_response" ? "宿主回执不符合合同，不能标记成功。" : "宿主拒绝了请求。");
  }
}
const identifier = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function requireId(value: string) { if (!identifier(value)) throw new Error("Invalid conversation identifier"); return value; }
function conversation(value: unknown): SavedConversation {
  if (!record(value) || !identifier(value.id) || !identifier(value.caseId) || typeof value.title !== "string" || typeof value.createdAt !== "string") throw new ConversationRequestError("invalid_response");
  return { id: value.id, caseId: value.caseId, title: value.title, createdAt: value.createdAt };
}
function message(value: unknown, conversationId: string): SavedMessage {
  if (!record(value) || value.conversationId !== conversationId || !identifier(value.commandId) ||
      !Number.isSafeInteger(value.sequence) || (value.sequence as number) < 1 || typeof value.text !== "string" ||
      typeof value.createdAt !== "string" || value.role !== "user" || value.persistence !== "saved" ||
      value.delivery !== "not_dispatched" || value.reason !== "conversation_dispatch_not_connected") throw new ConversationRequestError("invalid_response");
  return value as unknown as SavedMessage;
}

export class ConversationClient {
  constructor(private readonly transport: ConversationTransport) {}
  private async request(path: string, method: "GET" | "POST", body?: unknown, signal?: AbortSignal): Promise<unknown> {
    let response: HostResponse;
    try { response = await this.transport(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal }); }
    catch { throw new ConversationRequestError("unknown"); }
    if (!response.ok) throw new ConversationRequestError(response.status >= 500 ? "unknown" : "rejected", response.status);
    try { return await response.json(); } catch { throw new ConversationRequestError("unknown", response.status); }
  }
  async create(commandId: string, title: string): Promise<SavedConversation> {
    return conversation(await this.request("/api/desktop/conversations", "POST", { commandId: requireId(commandId), title }));
  }
  async list(): Promise<SavedConversation[]> {
    const result = await this.request("/api/desktop/conversations", "GET");
    if (!record(result) || !Array.isArray(result.conversations) || result.conversations.length > 1000) throw new ConversationRequestError("invalid_response");
    return result.conversations.map(conversation);
  }
  async send(conversationId: string, commandId: string, text: string, attachments?:MessageAttachment[]): Promise<SavedMessage> {
    const result = message(await this.request(`/api/desktop/conversations/${requireId(conversationId)}/messages`, "POST", { commandId: requireId(commandId), text,...(attachments?.length?{attachments}:{}) }), conversationId);
    if (result.commandId !== commandId || result.text !== text) throw new ConversationRequestError("invalid_response");
    return result;
  }
  async requestReply(conversationId: string, messageId: string): Promise<string | undefined> {
    const response = await this.transport(`/api/desktop/conversations/${requireId(conversationId)}/replies/${requireId(messageId)}`, { method: "POST", body: JSON.stringify({}) });
    const body = await response.json();
    // These are explicit pre-inference refusals. The message stays saved and the
    // conversation offers a deliberate retry after configuration/capacity changes.
    if ([409, 503].includes(response.status) && record(body)) {
      const notices: Record<string, string> = { source_review_retired: "旧复核请求已保留，未重新调用模型。请直接在对话中说明需要查阅的内容。", reply_busy: "消息已保存，但另一条回复仍在生成。待它结束后，可点击“请求助手回复”。",
        reply_capacity_reached: "消息已保存，但本地回复容量已满，未调用模型。",
        streaming_model_unavailable: "消息已保存，模型尚未就绪或不支持流式回复。请检查模型设置，之后点击“请求助手回复”。" };
      if (notices[String(body.error)]) return notices[String(body.error)];
    }
    if (!response.ok) throw new ConversationRequestError("unknown", response.status);
    const reply = DesktopReplySchema.parse(body);
    if (reply.conversationId !== conversationId || reply.messageCommandId !== messageId) throw new ConversationRequestError("invalid_response");
  }
  async restore(conversationId: string, signal?: AbortSignal): Promise<{ conversation: SavedConversation; messages: SavedMessage[] }> {
    requireId(conversationId);
    const current = conversation(await this.request(`/api/desktop/conversations/${conversationId}`, "GET", undefined, signal));
    if (current.id !== conversationId) throw new ConversationRequestError("invalid_response");
    const messages: SavedMessage[] = []; const commands = new Set<string>(); let after = 0;
    for (let page = 0; page < 20; page++) {
      const response = await this.request(`/api/desktop/conversations/${conversationId}/messages?after=${after}&limit=100`, "GET", undefined, signal);
      if (!record(response) || response.conversationId !== conversationId || !Array.isArray(response.messages) || response.messages.length > 100 || typeof response.hasMore !== "boolean") throw new ConversationRequestError("invalid_response");
      for (const raw of response.messages) {
        const next = message(raw, conversationId);
        if (next.sequence !== after + 1 || commands.has(next.commandId)) throw new ConversationRequestError("invalid_response");
        commands.add(next.commandId); messages.push(next); after = next.sequence;
      }
      if (response.nextAfter !== after || (response.hasMore && response.messages.length === 0)) throw new ConversationRequestError("invalid_response");
      if (!response.hasMore) return { conversation: current, messages };
    }
    throw new ConversationRequestError("invalid_response");
  }
}
