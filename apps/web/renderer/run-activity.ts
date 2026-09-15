import type { ScenarioAgentEvent } from "@traceforge/shared/scenario-agent-events";
import type { ConversationRun } from "./conversation-execution";

/** Event identities, not the most recent log line, determine active operations. */
export class RunActivity {
  private active = new Map<string, ScenarioAgentEvent>();
  private notice = "等待下一步执行";
  apply(events: ScenarioAgentEvent[]) {
    for (const event of events) {
      if (event.method === "turn/started") this.notice = "正在准备下一步";
      if (event.method === "turn/completed") {
        for (const [key, pending] of this.active) if (pending.turnId === event.turnId) this.active.delete(key);
      }
      if (!("item" in event.params)) continue;
      const item = event.params.item, key = `${item.type}:${item.id}`;
      if (["inProgress", "pending", "waitingApproval", "queued"].includes(item.status)) {
        if (!this.active.has(key) && this.active.size >= 256) throw new Error("Active progress exceeds capacity");
        this.active.set(key, event);
      } else this.active.delete(key);
      if (item.type === "modelCall" && item.status === "timedOut") this.notice = "上次模型请求超时，等待后续处理";
      if (item.type === "modelCall" && item.status === "failed") this.notice = "上次模型请求失败，等待后续处理";
      if (item.type === "controlChange" && item.audit?.state === "unknown") this.notice = "执行结果尚未确认，不会自动重试";
    }
  }
  label(run?: ConversationRun): string {
    if (run?.status === "paused") return "已暂停，可补充信息；恢复后才会继续执行";
    if (run?.status === "completed") return "本次任务已完成";
    if (run?.status === "cancelled") return "本次任务已停止";
    if (run?.status === "failed") return "本次运行失败，请查看保存的进展和原因";
    if (run?.workItems.some(work => work.pendingApproval)) return "等待你确认操作";
    if (run?.workItems.some(work => work.continuation?.state === "budget_exhausted")) return "工作预算或失败次数已用尽，不能直接继续";
    if (run?.workItems.some(work => ["blocked", "failed"].includes(work.status))) return "有工作需要处理，请查看下方中断原因";
    const items = [...this.active.values()].flatMap(event => "item" in event.params ? [event.params.item] : []);
    if (items.some(item => item.type === "toolCall" && item.status === "inProgress")) return "工具正在运行，你可以随时停止任务";
    if (items.some(item => item.type === "modelCall" && item.status === "inProgress")) return "模型正在思考，等待本次决策";
    if (items.some(item => item.type === "modelAdmission" && item.status === "queued")) return "等待模型调用名额";
    return this.notice;
  }
}
