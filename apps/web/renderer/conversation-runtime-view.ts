import type {DesktopReply} from "@traceforge/shared/desktop-replies";
import type {ConversationRun} from "./conversation-execution";

/** Read-only projection; server replies and Runs remain the sole authorities. */
export function conversationRuntimeView(replies:Iterable<DesktopReply>,runs:ConversationRun[]|null,ready:boolean,error:boolean){
  const list=[...replies],active=list.find(r=>r.state==="streaming"),queued=list.filter(r=>r.state==="queued").length;
  const running=(runs??[]).filter(r=>["running","paused"].includes(r.status));
  const waiting=running.some(r=>r.workItems.some(w=>w.pendingApproval));
  return {activeMessageId:active?.messageCommandId,queued,ready:ready&&!error,
    label:error?"连接暂时中断 · 已有内容保留":!ready?"正在同步会话":waiting?"等待操作确认":active?active.phase==="recalling"?"正在查阅资料":active.phase==="compacting"?"正在整理上下文":"智能体正在回复":running.some(r=>r.status==="running")?"任务执行中 · 可以继续补充":running.length?"任务已暂停 · 补充不会自动恢复":"可以继续对话",
    sendLabel:active?"发送并排队":"发送给助手"};
}

export function mergeRunSnapshots(previous:ConversationRun[],next:ConversationRun[]){
  return next.map(run=>{const old=previous.find(r=>r.runId===run.runId);return old&&old.revision>run.revision?old:run;});
}
