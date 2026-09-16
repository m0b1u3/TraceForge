import { ConversationClient } from "./conversation-client";
import { MessageAttachmentsSchema, type MessageAttachment } from "@traceforge/shared/message-attachments";
import type { SavedConversation, SavedMessage } from "./conversation-client";

export type PendingCommand = ({ kind: "create"; commandId: string; title: string } | { kind: "send"; commandId: string; conversationId: string; text: string; reply?: boolean } | { kind: "start"; commandId: string; messageCommandId: string; title: string; text: string; reply?: boolean }) & {attachments?:MessageAttachment[]};
export interface JournalStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
const key = "traceforge.desktop.conversation-command.v1";
export class HostConversationController {
  pending: PendingCommand | null = null;
  busy = false;
  replyNotice: string | undefined;
  private retiredReviewNotice: string | undefined;
  constructor(private client: ConversationClient, private storage: JournalStorage) {
    const raw = storage.getItem(key);
    if (raw === null || raw === "null") return;
    if (raw.length > 3200000) throw new Error("本地待确认命令损坏，未发出请求。请保留记录后检查。");
    const value = JSON.parse(raw);
    if (!value || typeof value.commandId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(value.commandId) ||
      !(value.kind === "create" && typeof value.title === "string" && value.title.trim() && value.title.length <= 200 ||
        value.kind === "send" && typeof value.conversationId === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value.conversationId) && typeof value.text === "string" && value.text.trim() && value.text.length <= 16000 ||
        value.kind === "start" && typeof value.messageCommandId === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value.messageCommandId) && value.messageCommandId !== value.commandId && typeof value.title === "string" && value.title.trim() && value.title.length <= 200 && typeof value.text === "string" && value.text.trim() && value.text.length <= 16000)) throw new Error("本地待确认命令损坏，未发出请求。请保留记录后检查。");
    this.pending = value;
    // Preserve old messages without replaying a retired read-only intent with more tools.
    if (value.review !== undefined) {
      value.reply = false; delete value.review;
      this.retiredReviewNotice = "旧复核消息已保留，未重新调用模型。请直接在对话中说明需要查阅的内容。";
    }
    if(value.attachments!==undefined)MessageAttachmentsSchema.parse(value.attachments);
    if (value.reply !== undefined && (value.kind === "create" || typeof value.reply !== "boolean")) throw new Error("Invalid reply intent");
  }
  list() { return this.client.list(); }
  restore(id: string) { return this.client.restore(id); }
  async execute(command?: PendingCommand): Promise<SavedConversation | SavedMessage> {
    if (this.busy) throw new Error("正在核对上一条请求。");
    if (command && this.pending) throw new Error("先使用原命令核对上一条请求。");
    const next = command ?? this.pending;
    if (!next) throw new Error("没有待处理命令。");
    if ("review" in next) throw new Error("原文复核模式已移除，请在对话中直接提出要求。");
    // Write-ahead journal: refuse to send if the durable command cannot be retained.
    this.storage.setItem(key, JSON.stringify(next));
    this.pending = next; this.busy = true;
    try {
      // Both identities survive a crash between creation and the first message.
      // Reconciliation reuses the host's idempotent commands; it never starts a Run.
      const result = next.kind === "start"
        ? await this.client.send((await this.client.create(next.commandId, next.title)).id, next.messageCommandId, next.text,next.attachments)
        : next.kind === "create" ? await this.client.create(next.commandId, next.title) : await this.client.send(next.conversationId, next.commandId, next.text,next.attachments);
      this.replyNotice = this.retiredReviewNotice;
      if (next.kind !== "create" && next.reply && "conversationId" in result) this.replyNotice = await this.client.requestReply(result.conversationId, result.commandId);
      this.storage.setItem(key, "null");
      this.pending = null;
      this.retiredReviewNotice = undefined;
      return result;
    } finally { this.busy = false; }
  }
}
