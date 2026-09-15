import { DesktopExecutionReceiptSchema, parseDesktopExecutionOperation, type DesktopExecutionReceipt } from "@traceforge/shared/desktop-execution";
import type { DesktopConversations } from "./desktop-conversation-transport";
import { readExecutionJournal, type ExecutionOperation } from "./execution-journal";

type StoragePort = Pick<Storage, "getItem" | "setItem" | "removeItem">;
// Component remounts share the same storage object. UI state is not a dispatch lock.
const locks = new WeakMap<object, Set<string>>();
export class ExecutionController {
  constructor(private readonly bridge: DesktopConversations, private readonly storage: StoragePort, private readonly conversationId: string) {}
  get pending() { return readExecutionJournal(this.storage, this.conversationId); }
  async execute(command?: ExecutionOperation): Promise<DesktopExecutionReceipt> {
    let active = locks.get(this.storage); if (!active) { active = new Set(); locks.set(this.storage, active); }
    if (active.has(this.conversationId)) throw new Error("上一条操作仍在核对，请稍后使用原请求核对。");
    const existing = this.pending;
    const next = command ? parseDesktopExecutionOperation(command, this.conversationId) : existing;
    if (!next) throw new Error("没有待核对的执行命令。");
    if (existing && JSON.stringify(existing) !== JSON.stringify(next)) throw new Error("先核对原请求，不能用新命令替换未知结果。");
    active.add(this.conversationId);
    const key = `traceforge.execution.${this.conversationId}`;
    try {
      // Storage failure must precede and prevent any external operation.
      this.storage.setItem(key, JSON.stringify(next));
      let response: Awaited<ReturnType<DesktopConversations["request"]>>;
      try { response = await this.bridge.request({ path: next.path, method: "POST", body: JSON.stringify(next.body) }); }
      catch { throw new Error("连接中断，操作结果未知。请核对原请求；不会自动重复执行。"); }
      const value = response.body as { desktopReceipt?: unknown; error?: unknown; runId?: unknown } | null;
      if ([400, 401, 403, 404, 409, 422].includes(response.status) && value && typeof value.error === "string") {
        this.storage.removeItem(key);
        throw new Error("宿主明确拒绝了操作。请核对授权、模型和任务状态后重新确认。");
      }
      const parsed = DesktopExecutionReceiptSchema.safeParse(value?.desktopReceipt);
      const operation = next.path.endsWith("/authorize") ? "authorize" : next.path.endsWith("/cancel") ? "cancel"
        : next.path.endsWith("/pause") ? "pause" : next.path.endsWith("/resume") ? "resume" : next.path.endsWith("/continue") ? "continue"
        : next.path.endsWith("/approval") ? "approval" : next.path.endsWith("/input") ? "input" : "dispatch";
      if (![200, 201].includes(response.status) || !parsed.success || parsed.data.conversationId !== this.conversationId
        || parsed.data.commandId !== next.body.commandId || parsed.data.operation !== operation
        || (operation === "authorize" && parsed.data.resourceId !== next.body.commandId)
        || (["cancel","pause","resume"].includes(operation) && parsed.data.resourceId !== next.body.runId)
        || (operation === "approval" && parsed.data.resourceId !== next.body.approvalId)
        || (operation === "input" && parsed.data.resourceId !== next.body.commandId)
        || (operation === "continue" && parsed.data.resourceId !== next.body.workId)
        || (operation === "dispatch" && parsed.data.resourceId !== value?.runId)) {
        throw new Error("宿主回执未核对成功，结果未知。请核对原请求；不会自动重复执行。");
      }
      this.storage.removeItem(key);
      if(typeof window!=="undefined")window.dispatchEvent(new CustomEvent("traceforge:execution-updated",{detail:this.conversationId}));
      return parsed.data;
    } finally { active.delete(this.conversationId); }
  }
}
